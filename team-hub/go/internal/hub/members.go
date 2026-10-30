package hub

// Members, the team they belong to, and the one-shot bootstrap that creates the
// first of each.

import (
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"net/url"
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

type githubProfile struct {
	ID        int64
	Login     string
	Name      *string
	AvatarURL *string
}

// FetchGithubProfile resolves a GitHub login to the numeric id and canonical
// login the members table needs before the invitee ever logs in.
func (h *Hub) FetchGithubProfile(username string) (*githubProfile, error) {
	response, err := h.callOutbound("GET", githubAPIBase+"/users/"+url.PathEscape(username), map[string]string{
		"accept":     "application/vnd.github+json",
		"user-agent": "dsh-team-hub",
	}, "")
	if err != nil {
		return nil, FailWith(CodeUserNotFound,
			"GitHub did not return a profile for "+username+".", map[string]any{"github_status": 0})
	}
	if response.Status == 404 {
		return nil, nil
	}
	body, ok := response.Body.(map[string]any)
	if response.Status != 200 || !ok {
		return nil, FailWith(CodeUserNotFound,
			"GitHub did not return a profile for "+username+".",
			map[string]any{"github_status": response.Status})
	}
	id, idOK := body["id"].(float64)
	login, loginOK := body["login"].(string)
	if !idOK || !loginOK {
		return nil, Fail(CodeUserNotFound, "GitHub returned an unusable profile for "+username+".")
	}
	profile := &githubProfile{ID: int64(id), Login: login}
	if name, ok := body["name"].(string); ok {
		profile.Name = &name
	}
	if avatar, ok := body["avatar_url"].(string); ok {
		profile.AvatarURL = &avatar
	}
	return profile, nil
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
	member := &Member{
		ID: NewID("mem", now), TeamID: teamID, GithubUserID: githubID,
		GithubUsername: githubHandle, DisplayName: emailLocalPart(email),
		AccountUserID: strPointer(account.UserID), Role: role, Status: "active",
		CreatedAt: now, UpdatedAt: now,
	}
	_, err = h.db.Exec(
		`INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url,
		 account_user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.DisplayName,
		member.AvatarURL, member.AccountUserID, member.Role, member.Status, member.CreatedAt, member.UpdatedAt)
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
func (h *Hub) BootstrapTeam(teamName, teamSlug, githubUsername string, now int64) (map[string]any, error) {
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
	profile, err := h.FetchGithubProfile(githubUsername)
	if err != nil {
		return nil, err
	}
	if profile == nil {
		return nil, FailWith(CodeUserNotFound, "No GitHub user named "+githubUsername+".",
			map[string]any{"github_username": githubUsername})
	}
	team := &Team{ID: NewID("team", now), Name: teamName, Slug: teamSlug, CreatedAt: now, UpdatedAt: now}
	displayName := profile.Login
	if profile.Name != nil {
		displayName = *profile.Name
	}
	member := &Member{
		ID: NewID("mem", now), TeamID: team.ID, GithubUserID: profile.ID,
		GithubUsername: profile.Login, DisplayName: displayName, AvatarURL: profile.AvatarURL,
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
			"INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url, "+
				"role, status, created_at, updated_at) "+
				"SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM teams WHERE id = ?)",
			member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.DisplayName,
			member.AvatarURL, member.Role, member.Status, member.CreatedAt, member.UpdatedAt, team.ID)
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
			"id": member.ID, "github_username": member.GithubUsername, "role": "admin",
		},
	}, nil
}
