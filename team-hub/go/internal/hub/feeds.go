package hub

// The inbox (supplement A1.2) and the audit feed (supplement A1.4).

// ActivityActor is who caused one audit entry.
type ActivityActor struct {
	Kind     string
	MemberID string
	AgentID  string
	HostID   string
}

// recordActivity appends one immutable audit row; there is deliberately no
// update or delete path for this table.
func (h *Hub) recordActivity(teamID, issueID, activityType string, actor ActivityActor, payload map[string]any, now int64) error {
	if payload == nil {
		payload = map[string]any{}
	}
	encoded, err := marshalJSON(payload)
	if err != nil {
		return err
	}
	var memberID, agentID, hostID any
	if actor.MemberID != "" {
		memberID = actor.MemberID
	}
	if actor.AgentID != "" {
		agentID = actor.AgentID
	}
	if actor.HostID != "" {
		hostID = actor.HostID
	}
	_, err = h.db.Exec(
		`INSERT INTO activity (id, team_id, issue_id, actor_type, actor_member_id, actor_agent_id,
		 actor_host_id, activity_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		NewID("act", now), teamID, issueID, actor.Kind, memberID, agentID, hostID, activityType,
		encoded, now)
	return err
}

type inboxResponse struct {
	Assigned  []IssueView    `json:"assigned"`
	Review    []IssueView    `json:"review"`
	Questions []QuestionView `json:"questions"`
	Mentions  []InboxMention `json:"mentions"`
}

// GetInbox is everything a member has to act on, in one round trip.
func (h *Hub) GetInbox(teamID string, member *Principal) (*inboxResponse, error) {
	id := member.Member.ID
	assigned, err := Collect(h.db,
		"SELECT "+issueColumns+" FROM issues WHERE team_id = ? AND status NOT IN ('done', 'canceled') "+
			"AND assignee_type = 'member' AND assignee_member_id = ? ORDER BY updated_at DESC",
		scanIssue, teamID, id)
	if err != nil {
		return nil, err
	}
	reviews, err := Collect(h.db,
		"SELECT "+issueColumns+" FROM issues WHERE team_id = ? AND status = 'in_review' "+
			"AND reviewer_member_id = ? ORDER BY updated_at DESC", scanIssue, teamID, id)
	if err != nil {
		return nil, err
	}
	questions, err := Collect(h.db,
		"SELECT "+questionColumnsI+" FROM questions q JOIN issues i ON i.id = q.issue_id "+
			"WHERE q.team_id = ? AND q.status = 'pending' AND (i.reviewer_member_id = ? OR "+
			"(i.assignee_type = 'member' AND i.assignee_member_id = ?)) ORDER BY q.created_at DESC",
		scanQuestion, teamID, id, id)
	if err != nil {
		return nil, err
	}
	mentionRows, err := Collect(h.db,
		"SELECT c.id, c.team_id, c.issue_id, c.author_type, c.author_member_id, c.author_agent_id, "+
			"c.content, c.created_at, c.updated_at FROM comment_mentions m JOIN comments c ON c.id = m.comment_id "+
			"WHERE m.target_member_id = ? AND m.read_at IS NULL ORDER BY c.created_at DESC", scanComment, id)
	if err != nil {
		return nil, err
	}
	inbox := &inboxResponse{
		Assigned:  make([]IssueView, 0, len(assigned)),
		Review:    make([]IssueView, 0, len(reviews)),
		Questions: make([]QuestionView, 0, len(questions)),
		Mentions:  make([]InboxMention, 0, len(mentionRows)),
	}
	for _, issue := range assigned {
		inbox.Assigned = append(inbox.Assigned, toIssueView(issue))
	}
	for _, issue := range reviews {
		inbox.Review = append(inbox.Review, toIssueView(issue))
	}
	for _, question := range questions {
		inbox.Questions = append(inbox.Questions, toQuestionView(question))
	}
	for _, comment := range mentionRows {
		inbox.Mentions = append(inbox.Mentions, InboxMention{
			Comment: toCommentView(comment), IssueID: comment.IssueID,
		})
	}
	return inbox, nil
}

// MarkMentionRead marks one mention of this member as read.
func (h *Hub) MarkMentionRead(teamID string, member *Principal, commentID string, now int64) error {
	comment, err := scanComment(h.db.QueryRow(
		"SELECT "+commentColumns+" FROM comments WHERE id = ? AND team_id = ?", commentID, teamID))
	if err == errNoRows {
		return FailWith(CodeNotFound, "Comment not found on this team.",
			map[string]any{"comment_id": commentID})
	}
	if err != nil {
		return err
	}
	_ = comment
	_, err = h.db.Exec("UPDATE comment_mentions SET read_at = ? WHERE comment_id = ? "+
		"AND target_member_id = ? AND read_at IS NULL", now, commentID, member.Member.ID)
	return err
}

// ListActivityFeed pages one issue's audit trail newest first, with a keyset
// cursor so paging stays stable while new activity arrives.
func (h *Hub) ListActivityFeed(teamID, issueID, before string, hasBefore bool, limit int) (*ActivityPage, error) {
	if _, err := h.FindIssue(teamID, issueID); err != nil {
		return nil, err
	}
	clauses := []string{"team_id = ?", "issue_id = ?"}
	values := []any{teamID, issueID}
	if hasBefore && before != "" {
		cursor, err := scanActivity(h.db.QueryRow(
			"SELECT "+activityColumns+" FROM activity WHERE id = ? AND team_id = ?", before, teamID))
		if err == errNoRows {
			return nil, FailWith(CodeValidationFailed,
				"before does not name an activity of this team.", map[string]any{"field": "before"})
		}
		if err != nil {
			return nil, err
		}
		clauses = append(clauses, "(created_at < ? OR (created_at = ? AND id < ?))")
		values = append(values, cursor.CreatedAt, cursor.CreatedAt, cursor.ID)
	}
	values = append(values, limit+1)
	rows, err := Collect(h.db, "SELECT "+activityColumns+" FROM activity WHERE "+joinAnd(clauses)+
		" ORDER BY created_at DESC, id DESC LIMIT ?", scanActivity, values...)
	if err != nil {
		return nil, err
	}
	page := rows
	if len(page) > limit {
		page = page[:limit]
	}
	views := make([]ActivityView, 0, len(page))
	for _, row := range page {
		views = append(views, toActivityView(row))
	}
	var nextCursor *string
	if len(rows) > limit && len(page) > 0 {
		nextCursor = strPointer(page[len(page)-1].ID)
	}
	return &ActivityPage{Activity: views, NextCursor: nextCursor}, nil
}
