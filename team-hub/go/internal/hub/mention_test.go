package hub

// mention_handle is the one name a comment may @. An email invite has to produce a
// mentionable member even though its github_username is a placeholder a mention
// cannot express, and display_name stays free text that takes no part in resolution.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// applyMigrationsExcept reaches the schema a deployment upgrades from: every
// migration but the named one, applied to an empty database.
func applyMigrationsExcept(t *testing.T, database *DB, skip string) {
	t.Helper()
	staged := t.TempDir()
	entries, err := os.ReadDir(migrationsDir(t))
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || entry.Name() == skip {
			continue
		}
		body, err := os.ReadFile(filepath.Join(migrationsDir(t), entry.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		if err := os.WriteFile(filepath.Join(staged, entry.Name()), body, 0o600); err != nil {
			t.Fatalf("stage %s: %v", entry.Name(), err)
		}
	}
	if _, _, err := ApplyMigrations(database, staged); err != nil {
		t.Fatalf("apply the migrations before %s: %v", skip, err)
	}
}

// storedMentionHandles reads one column of the members table, keyed by member id.
func storedMentionHandles(t *testing.T, database *DB) map[string]string {
	t.Helper()
	rows, err := database.Query("SELECT id, mention_handle FROM members")
	if err != nil {
		t.Fatalf("read mention handles: %v", err)
	}
	defer rows.Close()
	handles := map[string]string{}
	for rows.Next() {
		var id string
		var handle *string
		if err := rows.Scan(&id, &handle); err != nil {
			t.Fatalf("scan a mention handle: %v", err)
		}
		handles[id] = deref(handle)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read mention handles: %v", err)
	}
	return handles
}

// TestMentionHandleBackfill pins 0005's rules on the rows a hub already holds: a
// GitHub identity contributes its login, a bound member its display name, a name
// nothing survives folds to "member", and a repeated name counts up inside its own
// team only.
func TestMentionHandleBackfill(t *testing.T) {
	database, err := OpenDB(filepath.Join(t.TempDir(), "hub.sqlite"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	defer database.Close()
	applyMigrationsExcept(t, database, "0005_mention_handle.sql")

	for _, teamID := range []string{"team_backfill_a", "team_backfill_b"} {
		if _, err := database.Exec(
			"INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			teamID, teamID, teamID, 1, 1); err != nil {
			t.Fatalf("seed %s: %v", teamID, err)
		}
	}
	seed := []struct {
		teamID, memberID, githubUsername, displayName string
		githubUserID, createdAt                       int64
	}{
		{"team_backfill_a", "mem_backfill_github", "Octocat", "Octo Cat", 1001, 1},
		{"team_backfill_a", "mem_backfill_dana", "account:acct_dana", "Dana Lee", -2, 2},
		{"team_backfill_a", "mem_backfill_dana_two", "account:acct_dana_two", "dana lee", -3, 3},
		{"team_backfill_a", "mem_backfill_unnamed", "account:acct_unnamed", "  ***  ", -4, 4},
		{"team_backfill_a", "mem_backfill_suffixed", "account:acct_suffixed", "Dana Lee-2", -5, 5},
		{"team_backfill_b", "mem_backfill_elsewhere", "account:acct_elsewhere", "Dana Lee", -6, 6},
		{"team_backfill_b", "mem_backfill_github_dot", "Octo.Cat", "Octo Cat", 1002, 7},
	}
	for _, row := range seed {
		if _, err := database.Exec(
			"INSERT INTO members (id, team_id, github_user_id, github_username, display_name, "+
				"role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'member', 'active', ?, ?)",
			row.memberID, row.teamID, row.githubUserID, row.githubUsername, row.displayName,
			row.createdAt, row.createdAt); err != nil {
			t.Fatalf("seed %s: %v", row.memberID, err)
		}
	}

	if _, newly, err := ApplyMigrations(database, migrationsDir(t)); err != nil {
		t.Fatalf("apply 0005: %v", err)
	} else if len(newly) != 1 || newly[0] != "0005_mention_handle.sql" {
		t.Fatalf("the backfill migration was not the only one left: %v", newly)
	}

	wanted := map[string]string{
		"mem_backfill_github":    "octocat",
		"mem_backfill_dana":      "dana-lee",
		"mem_backfill_dana_two":  "dana-lee-2",
		"mem_backfill_unnamed":   "member",
		"mem_backfill_suffixed":  "dana-lee-2-2",
		"mem_backfill_elsewhere": "dana-lee",
		// A login folds the same way: the dot is not a mention character either.
		"mem_backfill_github_dot": "octo-cat",
	}
	handles := storedMentionHandles(t, database)
	for memberID, wantedHandle := range wanted {
		if handles[memberID] != wantedHandle {
			t.Fatalf("member %s holds %q, want %q (all: %v)",
				memberID, handles[memberID], wantedHandle, handles)
		}
	}

	// The uniqueness the handles above satisfy is the index, scoped to one team.
	var indexes int
	if err := database.QueryRow(
		"SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_members_mention_handle'").
		Scan(&indexes); err != nil {
		t.Fatalf("read the schema: %v", err)
	}
	if indexes != 1 {
		t.Fatalf("the mention handle index is missing: %d", indexes)
	}
}

// TestInviteDerivesTheMentionHandleFromTheAddress is the deployment the column exists
// for: GitHub login closed, every member invited by email, and the row still carries a
// name a comment can @.
func TestInviteDerivesTheMentionHandleFromTheAddress(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	const email = "mei.lin@example.test"
	server.fake.addAccountUser(email, "acct_mei_lin")

	invited := inviteRequest(server, team.teamID, team.admin.accessToken, email, "member")
	if invited.status != http.StatusCreated {
		t.Fatalf("invite: %d %s", invited.status, invited.text)
	}
	row, _ := invited.body["member"].(map[string]any)
	// The dot in the address is not a mention character, so the handle folds it.
	if handle := stringField(row, "mention_handle"); handle != "mei-lin" {
		t.Fatalf("the invite named the row %q, want mei-lin: %s", handle, invited.text)
	}
	// display_name stays the free text the address gave it.
	if name := stringField(row, "display_name"); name != "mei.lin" {
		t.Fatalf("the invite renamed the row %q", name)
	}
	// The placeholder stays where it was: a colon is not a mention character, and the
	// column is a legacy identity, not a second name.
	if username := stringField(row, "github_username"); !strings.HasPrefix(username, "account:") {
		t.Fatalf("the invite wrote a real github_username: %s", invited.text)
	}
	if stored, _ := one[string](server, "SELECT mention_handle FROM members WHERE id = ?",
		stringField(row, "id")); stored != "mei-lin" {
		t.Fatalf("the stored handle is %q", stored)
	}
}

// TestMentionByHandleReachesTheInvitedMember walks the path the bug report describes:
// an email-invited member, named by the handle the invite derived.
func TestMentionByHandleReachesTheInvitedMember(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	mentioned := server.inviteAndLogin(team.teamID, team.admin.accessToken, "dana")
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "thread"})

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@dana please look"}})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	inbox := server.api("GET", "/api/v1/teams/"+team.teamID+"/inbox", apiOptions{token: mentioned.accessToken})
	mentions, _ := inbox.body["mentions"].([]any)
	if inbox.status != http.StatusOK || len(mentions) != 1 {
		t.Fatalf("the invited member got %d mentions: %s", len(mentions), inbox.text)
	}
}

// TestMentionResolutionFoldsCase holds the handle to the case-insensitive match the
// unique index and the derivation both assume.
func TestMentionResolutionFoldsCase(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	mentioned := server.inviteAndLogin(team.teamID, team.admin.accessToken, "dana")
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "thread"})

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@DANA look"}})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	if mentions, _ := one[int](server, "SELECT COUNT(*) FROM comment_mentions WHERE target_member_id = ?",
		stringField(mentioned.member, "id")); mentions != 1 {
		t.Fatalf("an upper-case handle resolved %d times", mentions)
	}
}

// TestSecondMemberWithTheSameLocalPartGetsASuffix keeps two addresses that differ only
// in their domain apart on the roster.
func TestSecondMemberWithTheSameLocalPartGetsASuffix(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.fake.addAccountUser("dana@one.test", "acct_dana_one")
	server.fake.addAccountUser("dana@two.test", "acct_dana_two")

	first := inviteRequest(server, team.teamID, team.admin.accessToken, "dana@one.test", "member")
	if first.status != http.StatusCreated {
		t.Fatalf("first invite: %d %s", first.status, first.text)
	}
	second := inviteRequest(server, team.teamID, team.admin.accessToken, "dana@two.test", "member")
	if second.status != http.StatusCreated {
		t.Fatalf("second invite: %d %s", second.status, second.text)
	}
	firstRow, _ := first.body["member"].(map[string]any)
	secondRow, _ := second.body["member"].(map[string]any)
	if handle := stringField(firstRow, "mention_handle"); handle != "dana" {
		t.Fatalf("the first invite holds %q", handle)
	}
	if handle := stringField(secondRow, "mention_handle"); handle != "dana-2" {
		t.Fatalf("the second invite holds %q, want dana-2: %s", handle, second.text)
	}
}

// TestMentionByGithubUsernameStillResolves keeps the input mentions were the only
// identifier for: a body that names an older roster's login still reaches the member,
// even once its handle has moved on.
func TestMentionByGithubUsernameStillResolves(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	late := server.unboundMemberAndLogin(team.teamID, "hubot")
	lateID := stringField(late.member, "id")
	if _, err := server.hub.DB().Exec("UPDATE members SET mention_handle = ? WHERE id = ?",
		"hubot-renamed", lateID); err != nil {
		t.Fatalf("rename the handle: %v", err)
	}
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "thread"})

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@hubot look"}})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	if mentions, _ := one[int](server, "SELECT COUNT(*) FROM comment_mentions WHERE target_member_id = ?",
		lateID); mentions != 1 {
		t.Fatalf("the login resolved %d times", mentions)
	}
	// The handle it moved to still wins, and the login stays an input.
	byHandle := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@hubot-renamed look"}})
	if byHandle.status != http.StatusCreated {
		t.Fatalf("second comment: %d %s", byHandle.status, byHandle.text)
	}
	if mentions, _ := one[int](server, "SELECT COUNT(*) FROM comment_mentions WHERE target_member_id = ?",
		lateID); mentions != 2 {
		t.Fatalf("the handle resolved %d mentions in total", mentions)
	}
}

// TestUnknownMentionWritesNothing keeps the miss quiet: a handle no member answers to
// leaves the comment and writes no mention row, which is what the parser did before.
func TestUnknownMentionWritesNothing(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.inviteAndLogin(team.teamID, team.admin.accessToken, "dana")
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "thread"})

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@nobody and @dana."}})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	if mentions, _ := one[int](server, "SELECT COUNT(*) FROM comment_mentions WHERE target_type = 'member'"); mentions != 1 {
		t.Fatalf("the comment wrote %d member mentions, want the one it names", mentions)
	}
}
