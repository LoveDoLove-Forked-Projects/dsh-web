package hub

// Questions: the host asks, the first member answer wins, an admin or the asking
// host withdraws, and a pending question past its TTL expires.

import "strings"

const (
	// QuestionTextLimitBytes is section 11's question text cap.
	QuestionTextLimitBytes = 32_768
	// QuestionTTLMS is section 13's question lifetime.
	QuestionTTLMS = 86_400_000
)

var questionStatuses = map[string]bool{"pending": true, "answered": true, "dismissed": true, "expired": true}

// FindQuestion resolves a question of one team.
func (h *Hub) FindQuestion(teamID, questionID string) (*Question, error) {
	question, err := scanQuestion(h.db.QueryRow(
		"SELECT "+questionColumns+" FROM questions WHERE id = ? AND team_id = ?", questionID, teamID))
	if err == errNoRows {
		return nil, FailWith(CodeNotFound, "Question not found on this team.",
			map[string]any{"question_id": questionID})
	}
	if err != nil {
		return nil, err
	}
	return question, nil
}

func parseQuestionOptions(raw []any, present bool) (any, error) {
	if !present {
		return nil, nil
	}
	options := make([]map[string]any, 0, len(raw))
	for _, entry := range raw {
		record, ok := entry.(map[string]any)
		if !ok {
			return nil, FailWith(CodeValidationFailed,
				"Every option must be an object with a label.", map[string]any{"field": "options"})
		}
		label, ok := record["label"].(string)
		if !ok || label == "" {
			return nil, FailWith(CodeValidationFailed,
				"Every option needs a non-empty label.", map[string]any{"field": "options"})
		}
		option := map[string]any{"label": label}
		if description, exists := record["description"]; exists {
			text, ok := description.(string)
			if !ok {
				return nil, FailWith(CodeValidationFailed,
					"An option description must be a string.", map[string]any{"field": "options"})
			}
			option["description"] = text
		}
		options = append(options, option)
	}
	return options, nil
}

// questionRecipients is section 6 routing: the issue reviewer, plus the human
// assignee when there is one.
func questionRecipients(issue *Issue) []string {
	recipients := make([]string, 0, 2)
	seen := map[string]bool{}
	if issue.ReviewerMemberID != nil {
		recipients = append(recipients, *issue.ReviewerMemberID)
		seen[*issue.ReviewerMemberID] = true
	}
	if deref(issue.AssigneeType) == "member" && issue.AssigneeMemberID != nil && !seen[*issue.AssigneeMemberID] {
		recipients = append(recipients, *issue.AssigneeMemberID)
	}
	return recipients
}

// CreateQuestion records a question from a running execution.
func (h *Hub) CreateQuestion(teamID string, host *Principal, issueID, text string, options []any,
	hasOptions, multiSelect bool, now int64) (*Question, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if deref(issue.AssigneeType) != "agent" || issue.AssigneeAgentID == nil {
		return nil, FailWith(CodeHostMismatch, "This issue is not assigned to an agent.",
			map[string]any{"issue_id": issueID})
	}
	agent, err := h.FindAgent(teamID, *issue.AssigneeAgentID)
	if err != nil {
		return nil, err
	}
	if agent == nil || agent.HostID != host.Host.ID {
		return nil, FailWith(CodeHostMismatch, "The assigned agent belongs to another host.",
			map[string]any{"issue_id": issueID})
	}
	if issue.Status != "running" {
		return nil, FailWith(CodeInvalidState,
			"A question can only come from a running execution.", map[string]any{"status": issue.Status})
	}
	if err := AssertBytes(text, QuestionTextLimitBytes, "question_text"); err != nil {
		return nil, err
	}
	parsed, err := parseQuestionOptions(options, hasOptions)
	if err != nil {
		return nil, err
	}
	var optionsJSON any
	if parsed != nil {
		encoded, err := marshalJSON(parsed)
		if err != nil {
			return nil, err
		}
		optionsJSON = encoded
	}
	multi := int64(0)
	if multiSelect {
		multi = 1
	}
	question := &Question{
		ID: NewID("ques", now), TeamID: teamID, IssueID: issueID, HostID: host.Host.ID,
		AgentID: agent.ID, QuestionText: text, OptionsJSON: nil, MultiSelect: multi,
		Status: "pending", CreatedAt: now, ExpiresAt: now + QuestionTTLMS,
	}
	if text, ok := optionsJSON.(string); ok {
		question.OptionsJSON = &text
	}
	_, err = h.db.Exec(
		`INSERT INTO questions (id, team_id, issue_id, host_id, agent_id, question_text,
		 options_json, multi_select, status, first_responder_member_id, answer_json, answered_at,
		 created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
		question.ID, question.TeamID, question.IssueID, question.HostID, question.AgentID,
		question.QuestionText, question.OptionsJSON, question.MultiSelect, question.Status,
		question.CreatedAt, question.ExpiresAt)
	if err != nil {
		return nil, err
	}
	if err := h.recordActivity(teamID, issueID, "question.created",
		ActivityActor{Kind: "agent", AgentID: agent.ID, HostID: host.Host.ID},
		map[string]any{"question_id": question.ID}, now); err != nil {
		return nil, err
	}
	if err := h.publish(teamID, []ChannelEvent{{
		Event: "question.created", Payload: map[string]any{"question": toQuestionView(question)},
	}}); err != nil {
		return nil, err
	}
	recipients := questionRecipients(issue)
	if len(recipients) > 0 {
		if err := h.sendPush(recipients, PushNotification{
			TeamID: teamID, IssueID: issueID, EventType: "question_asked",
			Body: questionAskedAlert(agent.Name, issue.Number, text), QuestionID: question.ID,
		}, now); err != nil {
			return nil, err
		}
	}
	return question, nil
}

// AnswerQuestion records the first answer. A conditional UPDATE is the arbiter,
// so two simultaneous answers cannot both be recorded.
func (h *Hub) AnswerQuestion(teamID string, actor *Principal, questionID string, selected []any,
	hasSelected bool, custom string, hasCustom bool, now int64) error {
	question, err := h.FindQuestion(teamID, questionID)
	if err != nil {
		return err
	}
	if question.Status == "answered" {
		return FailWith(CodeQuestionAnswered, "Another member already answered this question.",
			map[string]any{"first_responder_member_id": question.FirstResponderMemberID})
	}
	if question.Status != "pending" {
		return FailWith(CodeQuestionNotPending, "The question is "+question.Status+".", map[string]any{"status": question.Status})
	}
	selection := make([]string, 0)
	if hasSelected {
		for _, value := range selected {
			text, ok := value.(string)
			if !ok {
				return FailWith(CodeValidationFailed, "selected must be an array of strings.",
					map[string]any{"field": "selected"})
			}
			selection = append(selection, text)
		}
	}
	if hasCustom && strings.TrimSpace(custom) == "" {
		hasCustom = false
	}
	if len(selection) == 0 && !hasCustom {
		return FailWith(CodeValidationFailed,
			"An answer needs at least one selected option or a custom text.",
			map[string]any{"fields": []string{"selected", "custom"}})
	}
	answer := map[string]any{"selected": selection}
	if hasCustom {
		answer["custom"] = custom
	}
	encoded, err := marshalJSON(answer)
	if err != nil {
		return err
	}
	result, err := h.db.Exec(
		"UPDATE questions SET status = 'answered', first_responder_member_id = ?, answer_json = ?, "+
			"answered_at = ? WHERE id = ? AND status = 'pending'",
		actor.Member.ID, encoded, now, questionID)
	if err != nil {
		return err
	}
	if changed(result) == 0 {
		return FailWith(CodeQuestionAnswered, "Another member answered this question first.",
			map[string]any{"question_id": questionID})
	}
	if err := h.recordActivity(teamID, question.IssueID, "question.answered",
		ActivityActor{Kind: "member", MemberID: actor.Member.ID},
		map[string]any{"question_id": questionID, "answer": answer}, now); err != nil {
		return err
	}
	return h.publish(teamID, []ChannelEvent{{
		Event: "question.answered",
		Payload: map[string]any{
			"question_id": questionID, "answer": answer, "responder_member_id": actor.Member.ID,
		},
	}})
}

// WithdrawQuestion lets the asking host or an admin dismiss a pending question.
func (h *Hub) WithdrawQuestion(teamID string, principal *Principal, questionID string, now int64) error {
	question, err := h.FindQuestion(teamID, questionID)
	if err != nil {
		return err
	}
	if principal.Kind == "host" {
		if question.HostID != principal.Host.ID {
			return FailWith(CodeHostMismatch, "This host did not ask this question.",
				map[string]any{"question_id": questionID})
		}
	} else if principal.Member.Role != "admin" {
		return FailWith(CodeForbidden, "Only the asking Host or an admin can withdraw a question.",
			map[string]any{"question_id": questionID})
	}
	if question.Status != "pending" {
		return FailWith(CodeQuestionNotPending, "The question is "+question.Status+".", map[string]any{"status": question.Status})
	}
	result, err := h.db.Exec("UPDATE questions SET status = 'dismissed' WHERE id = ? AND status = 'pending'", questionID)
	if err != nil {
		return err
	}
	if changed(result) == 0 {
		return FailWith(CodeQuestionNotPending, "The question is no longer pending.",
			map[string]any{"question_id": questionID})
	}
	var actor ActivityActor
	if principal.Kind == "host" {
		actor = ActivityActor{Kind: "host", HostID: principal.Host.ID}
	} else {
		actor = ActivityActor{Kind: "member", MemberID: principal.Member.ID}
	}
	if err := h.recordActivity(teamID, question.IssueID, "question.withdrawn", actor,
		map[string]any{"question_id": questionID}, now); err != nil {
		return err
	}
	return h.publish(teamID, []ChannelEvent{{
		Event: "question.withdrawn", Payload: map[string]any{"question_id": questionID, "issue_id": question.IssueID},
	}})
}

// ListQuestions answers the list route, newest first.
func (h *Hub) ListQuestions(teamID string, status, issueID string, hasStatus, hasIssue bool) ([]QuestionView, error) {
	clauses := []string{"team_id = ?"}
	values := []any{teamID}
	if hasStatus {
		if !questionStatuses[status] {
			return nil, FailWith(CodeValidationFailed, "Unknown question status "+status+".",
				map[string]any{"field": "status"})
		}
		clauses = append(clauses, "status = ?")
		values = append(values, status)
	}
	if hasIssue {
		clauses = append(clauses, "issue_id = ?")
		values = append(values, issueID)
	}
	rows, err := Collect(h.db, "SELECT "+questionColumns+" FROM questions WHERE "+
		joinAnd(clauses)+" ORDER BY created_at DESC", scanQuestion, values...)
	if err != nil {
		return nil, err
	}
	views := make([]QuestionView, 0, len(rows))
	for _, row := range rows {
		views = append(views, toQuestionView(row))
	}
	return views, nil
}

// SweepExpiredQuestions expires every pending question past its TTL.
func (h *Hub) SweepExpiredQuestions(teamID string, now int64) (int, error) {
	questions, err := Collect(h.db,
		"SELECT "+questionColumns+" FROM questions WHERE team_id = ? AND status = 'pending' AND expires_at <= ?",
		scanQuestion, teamID, now)
	if err != nil {
		return 0, err
	}
	expired := 0
	for _, question := range questions {
		result, err := h.db.Exec("UPDATE questions SET status = 'expired' WHERE id = ? AND status = 'pending'", question.ID)
		if err != nil {
			return 0, err
		}
		if changed(result) == 0 {
			continue
		}
		expired++
		if err := h.recordActivity(teamID, question.IssueID, "question.expired", ActivityActor{Kind: "system"},
			map[string]any{"question_id": question.ID}, now); err != nil {
			return 0, err
		}
		if err := h.publish(teamID, []ChannelEvent{{
			Event:   "question.expired",
			Payload: map[string]any{"question_id": question.ID, "issue_id": question.IssueID},
		}}); err != nil {
			return 0, err
		}
	}
	return expired, nil
}
