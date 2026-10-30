package hub

// Members, the team they belong to, and the one-shot bootstrap that creates the
// first of each.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"regexp"
	"strconv"
	"strings"
)

// GetTeam resolves the team a path names, or refuses with NOT_FOUND.
func (h *Hub) GetTeam(teamID string) (*Team, error) {
	team := &Team{}
	err := h.db.QueryRow("SELECT id, name, slug, created_at, updated_at FROM teams WHERE id = ?", teamID).
		Scan(&team.ID, &team.Name, &team.Slug, &team.CreatedAt, &team.UpdatedAt)
	if err == errNoRows {
		return nil, FailWith(CodeNotFound, "Team not found.", map[string]any{"team_id": teamID})
	}
	if err != nil {
		return nil, err
	}
	return team, nil
}

// ListMembers is the team roster in join order.
func (h *Hub) ListMembers(teamID string) ([]MemberView, error) {
	rows, err := Collect(h.db, "SELECT "+memberColumns+" FROM members WHERE team_id = ? ORDER BY created_at",
		scanMember, teamID)
	if err != nil {
		return nil, err
	}
	views := make([]MemberView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toMemberView(row))
	}
	return views, nil
}

type meTeam struct {
	TeamID string `json:"team_id"`
	Role   string `json:"role"`
}

type meResponse struct {
	Member MemberView `json:"member"`
	Teams  []meTeam   `json:"teams"`
}

// DescribeMe answers who the caller is plus every team they belong to.
func (h *Hub) DescribeMe(principal *Principal) (*meResponse, error) {
	rows, err := h.db.Query("SELECT team_id, role FROM members WHERE github_user_id = ? ORDER BY created_at",
		principal.Member.GithubUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	teams := make([]meTeam, 0)
	for rows.Next() {
		var team meTeam
		if err := rows.Scan(&team.TeamID, &team.Role); err != nil {
			return nil, err
		}
		teams = append(teams, team)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(teams) == 0 {
		teams = append(teams, meTeam{TeamID: principal.Member.TeamID, Role: principal.Member.Role})
	}
	return &meResponse{Member: toMemberView(principal.Member), Teams: teams}, nil
}

// inviteEmail trims and checks the address an invite names.
func inviteEmail(raw string) (string, error) {
	email := strings.TrimSpace(raw)
	at := strings.LastIndex(email, "@")
	if at <= 0 || at == len(email)-1 || strings.ContainsAny(email, " \t\r\n") {
		return "", FailWith(CodeValidationFailed,
			"email must be a plain address such as name@example.com.", map[string]any{"field": "email"})
	}
	return email, nil
}

// emailLocalPart is the name an invite starts from: the account service knows
// the address, not a display name, so the part before the at-sign names the row.
func emailLocalPart(email string) string {
	if at := strings.LastIndex(email, "@"); at > 0 {
		return email[:at]
	}
	return email
}

// mentionHandleFolds matches every run of characters a mention cannot carry: section
// 7's [a-zA-Z0-9_-], stored lowercase because resolution folds case. The dot an
// address holds is not one of them - a handle has to stay distinguishable from the
// full stop that ends a sentence - so "mei.lin" folds to "mei-lin".
var mentionHandleFolds = regexp.MustCompile(`[^a-z0-9_-]+`)

// sanitizeMentionHandle folds free text into the characters a mention can carry:
// lowercase [a-z0-9_-], every run of anything else collapsed into one hyphen, both
// ends trimmed. Nothing left yields the generic name, because a member without a
// handle could never be mentioned.
func sanitizeMentionHandle(raw string) string {
	handle := strings.Trim(mentionHandleFolds.ReplaceAllString(strings.ToLower(raw), "-"), "-")
	if handle == "" {
		return "member"
	}
	return handle
}

// uniqueMentionHandle keeps one team's handles distinct: the base when nobody holds
// it, and base-2, base-3 ... otherwise. The lookup folds case because a mention does.
func (h *Hub) uniqueMentionHandle(teamID, base string) (string, error) {
	candidate := base
	for suffix := 2; ; suffix++ {
		var holder string
		err := h.db.QueryRow(
			"SELECT id FROM members WHERE team_id = ? AND mention_handle = ? COLLATE NOCASE LIMIT 1",
			teamID, candidate).Scan(&holder)
		if err == errNoRows {
			return candidate, nil
		}
		if err != nil {
			return "", err
		}
		candidate = base + "-" + strconv.Itoa(suffix)
	}
}

// placeholderGithubIdentity is the inert GitHub identity an email-invited member
// carries. The members table predates the account service: both github columns
// are NOT NULL and unique per team, while the identity that signs in now lives in
// account_user_id. A negative id can never equal a real GitHub id, and the
// "account:" prefix marks the handle as a placeholder, because a colon is not
// legal in a GitHub login and so can neither be typed as a mention nor match one.
func placeholderGithubIdentity(accountUserID string) (int64, string) {
	digest := sha256.Sum256([]byte(accountUserID))
	raw := binary.BigEndian.Uint64(digest[:8]) >> 1
	return -int64(raw) - 1, "account:" + accountUserID
}

// InviteMember is section 2 member management: an admin names an email, the
// account service resolves it, and the membership lands active and bound. The
// binding is what makes the invite work at all: sign-in matches a member by
// account_user_id, so an invited row that is not bound answers 409 NOT_LINKED to
// the person it just invited.
//
// Section 11 asks for an audit record of the change. The activity table is
// issue-scoped (issue_id NOT NULL REFERENCES issues(id)), so a team-scoped join
// has no legal row there and the hub writes one [audit] line to the process log
// instead. That log is the only trace: it is not queryable, and it does not
// survive a restart or a rotated log file. A durable audit needs a new table.
func (h *Hub) InviteMember(teamID string, actor *Principal, email, role string, now int64) (*MemberView, error) {
	account, err := h.LookupAccountByEmail(email)
	if err != nil {
		return nil, err
	}
	if account == nil {
		return nil, FailWith(CodeUserNotFound,
			"No Whale account exists for this email yet; ask the invitee to sign in to the Whale app "+
				"with Apple once, then invite again.", map[string]any{"email": email})
	}
	existing, err := queryMember(h.db,
		"SELECT "+memberColumns+" FROM members WHERE account_user_id = ?", account.UserID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, FailWith(CodeAlreadyMember, "This account is already a member of a team on this hub.",
			map[string]any{"member_id": existing.ID})
	}
	githubID, githubHandle := placeholderGithubIdentity(account.UserID)
	// The GitHub columns are the placeholder above and can never be mentioned, so the
	// address is what names the row a comment may @.
	mentionHandle, err := h.uniqueMentionHandle(teamID, sanitizeMentionHandle(emailLocalPart(email)))
	if err != nil {
		return nil, err
	}
	member := &Member{
		ID: NewID("mem", now), TeamID: teamID, GithubUserID: githubID,
		GithubUsername: githubHandle, MentionHandle: mentionHandle,
		DisplayName: emailLocalPart(email), AccountUserID: strPointer(account.UserID),
		Role: role, Status: "active", CreatedAt: now, UpdatedAt: now,
	}
	_, err = h.db.Exec(
		`INSERT INTO members (id, team_id, github_user_id, github_username, mention_handle,
		 display_name, avatar_url, account_user_id, role, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.MentionHandle,
		member.DisplayName, member.AvatarURL, member.AccountUserID, member.Role, member.Status,
		member.CreatedAt, member.UpdatedAt)
	if err != nil {
		// The partial unique index on account_user_id and a racing invite end with
		// the same answer the pre-check gives.
		if holder, lookupErr := queryMember(h.db,
			"SELECT "+memberColumns+" FROM members WHERE account_user_id = ?", account.UserID); lookupErr == nil && holder != nil {
			return nil, FailWith(CodeAlreadyMember,
				"This account is already a member of a team on this hub.",
				map[string]any{"member_id": holder.ID})
		}
		return nil, err
	}
	h.logf("[audit] member.joined team=%s member=%s account=%s role=%s actor=%s email=%s",
		member.TeamID, member.ID, account.UserID, member.Role, actor.Member.ID, maskEmail(email))
	view := toMemberView(member)
	return &view, nil
}

// RemoveMember suspends the membership and terminates its sessions immediately.
func (h *Hub) RemoveMember(teamID, memberID string, now int64) error {
	member, err := queryMember(h.db, "SELECT "+memberColumns+" FROM members WHERE id = ? AND team_id = ?",
		memberID, teamID)
	if err != nil {
		return err
	}
	if member == nil {
		return FailWith(CodeMemberNotFound, "Member not found on this team.",
			map[string]any{"member_id": memberID})
	}
	if _, err := h.db.Exec("UPDATE members SET status = 'suspended', updated_at = ? WHERE id = ?",
		now, memberID); err != nil {
		return err
	}
	return h.revokeMemberSessions(memberID, now)
}

// BootstrapTeam creates the first team and its first admin. The teams table
// being empty is the whole precondition: the call that fills it is also the last
// one that succeeds.
//
// The admin is named by the email address they sign in with. The account service
// resolves that address to the user id an assertion carries as sub, and the row
// is written bound to it, so the first admin can enter on their first sign-in. A
// row created from a GitHub login would leave account_user_id empty, and sign-in
// matches on nothing else: that admin could never enter, which is the deployment
// this call used to dead-end.
func (h *Hub) BootstrapTeam(teamName, teamSlug, email string, now int64) (map[string]any, error) {
	// The one-shot rule outranks everything else: a hub with a team has already
	// bootstrapped, whether or not its account service is configured today.
	var occupied string
	err := h.db.QueryRow("SELECT id FROM teams LIMIT 1").Scan(&occupied)
	if err == nil {
		return nil, FailWith(CodeConflict,
			"This hub already has a team; bootstrap runs once, on the first deployment.",
			map[string]any{"team_id": occupied})
	}
	if err != errNoRows {
		return nil, err
	}
	account, err := h.LookupAccountByEmail(email)
	if err != nil {
		return nil, err
	}
	if account == nil {
		return nil, FailWith(CodeUserNotFound,
			"No Whale account exists for this email yet; sign in to the Whale app with Apple once, "+
				"then run bootstrap again.", map[string]any{"email": email})
	}
	// The members table predates the account service and both github columns are
	// NOT NULL, so the admin carries the same derived placeholder an email invite
	// carries. Deriving it from the account id keeps one account's placeholder
	// identical in every team it joins.
	githubID, githubHandle := placeholderGithubIdentity(account.UserID)
	team := &Team{ID: NewID("team", now), Name: teamName, Slug: teamSlug, CreatedAt: now, UpdatedAt: now}
	// The first row of an empty team cannot collide, and it derives its handle the way
	// every later invite does.
	mentionHandle, err := h.uniqueMentionHandle(team.ID, sanitizeMentionHandle(emailLocalPart(email)))
	if err != nil {
		return nil, err
	}
	member := &Member{
		ID: NewID("mem", now), TeamID: team.ID, GithubUserID: githubID,
		GithubUsername: githubHandle, MentionHandle: mentionHandle,
		DisplayName: emailLocalPart(email), AccountUserID: strPointer(account.UserID),
		Role: "admin", Status: "active", CreatedAt: now, UpdatedAt: now,
	}
	// Both inserts repeat the emptiness test and run in one transaction, so two
	// calls that raced past the check cannot both create a team, and a team never
	// lands without the admin that makes it enterable.
	teamChanged := int64(0)
	err = h.db.Tx(func(tx *sql.Tx) error {
		result, err := tx.Exec(
			"INSERT INTO teams (id, name, slug, created_at, updated_at) "+
				"SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM teams)",
			team.ID, team.Name, team.Slug, team.CreatedAt, team.UpdatedAt)
		if err != nil {
			return err
		}
		teamChanged = changed(result)
		_, err = tx.Exec(
			"INSERT INTO members (id, team_id, github_user_id, github_username, mention_handle, "+
				"display_name, avatar_url, account_user_id, role, status, created_at, updated_at) "+
				"SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM teams WHERE id = ?)",
			member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.MentionHandle,
			member.DisplayName, member.AvatarURL, member.AccountUserID, member.Role, member.Status,
			member.CreatedAt, member.UpdatedAt, team.ID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if teamChanged == 0 {
		var winner string
		if err := h.db.QueryRow("SELECT id FROM teams LIMIT 1").Scan(&winner); err != nil {
			return nil, Fail(CodeConflict, "Another bootstrap call created the first team first.")
		}
		return nil, FailWith(CodeConflict,
			"Another bootstrap call created the first team first.", map[string]any{"team_id": winner})
	}
	return map[string]any{
		"team": map[string]any{"id": team.ID, "name": team.Name, "slug": team.Slug},
		"member": map[string]any{
			"id": member.ID, "github_username": member.GithubUsername,
			"mention_handle":  member.MentionHandle,
			"account_user_id": account.UserID, "role": "admin",
		},
	}, nil
}
