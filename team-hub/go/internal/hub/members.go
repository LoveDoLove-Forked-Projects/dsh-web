package hub

// Members, the team they belong to, and the one-shot bootstrap that creates the
// first of each.

import (
	"database/sql"
	"net/url"
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

// InviteMember is section 2 member management: an admin invites by GitHub
// username, and the GitHub lookup fills the numeric id the schema requires.
func (h *Hub) InviteMember(teamID string, actor *Principal, username, role string, now int64) (*MemberView, error) {
	profile, err := h.FetchGithubProfile(username)
	if err != nil {
		return nil, err
	}
	if profile == nil {
		return nil, FailWith(CodeUserNotFound, "No GitHub user named "+username+".",
			map[string]any{"github_username": username})
	}
	existing, err := queryMember(h.db,
		"SELECT "+memberColumns+" FROM members WHERE team_id = ? AND (github_user_id = ? OR "+
			"github_username = ? COLLATE NOCASE)", teamID, profile.ID, profile.Login)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		return nil, FailWith(CodeAlreadyMember, "This GitHub user is already on the team.",
			map[string]any{"member_id": existing.ID})
	}
	displayName := profile.Login
	if profile.Name != nil {
		displayName = *profile.Name
	}
	member := &Member{
		ID: NewID("mem", now), TeamID: teamID, GithubUserID: profile.ID,
		GithubUsername: profile.Login, DisplayName: displayName, AvatarURL: profile.AvatarURL,
		Role: role, Status: "invited", CreatedAt: now, UpdatedAt: now,
	}
	_, err = h.db.Exec(
		`INSERT INTO members (id, team_id, github_user_id, github_username, display_name, avatar_url,
		 role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.DisplayName,
		member.AvatarURL, member.Role, member.Status, member.CreatedAt, member.UpdatedAt)
	if err != nil {
		return nil, err
	}
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
