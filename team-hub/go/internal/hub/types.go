package hub

// Row shapes as SQLite returns them and the JSON shapes the wire format exposes
// (PROTOCOL.md section 9). Column names stay snake_case on both sides: the
// specification's payload examples use them directly.

import (
	"database/sql"
	"encoding/json"
)

type scanner interface{ Scan(dest ...any) error }

// Team is one row of the teams table.
type Team struct {
	ID        string
	Name      string
	Slug      string
	CreatedAt int64
	UpdatedAt int64
}

// Member is one row of the members table.
type Member struct {
	ID             string
	TeamID         string
	GithubUserID   int64
	GithubUsername string
	DisplayName    string
	AvatarURL      *string
	AccountUserID  *string
	Role           string
	Status         string
	CreatedAt      int64
	UpdatedAt      int64
}

const memberColumns = `id, team_id, github_user_id, github_username, display_name, avatar_url,
	account_user_id, role, status, created_at, updated_at`

func scanMember(sc scanner) (*Member, error) {
	member := &Member{}
	var avatar, account sql.NullString
	err := sc.Scan(&member.ID, &member.TeamID, &member.GithubUserID, &member.GithubUsername,
		&member.DisplayName, &avatar, &account, &member.Role, &member.Status,
		&member.CreatedAt, &member.UpdatedAt)
	if err != nil {
		return nil, err
	}
	member.AvatarURL = nullString(avatar)
	member.AccountUserID = nullString(account)
	return member, nil
}

func queryMember(db *DB, query string, args ...any) (*Member, error) {
	member, err := scanMember(db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return member, err
}

// Host is one row of the hosts table.
type Host struct {
	ID              string
	TeamID          string
	OwnerMemberID   string
	Hostname        string
	ClientVersion   string
	TokenHash       string
	Status          string
	LastHeartbeatAt int64
	CreatedAt       int64
	UpdatedAt       int64
}

const hostColumns = `id, team_id, owner_member_id, hostname, client_version, token_hash, status,
	last_heartbeat_at, created_at, updated_at`

func scanHost(sc scanner) (*Host, error) {
	host := &Host{}
	err := sc.Scan(&host.ID, &host.TeamID, &host.OwnerMemberID, &host.Hostname, &host.ClientVersion,
		&host.TokenHash, &host.Status, &host.LastHeartbeatAt, &host.CreatedAt, &host.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return host, nil
}

func queryHost(db *DB, query string, args ...any) (*Host, error) {
	host, err := scanHost(db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return host, err
}

// Agent is one row of the agents table.
type Agent struct {
	ID              string
	TeamID          string
	HostID          string
	OwnerMemberID   string
	Name            string
	PresetID        string
	Description     *string
	Model           *string
	ReasoningEffort *string
	Status          string
	CreatedAt       int64
	UpdatedAt       int64
}

const agentColumns = `id, team_id, host_id, owner_member_id, name, preset_id, description, model,
	reasoning_effort, status, created_at, updated_at`

func scanAgent(sc scanner) (*Agent, error) {
	agent := &Agent{}
	var description, model, effort sql.NullString
	err := sc.Scan(&agent.ID, &agent.TeamID, &agent.HostID, &agent.OwnerMemberID, &agent.Name,
		&agent.PresetID, &description, &model, &effort, &agent.Status, &agent.CreatedAt, &agent.UpdatedAt)
	if err != nil {
		return nil, err
	}
	agent.Description = nullString(description)
	agent.Model = nullString(model)
	agent.ReasoningEffort = nullString(effort)
	return agent, nil
}

func queryAgent(db *DB, query string, args ...any) (*Agent, error) {
	agent, err := scanAgent(db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return agent, err
}

// Issue is one row of the issues table.
type Issue struct {
	ID                 string
	TeamID             string
	Number             int64
	Title              string
	Description        string
	Status             string
	CreatorMemberID    string
	AssigneeType       *string
	AssigneeMemberID   *string
	AssigneeAgentID    *string
	ReviewerMemberID   *string
	ExecutingHostID    *string
	LeaseToken         *string
	LeaseExpiresAt     *int64
	ExecutionAttemptID *string
	ExecutionSummary   *string
	ReworkInstructions *string
	FailureError       *string
	CreatedAt          int64
	UpdatedAt          int64
}

const issueColumns = `id, team_id, issue_number, title, description, status, creator_member_id,
	assignee_type, assignee_member_id, assignee_agent_id, reviewer_member_id, executing_host_id,
	lease_token, lease_expires_at, execution_attempt_id, execution_summary, rework_instructions,
	failure_error, created_at, updated_at`

// issueColumnsI qualifies the same list for a join that also reads agents and
// hosts, whose own column names would otherwise be ambiguous.
const issueColumnsI = `i.id, i.team_id, i.issue_number, i.title, i.description, i.status,
	i.creator_member_id, i.assignee_type, i.assignee_member_id, i.assignee_agent_id,
	i.reviewer_member_id, i.executing_host_id, i.lease_token, i.lease_expires_at,
	i.execution_attempt_id, i.execution_summary, i.rework_instructions, i.failure_error,
	i.created_at, i.updated_at`

func scanIssue(sc scanner) (*Issue, error) {
	issue := &Issue{}
	var assigneeType, assigneeMember, assigneeAgent, reviewer, host sql.NullString
	var leaseToken, attempt, summary, rework, failure sql.NullString
	var leaseExpires sql.NullInt64
	err := sc.Scan(&issue.ID, &issue.TeamID, &issue.Number, &issue.Title, &issue.Description,
		&issue.Status, &issue.CreatorMemberID, &assigneeType, &assigneeMember, &assigneeAgent,
		&reviewer, &host, &leaseToken, &leaseExpires, &attempt, &summary, &rework, &failure,
		&issue.CreatedAt, &issue.UpdatedAt)
	if err != nil {
		return nil, err
	}
	issue.AssigneeType = nullString(assigneeType)
	issue.AssigneeMemberID = nullString(assigneeMember)
	issue.AssigneeAgentID = nullString(assigneeAgent)
	issue.ReviewerMemberID = nullString(reviewer)
	issue.ExecutingHostID = nullString(host)
	issue.LeaseToken = nullString(leaseToken)
	issue.LeaseExpiresAt = nullInt(leaseExpires)
	issue.ExecutionAttemptID = nullString(attempt)
	issue.ExecutionSummary = nullString(summary)
	issue.ReworkInstructions = nullString(rework)
	issue.FailureError = nullString(failure)
	return issue, nil
}

func queryIssue(db *DB, query string, args ...any) (*Issue, error) {
	issue, err := scanIssue(db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return issue, err
}

// Comment is one row of the comments table.
type Comment struct {
	ID             string
	TeamID         string
	IssueID        string
	AuthorType     string
	AuthorMemberID *string
	AuthorAgentID  *string
	Content        string
	CreatedAt      int64
	UpdatedAt      int64
}

const commentColumns = `id, team_id, issue_id, author_type, author_member_id, author_agent_id,
	content, created_at, updated_at`

func scanComment(sc scanner) (*Comment, error) {
	comment := &Comment{}
	var member, agent sql.NullString
	err := sc.Scan(&comment.ID, &comment.TeamID, &comment.IssueID, &comment.AuthorType, &member,
		&agent, &comment.Content, &comment.CreatedAt, &comment.UpdatedAt)
	if err != nil {
		return nil, err
	}
	comment.AuthorMemberID = nullString(member)
	comment.AuthorAgentID = nullString(agent)
	return comment, nil
}

// ActivityRow is one row of the activity table.
type ActivityRow struct {
	ID            string
	TeamID        string
	IssueID       string
	ActorType     string
	ActorMemberID *string
	ActorAgentID  *string
	ActorHostID   *string
	ActivityType  string
	PayloadJSON   string
	CreatedAt     int64
}

const activityColumns = `id, team_id, issue_id, actor_type, actor_member_id, actor_agent_id,
	actor_host_id, activity_type, payload_json, created_at`

func scanActivity(sc scanner) (*ActivityRow, error) {
	activity := &ActivityRow{}
	var member, agent, host sql.NullString
	err := sc.Scan(&activity.ID, &activity.TeamID, &activity.IssueID, &activity.ActorType, &member,
		&agent, &host, &activity.ActivityType, &activity.PayloadJSON, &activity.CreatedAt)
	if err != nil {
		return nil, err
	}
	activity.ActorMemberID = nullString(member)
	activity.ActorAgentID = nullString(agent)
	activity.ActorHostID = nullString(host)
	return activity, nil
}

// Question is one row of the questions table.
type Question struct {
	ID                     string
	TeamID                 string
	IssueID                string
	HostID                 string
	AgentID                string
	QuestionText           string
	OptionsJSON            *string
	MultiSelect            int64
	Status                 string
	FirstResponderMemberID *string
	AnswerJSON             *string
	AnsweredAt             *int64
	CreatedAt              int64
	ExpiresAt              int64
}

const questionColumns = `id, team_id, issue_id, host_id, agent_id, question_text, options_json,
	multi_select, status, first_responder_member_id, answer_json, answered_at, created_at, expires_at`

// questionColumnsI qualifies the question list for the join the inbox runs.
const questionColumnsI = `q.id, q.team_id, q.issue_id, q.host_id, q.agent_id, q.question_text,
	q.options_json, q.multi_select, q.status, q.first_responder_member_id, q.answer_json,
	q.answered_at, q.created_at, q.expires_at`

func scanQuestion(sc scanner) (*Question, error) {
	question := &Question{}
	var options, responder, answer sql.NullString
	var answeredAt sql.NullInt64
	err := sc.Scan(&question.ID, &question.TeamID, &question.IssueID, &question.HostID,
		&question.AgentID, &question.QuestionText, &options, &question.MultiSelect,
		&question.Status, &responder, &answer, &answeredAt, &question.CreatedAt, &question.ExpiresAt)
	if err != nil {
		return nil, err
	}
	question.OptionsJSON = nullString(options)
	question.FirstResponderMemberID = nullString(responder)
	question.AnswerJSON = nullString(answer)
	question.AnsweredAt = nullInt(answeredAt)
	return question, nil
}

// PushToken is one row of the push_tokens table.
type PushToken struct {
	ID          string
	MemberID    string
	Platform    string
	DeviceToken string
	BundleID    string
	Environment string
	CreatedAt   int64
	UpdatedAt   int64
}

const pushTokenColumns = `id, member_id, platform, device_token, bundle_id, environment,
	created_at, updated_at`

func scanPushToken(sc scanner) (*PushToken, error) {
	token := &PushToken{}
	err := sc.Scan(&token.ID, &token.MemberID, &token.Platform, &token.DeviceToken,
		&token.BundleID, &token.Environment, &token.CreatedAt, &token.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return token, nil
}

// RefreshToken is one row of the refresh_tokens table.
type RefreshToken struct {
	ID        string
	MemberID  string
	SessionID string
	TokenHash string
	ExpiresAt int64
	CreatedAt int64
	RevokedAt *int64
}

const refreshTokenColumns = `id, member_id, session_id, token_hash, expires_at, created_at, revoked_at`

func scanRefreshToken(sc scanner) (*RefreshToken, error) {
	token := &RefreshToken{}
	var revoked sql.NullInt64
	err := sc.Scan(&token.ID, &token.MemberID, &token.SessionID, &token.TokenHash,
		&token.ExpiresAt, &token.CreatedAt, &revoked)
	if err != nil {
		return nil, err
	}
	token.RevokedAt = nullInt(revoked)
	return token, nil
}

// OAuthState is one row of the oauth_states table.
type OAuthState struct {
	State               string
	Client              string
	RedirectURI         string
	CodeChallenge       *string
	CodeChallengeMethod *string
	CreatedAt           int64
	ExpiresAt           int64
	Code                *string
}

const oauthStateColumns = `state, client, redirect_uri, code_challenge, code_challenge_method,
	created_at, expires_at, code`

func scanOAuthState(sc scanner) (*OAuthState, error) {
	state := &OAuthState{}
	var challenge, method, code sql.NullString
	err := sc.Scan(&state.State, &state.Client, &state.RedirectURI, &challenge, &method,
		&state.CreatedAt, &state.ExpiresAt, &code)
	if err != nil {
		return nil, err
	}
	state.CodeChallenge = nullString(challenge)
	state.CodeChallengeMethod = nullString(method)
	state.Code = nullString(code)
	return state, nil
}

// ---- wire views (PROTOCOL.md section 9) ----

// MemberView is a member as section 9 exposes it; no token material.
type MemberView struct {
	ID             string  `json:"id"`
	TeamID         string  `json:"team_id"`
	GithubUserID   int64   `json:"github_user_id"`
	GithubUsername string  `json:"github_username"`
	DisplayName    string  `json:"display_name"`
	AvatarURL      *string `json:"avatar_url"`
	Role           string  `json:"role"`
	Status         string  `json:"status"`
	CreatedAt      int64   `json:"created_at"`
	UpdatedAt      int64   `json:"updated_at"`
}

// IssueView is the issue shape the wire exposes; the lease token never leaves
// the hub, only its expiry and whether one exists.
type IssueView struct {
	ID                 string  `json:"id"`
	TeamID             string  `json:"team_id"`
	IssueNumber        int64   `json:"issue_number"`
	Title              string  `json:"title"`
	Description        string  `json:"description"`
	Status             string  `json:"status"`
	CreatorMemberID    string  `json:"creator_member_id"`
	AssigneeType       *string `json:"assignee_type"`
	AssigneeMemberID   *string `json:"assignee_member_id"`
	AssigneeAgentID    *string `json:"assignee_agent_id"`
	ReviewerMemberID   *string `json:"reviewer_member_id"`
	ExecutingHostID    *string `json:"executing_host_id"`
	LeaseExpiresAt     *int64  `json:"lease_expires_at"`
	HasLease           bool    `json:"has_lease"`
	ExecutionAttemptID *string `json:"execution_attempt_id"`
	ExecutionSummary   *string `json:"execution_summary"`
	ReworkInstructions *string `json:"rework_instructions"`
	FailureError       *string `json:"failure_error"`
	CreatedAt          int64   `json:"created_at"`
	UpdatedAt          int64   `json:"updated_at"`
}

// CommentView is one comment row on the wire.
type CommentView struct {
	ID             string  `json:"id"`
	TeamID         string  `json:"team_id"`
	IssueID        string  `json:"issue_id"`
	AuthorType     string  `json:"author_type"`
	AuthorMemberID *string `json:"author_member_id"`
	AuthorAgentID  *string `json:"author_agent_id"`
	Content        string  `json:"content"`
	CreatedAt      int64   `json:"created_at"`
	UpdatedAt      int64   `json:"updated_at"`
}

// QuestionOption is supplement A2.2's selectable option.
type QuestionOption struct {
	Label       string  `json:"label"`
	Description *string `json:"description,omitempty"`
}

// QuestionAnswer is supplement A2.2's answer object.
type QuestionAnswer struct {
	Selected []string `json:"selected"`
	Custom   string   `json:"custom,omitempty"`
}

// QuestionView is one question on the wire.
type QuestionView struct {
	ID                     string           `json:"id"`
	IssueID                string           `json:"issue_id"`
	Text                   string           `json:"text"`
	Options                []QuestionOption `json:"options"`
	MultiSelect            bool             `json:"multi_select"`
	Status                 string           `json:"status"`
	Answer                 *QuestionAnswer  `json:"answer"`
	FirstResponderMemberID *string          `json:"first_responder_member_id"`
	CreatedAt              int64            `json:"created_at"`
	AnsweredAt             *int64           `json:"answered_at"`
}

// ActivityView is supplement A2.3's audit entry.
type ActivityView struct {
	ID           string         `json:"id"`
	IssueID      string         `json:"issue_id"`
	ActorType    string         `json:"actor_type"`
	ActorID      *string        `json:"actor_id"`
	ActivityType string         `json:"activity_type"`
	Payload      map[string]any `json:"payload"`
	CreatedAt    int64          `json:"created_at"`
}

// ClaimResult is the claim response body.
type ClaimResult struct {
	LeaseToken         string `json:"lease_token"`
	LeaseExpiresAt     int64  `json:"lease_expires_at"`
	ExecutionAttemptID string `json:"execution_attempt_id"`
}

// SweepResult counts what one sweep changed.
type SweepResult struct {
	HostsOffline     int `json:"hosts_offline"`
	LeasesExpired    int `json:"leases_expired"`
	QuestionsExpired int `json:"questions_expired"`
}

// AgentEntry maps an agent name to the hub id the Host must use.
type AgentEntry struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// AgentConflict names a definition another Host already owns.
type AgentConflict struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// RegistrationResult is the register response body.
type RegistrationResult struct {
	HostID    string          `json:"host_id"`
	Status    string          `json:"status"`
	Agents    []AgentEntry    `json:"agents"`
	Conflicts []AgentConflict `json:"conflicts"`
}

// AgentBinding is supplement A2.1's roster entry.
type AgentBinding struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	HostID        string `json:"host_id"`
	OwnerMemberID string `json:"owner_member_id"`
	HostStatus    string `json:"host_status"`
}

// InboxMention is one unread mention.
type InboxMention struct {
	Comment CommentView `json:"comment"`
	IssueID string      `json:"issue_id"`
}

// ActivityPage is one page of the audit feed.
type ActivityPage struct {
	Activity   []ActivityView `json:"activity"`
	NextCursor *string        `json:"next_cursor"`
}

// ---- conversion helpers ----

func nullString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	out := value.String
	return &out
}

func nullInt(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	out := value.Int64
	return &out
}

func strPointer(value string) *string { return &value }

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func toMemberView(row *Member) MemberView {
	return MemberView{
		ID: row.ID, TeamID: row.TeamID, GithubUserID: row.GithubUserID,
		GithubUsername: row.GithubUsername, DisplayName: row.DisplayName,
		AvatarURL: row.AvatarURL, Role: row.Role, Status: row.Status,
		CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func toIssueView(row *Issue) IssueView {
	return IssueView{
		ID: row.ID, TeamID: row.TeamID, IssueNumber: row.Number, Title: row.Title,
		Description: row.Description, Status: row.Status, CreatorMemberID: row.CreatorMemberID,
		AssigneeType: row.AssigneeType, AssigneeMemberID: row.AssigneeMemberID,
		AssigneeAgentID: row.AssigneeAgentID, ReviewerMemberID: row.ReviewerMemberID,
		ExecutingHostID: row.ExecutingHostID, LeaseExpiresAt: row.LeaseExpiresAt,
		HasLease: row.LeaseToken != nil, ExecutionAttemptID: row.ExecutionAttemptID,
		ExecutionSummary: row.ExecutionSummary, ReworkInstructions: row.ReworkInstructions,
		FailureError: row.FailureError, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func toCommentView(row *Comment) CommentView {
	return CommentView{
		ID: row.ID, TeamID: row.TeamID, IssueID: row.IssueID, AuthorType: row.AuthorType,
		AuthorMemberID: row.AuthorMemberID, AuthorAgentID: row.AuthorAgentID,
		Content: row.Content, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
	}
}

func parseJSONColumn(raw *string) any {
	if raw == nil {
		return nil
	}
	var parsed any
	if err := json.Unmarshal([]byte(*raw), &parsed); err != nil {
		return nil
	}
	return parsed
}

// normalizeQuestionOptions turns the stored JSON into always-object options.
func normalizeQuestionOptions(raw any) []QuestionOption {
	options := make([]QuestionOption, 0)
	entries, ok := raw.([]any)
	if !ok {
		return options
	}
	for _, entry := range entries {
		if text, ok := entry.(string); ok {
			options = append(options, QuestionOption{Label: text})
			continue
		}
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		label, ok := record["label"].(string)
		if !ok {
			continue
		}
		option := QuestionOption{Label: label}
		if description, ok := record["description"].(string); ok {
			option.Description = strPointer(description)
		}
		options = append(options, option)
	}
	return options
}

// normalizeQuestionAnswer exposes a stored answer as an object, never a string.
func normalizeQuestionAnswer(raw any) *QuestionAnswer {
	record, ok := raw.(map[string]any)
	if !ok {
		return nil
	}
	answer := &QuestionAnswer{Selected: make([]string, 0)}
	if values, ok := record["selected"].([]any); ok {
		for _, value := range values {
			if text, ok := value.(string); ok {
				answer.Selected = append(answer.Selected, text)
			}
		}
	}
	if custom, ok := record["custom"].(string); ok {
		answer.Custom = custom
	}
	return answer
}

func toQuestionView(row *Question) QuestionView {
	return QuestionView{
		ID: row.ID, IssueID: row.IssueID, Text: row.QuestionText,
		Options:     normalizeQuestionOptions(parseJSONColumn(row.OptionsJSON)),
		MultiSelect: row.MultiSelect == 1, Status: row.Status,
		Answer:                 normalizeQuestionAnswer(parseJSONColumn(row.AnswerJSON)),
		FirstResponderMemberID: row.FirstResponderMemberID,
		CreatedAt:              row.CreatedAt, AnsweredAt: row.AnsweredAt,
	}
}

func toActivityView(row *ActivityRow) ActivityView {
	actor := row.ActorMemberID
	if actor == nil {
		actor = row.ActorAgentID
	}
	if actor == nil {
		actor = row.ActorHostID
	}
	payload := map[string]any{}
	if parsed, ok := parseJSONColumn(&row.PayloadJSON).(map[string]any); ok {
		payload = parsed
	}
	return ActivityView{
		ID: row.ID, IssueID: row.IssueID, ActorType: row.ActorType, ActorID: actor,
		ActivityType: row.ActivityType, Payload: payload, CreatedAt: row.CreatedAt,
	}
}
