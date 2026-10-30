package hub

// The issue state machine: creation, assignment, the human-driven transitions,
// review decisions and the audit trail each one writes.

import (
	"sort"
	"strings"
)

const (
	// IssueTitleLimit is section 11's title cap, in characters.
	IssueTitleLimit = 256
	// IssueDescriptionLimitBytes is section 13's description cap.
	IssueDescriptionLimitBytes = 65_536
	// ExecutionSummaryLimit is section 13's settlement summary cap.
	ExecutionSummaryLimit = 4_000
)

var issueStatuses = map[string]bool{
	"todo": true, "assigned": true, "waiting_host": true, "running": true,
	"in_review": true, "done": true, "canceled": true, "failed": true,
}

func isIssueStatus(value string) bool { return issueStatuses[value] }

// FindIssue resolves an issue of one team, or refuses with ISSUE_NOT_FOUND.
func (h *Hub) FindIssue(teamID, issueID string) (*Issue, error) {
	issue, err := queryIssue(h.db, "SELECT "+issueColumns+" FROM issues WHERE id = ? AND team_id = ?",
		issueID, teamID)
	if err != nil {
		return nil, err
	}
	if issue == nil {
		return nil, FailWith(CodeIssueNotFound, "Issue not found on this team.",
			map[string]any{"issue_id": issueID})
	}
	return issue, nil
}

func (h *Hub) findMember(teamID, memberID string) (*Member, error) {
	return queryMember(h.db, "SELECT "+memberColumns+" FROM members WHERE id = ? AND team_id = ?",
		memberID, teamID)
}

func (h *Hub) nextIssueNumber(teamID string) (int64, error) {
	var next int64
	if err := h.db.QueryRow("SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues WHERE team_id = ?",
		teamID).Scan(&next); err != nil {
		return 0, err
	}
	return next, nil
}

func updateIssueRow(db *DB, issueID string, patch map[string]any) error {
	if len(patch) == 0 {
		return nil
	}
	keys := make([]string, 0, len(patch))
	for key := range patch {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	assignments := make([]string, 0, len(keys))
	values := make([]any, 0, len(keys)+1)
	for _, key := range keys {
		assignments = append(assignments, key+" = ?")
		values = append(values, patch[key])
	}
	values = append(values, issueID)
	_, err := db.Exec("UPDATE issues SET "+strings.Join(assignments, ", ")+" WHERE id = ?", values...)
	return err
}

func (h *Hub) validateAssignee(teamID, assigneeType, assigneeID string) (memberID *string, agentID *string, err error) {
	if assigneeType == "member" {
		member, err := h.findMember(teamID, assigneeID)
		if err != nil {
			return nil, nil, err
		}
		if member == nil || member.Status == "suspended" {
			return nil, nil, FailWith(CodeValidationFailed,
				"assignee_id is not an active member of this team.", map[string]any{"field": "assignee_id"})
		}
		return strPointer(member.ID), nil, nil
	}
	agent, err := h.FindAgent(teamID, assigneeID)
	if err != nil {
		return nil, nil, err
	}
	if agent == nil {
		return nil, nil, FailWith(CodeValidationFailed,
			"assignee_id is not an agent of this team.", map[string]any{"field": "assignee_id"})
	}
	return nil, strPointer(agent.ID), nil
}

// CreateIssueBody is the POST body after the router's field extraction.
type CreateIssueBody struct {
	Title            string
	Description      string
	AssigneeType     string
	AssigneeID       string
	HasAssigneeType  bool
	ReviewerMemberID string
	HasReviewer      bool
}

// CreateIssue writes one card and the audit rows the matrix requires.
func (h *Hub) CreateIssue(teamID string, actor *Principal, body CreateIssueBody, now int64) (*Issue, error) {
	if err := AssertChars(body.Title, IssueTitleLimit, "title"); err != nil {
		return nil, err
	}
	if err := AssertBytes(body.Description, IssueDescriptionLimitBytes, "description"); err != nil {
		return nil, err
	}
	var assigneeType *string
	var assigneeMemberID, assigneeAgentID *string
	if body.HasAssigneeType {
		if body.AssigneeType != "member" && body.AssigneeType != "agent" {
			return nil, FailWith(CodeValidationFailed, "assignee_type must be 'member' or 'agent'.",
				map[string]any{"field": "assignee_type"})
		}
		if body.AssigneeID == "" {
			return nil, FailWith(CodeValidationFailed,
				"assignee_id is required when assignee_type is set.", map[string]any{"field": "assignee_id"})
		}
		resolvedMember, resolvedAgent, err := h.validateAssignee(teamID, body.AssigneeType, body.AssigneeID)
		if err != nil {
			return nil, err
		}
		assigneeType = strPointer(body.AssigneeType)
		assigneeMemberID = resolvedMember
		assigneeAgentID = resolvedAgent
	}
	var reviewerMemberID *string
	if body.HasReviewer && body.ReviewerMemberID != "" {
		reviewer, err := h.findMember(teamID, body.ReviewerMemberID)
		if err != nil {
			return nil, err
		}
		if reviewer == nil {
			return nil, FailWith(CodeValidationFailed,
				"reviewer_member_id is not a member of this team.", map[string]any{"field": "reviewer_member_id"})
		}
		reviewerMemberID = strPointer(reviewer.ID)
	}
	// Section 13 default reviewer: an agent-executed issue always has a human
	// reviewer, and the creator is the default.
	if assigneeType != nil && *assigneeType == "agent" && reviewerMemberID == nil {
		reviewerMemberID = strPointer(actor.Member.ID)
	}

	status := "todo"
	if assigneeType != nil {
		switch *assigneeType {
		case "member":
			status = "assigned"
		case "agent":
			online, err := h.agentHostOnline(deref(assigneeAgentID))
			if err != nil {
				return nil, err
			}
			if online {
				status = "assigned"
			} else {
				status = "waiting_host"
			}
		}
	}
	number, err := h.nextIssueNumber(teamID)
	if err != nil {
		return nil, err
	}
	issue := &Issue{
		ID: NewID("issue", now), TeamID: teamID, Number: number, Title: body.Title,
		Description: body.Description, Status: status, CreatorMemberID: actor.Member.ID,
		AssigneeType: assigneeType, AssigneeMemberID: assigneeMemberID, AssigneeAgentID: assigneeAgentID,
		ReviewerMemberID: reviewerMemberID, CreatedAt: now, UpdatedAt: now,
	}
	_, err = h.db.Exec(
		`INSERT INTO issues (id, team_id, issue_number, title, description, status,
		 creator_member_id, assignee_type, assignee_member_id, assignee_agent_id, reviewer_member_id,
		 created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		issue.ID, issue.TeamID, issue.Number, issue.Title, issue.Description, issue.Status,
		issue.CreatorMemberID, issue.AssigneeType, issue.AssigneeMemberID, issue.AssigneeAgentID,
		issue.ReviewerMemberID, issue.CreatedAt, issue.UpdatedAt)
	if err != nil {
		return nil, err
	}

	if err := h.recordActivity(issue.TeamID, issue.ID, "issue.created",
		ActivityActor{Kind: "member", MemberID: actor.Member.ID},
		map[string]any{"status": issue.Status, "assignee_type": issue.AssigneeType}, now); err != nil {
		return nil, err
	}
	if assigneeType != nil {
		assignee := assigneeMemberID
		if assignee == nil {
			assignee = assigneeAgentID
		}
		if err := h.recordActivity(issue.TeamID, issue.ID, "issue.assigned",
			ActivityActor{Kind: "member", MemberID: actor.Member.ID},
			map[string]any{"assignee_type": *assigneeType, "assignee_id": deref(assignee)}, now); err != nil {
			return nil, err
		}
	}
	if status == "waiting_host" {
		if err := h.recordActivity(issue.TeamID, issue.ID, "issue.waiting_host",
			ActivityActor{Kind: "system"},
			map[string]any{"assignee_agent_id": issue.AssigneeAgentID}, now); err != nil {
			return nil, err
		}
	}
	if err := h.publish(teamID, []ChannelEvent{{
		Event: "issue.created", Payload: map[string]any{"issue": toIssueView(issue)},
	}}); err != nil {
		return nil, err
	}
	if assigneeMemberID != nil {
		if err := h.pushAssigned(issue, *assigneeMemberID, now); err != nil {
			return nil, err
		}
	}
	return issue, nil
}

// ListIssueOptions are the query filters the list route accepts.
type ListIssueOptions struct {
	Statuses        []string
	Assignee        string
	HasAssignee     bool
	AssigneeHostID  string
	HasAssigneeHost bool
	RestrictToHost  string
	HasRestrict     bool
}

// ListIssues answers the queue, in issue-number order.
func (h *Hub) ListIssues(teamID string, options ListIssueOptions) ([]*Issue, error) {
	clauses := []string{"team_id = ?"}
	values := []any{teamID}
	if len(options.Statuses) > 0 {
		for _, status := range options.Statuses {
			if !isIssueStatus(status) {
				return nil, FailWith(CodeValidationFailed, "Unknown status value "+status+".",
					map[string]any{"field": "status"})
			}
		}
		marks := make([]string, 0, len(options.Statuses))
		for _, status := range options.Statuses {
			marks = append(marks, "?")
			values = append(values, status)
		}
		clauses = append(clauses, "status IN ("+strings.Join(marks, ", ")+")")
	}
	if options.HasAssignee {
		clauses = append(clauses, "(assignee_member_id = ? OR assignee_agent_id = ?)")
		values = append(values, options.Assignee, options.Assignee)
	}
	hostFilter := ""
	if options.HasRestrict {
		hostFilter = options.RestrictToHost
	} else if options.HasAssigneeHost {
		hostFilter = options.AssigneeHostID
	}
	if hostFilter != "" {
		clauses = append(clauses, "assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)")
		values = append(values, hostFilter)
	}
	return Collect(h.db, "SELECT "+issueColumns+" FROM issues WHERE "+strings.Join(clauses, " AND ")+
		" ORDER BY issue_number", scanIssue, values...)
}

func (h *Hub) publishIssueUpdate(teamID string, issue *Issue, changedFields []string, oldStatus string) error {
	events := []ChannelEvent{{
		Event:   "issue.updated",
		Payload: map[string]any{"issue": toIssueView(issue), "changed_fields": changedFields},
	}}
	if oldStatus != "" && oldStatus != issue.Status {
		events = append(events, ChannelEvent{
			Event: "issue.status_changed",
			Payload: map[string]any{
				"issue_id": issue.ID, "old_status": oldStatus, "new_status": issue.Status,
			},
		})
	}
	return h.publish(teamID, events)
}

func (h *Hub) pushAssigned(issue *Issue, memberID string, now int64) error {
	return h.sendPush([]string{memberID}, PushNotification{
		TeamID: issue.TeamID, IssueID: issue.ID, EventType: "assigned",
		Body: assignedAlert(issue.Number, issue.Title),
	}, now)
}

func (h *Hub) pushReviewRequested(issue *Issue, now int64) error {
	if issue.ReviewerMemberID == nil {
		return nil
	}
	return h.sendPush([]string{*issue.ReviewerMemberID}, PushNotification{
		TeamID: issue.TeamID, IssueID: issue.ID, EventType: "review_requested",
		Body: reviewRequestedAlert(issue.Number, issue.Title),
	}, now)
}

// PatchIssueBody is the PATCH body after the router's field extraction.
type PatchIssueBody struct {
	Title            string
	HasTitle         bool
	Description      string
	HasDescription   bool
	AssigneeType     string
	AssigneeID       string
	HasAssigneeType  bool
	ReviewerMemberID string
	HasReviewer      bool
	Status           string
	HasStatus        bool
}

type issueActivity struct {
	Type    string
	Payload map[string]any
}

func (h *Hub) assertAssigneeOrAdmin(issue *Issue, actor *Principal) error {
	if actor.Member.Role == "admin" {
		return nil
	}
	if issue.AssigneeMemberID != nil && *issue.AssigneeMemberID == actor.Member.ID {
		return nil
	}
	return FailWith(CodeForbidden, "Only the assignee or an admin can move this issue to "+issue.Status+".",
		map[string]any{"issue_id": issue.ID, "assignee_member_id": issue.AssigneeMemberID})
}

func (h *Hub) assertReviewer(issue *Issue, actor *Principal) error {
	if actor.Member.Role == "admin" {
		return nil
	}
	if issue.ReviewerMemberID != nil && *issue.ReviewerMemberID == actor.Member.ID {
		return nil
	}
	return FailWith(CodeForbidden, "Only the reviewer or an admin can decide this review.",
		map[string]any{"issue_id": issue.ID})
}

// PatchIssue applies the section 4 matrix to the human-driven transitions and to
// assignment changes; every branch either applies one row or rejects.
func (h *Hub) PatchIssue(teamID string, actor *Principal, issueID string, body PatchIssueBody, now int64) (*Issue, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	patch := map[string]any{}
	changed := make([]string, 0)
	activities := make([]issueActivity, 0)
	pushToMember := ""
	requestReview := false

	if body.HasTitle {
		if err := AssertChars(body.Title, IssueTitleLimit, "title"); err != nil {
			return nil, err
		}
		patch["title"] = body.Title
		changed = append(changed, "title")
	}
	if body.HasDescription {
		if err := AssertBytes(body.Description, IssueDescriptionLimitBytes, "description"); err != nil {
			return nil, err
		}
		patch["description"] = body.Description
		changed = append(changed, "description")
	}
	if body.HasReviewer {
		if body.ReviewerMemberID == "" {
			patch["reviewer_member_id"] = nil
		} else {
			reviewer, err := h.findMember(teamID, body.ReviewerMemberID)
			if err != nil {
				return nil, err
			}
			if reviewer == nil {
				return nil, FailWith(CodeValidationFailed,
					"reviewer_member_id is not a member of this team.",
					map[string]any{"field": "reviewer_member_id"})
			}
			patch["reviewer_member_id"] = reviewer.ID
		}
		changed = append(changed, "reviewer_member_id")
	}

	if body.HasAssigneeType {
		switch issue.Status {
		case "running", "in_review", "done", "canceled":
			return nil, FailWith(CodeInvalidState,
				"The assignee cannot change while the issue is "+issue.Status+".", map[string]any{"status": issue.Status})
		}
		if body.AssigneeType != "member" && body.AssigneeType != "agent" {
			return nil, FailWith(CodeValidationFailed, "assignee_type must be 'member' or 'agent'.",
				map[string]any{"field": "assignee_type"})
		}
		if body.AssigneeID == "" {
			return nil, FailWith(CodeValidationFailed,
				"assignee_id is required when assignee_type is set.", map[string]any{"field": "assignee_id"})
		}
		memberID, agentID, err := h.validateAssignee(teamID, body.AssigneeType, body.AssigneeID)
		if err != nil {
			return nil, err
		}
		patch["assignee_type"] = body.AssigneeType
		patch["assignee_member_id"] = memberID
		patch["assignee_agent_id"] = agentID
		changed = append(changed, "assignee_type", "assignee_member_id", "assignee_agent_id")
		if body.AssigneeType == "member" {
			patch["status"] = "assigned"
			changed = append(changed, "status")
			pushToMember = deref(memberID)
		} else {
			online, err := h.agentHostOnline(deref(agentID))
			if err != nil {
				return nil, err
			}
			if online {
				patch["status"] = "assigned"
			} else {
				patch["status"] = "waiting_host"
			}
			changed = append(changed, "status")
			effectiveReviewer := issue.ReviewerMemberID
			if value, ok := patch["reviewer_member_id"].(string); ok {
				effectiveReviewer = &value
			}
			if effectiveReviewer == nil {
				patch["reviewer_member_id"] = actor.Member.ID
				changed = append(changed, "reviewer_member_id")
			}
		}
		activities = append(activities, issueActivity{Type: "issue.assigned", Payload: map[string]any{
			"assignee_type": body.AssigneeType, "assignee_id": body.AssigneeID,
		}})
	}

	if body.HasStatus {
		requested := body.Status
		if !isIssueStatus(requested) {
			return nil, FailWith(CodeValidationFailed, "Unknown status value "+requested+".",
				map[string]any{"field": "status"})
		}
		switch requested {
		case "canceled":
			if issue.Status == "done" || issue.Status == "canceled" {
				return nil, FailWith(CodeInvalidState, "The issue is already "+issue.Status+".",
					map[string]any{"status": issue.Status})
			}
			patch["status"] = "canceled"
			patch["lease_token"] = nil
			patch["lease_expires_at"] = nil
			activities = append(activities, issueActivity{Type: "issue.canceled",
				Payload: map[string]any{"previous_status": issue.Status}})
		case "in_review":
			reviewer := issue.ReviewerMemberID
			if value, ok := patch["reviewer_member_id"].(string); ok {
				reviewer = &value
			}
			if issue.Status != "assigned" || deref(issue.AssigneeType) != "member" || reviewer == nil {
				return nil, FailWith(CodeInvalidState,
					"Submitting for review requires an assigned member issue with a reviewer.",
					map[string]any{"status": issue.Status})
			}
			if err := h.assertAssigneeOrAdmin(issue, actor); err != nil {
				return nil, err
			}
			patch["status"] = "in_review"
			activities = append(activities, issueActivity{Type: "issue.submitted_for_review", Payload: map[string]any{}})
			requestReview = true
		case "done":
			reviewer := issue.ReviewerMemberID
			if value, ok := patch["reviewer_member_id"].(string); ok {
				reviewer = &value
			}
			if issue.Status != "assigned" || deref(issue.AssigneeType) != "member" || reviewer != nil {
				return nil, FailWith(CodeInvalidState,
					"Completing directly requires an assigned member issue with no reviewer.",
					map[string]any{"status": issue.Status})
			}
			if err := h.assertAssigneeOrAdmin(issue, actor); err != nil {
				return nil, err
			}
			patch["status"] = "done"
			activities = append(activities, issueActivity{Type: "issue.completed", Payload: map[string]any{}})
		case "assigned":
			if issue.Status != "failed" {
				return nil, FailWith(CodeInvalidState, "Only a failed issue can be retried.",
					map[string]any{"status": issue.Status})
			}
			// Review R2: the retry starts from a clean slate, so the failed run's
			// attempt and lease cannot be reused or settled against.
			patch["status"] = "assigned"
			patch["failure_error"] = nil
			patch["execution_attempt_id"] = nil
			patch["lease_token"] = nil
			patch["lease_expires_at"] = nil
			patch["executing_host_id"] = nil
			activities = append(activities, issueActivity{Type: "issue.retried", Payload: map[string]any{}})
		default:
			return nil, FailWith(CodeInvalidState,
				"The status "+requested+" is not a human-driven transition.", map[string]any{"status": requested})
		}
		if !containsString(changed, "status") {
			changed = append(changed, "status")
		}
	}

	if len(changed) == 0 {
		return issue, nil
	}
	patch["updated_at"] = now
	if err := updateIssueRow(h.db, issueID, patch); err != nil {
		return nil, err
	}
	updated, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	for _, activity := range activities {
		if err := h.recordActivity(teamID, issueID, activity.Type,
			ActivityActor{Kind: "member", MemberID: actor.Member.ID}, activity.Payload, now); err != nil {
			return nil, err
		}
	}
	if err := h.publishIssueUpdate(teamID, updated, changed, issue.Status); err != nil {
		return nil, err
	}
	if pushToMember != "" {
		if err := h.pushAssigned(updated, pushToMember, now); err != nil {
			return nil, err
		}
	}
	if requestReview {
		if err := h.pushReviewRequested(updated, now); err != nil {
			return nil, err
		}
	}
	return updated, nil
}

// ApproveReview is section 8 approval: in_review to done.
func (h *Hub) ApproveReview(teamID string, actor *Principal, issueID string, now int64) (*Issue, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if issue.Status != "in_review" {
		return nil, FailWith(CodeInvalidState, "Only an issue in review can be approved.",
			map[string]any{"status": issue.Status})
	}
	if err := h.assertReviewer(issue, actor); err != nil {
		return nil, err
	}
	if err := updateIssueRow(h.db, issueID, map[string]any{
		"status": "done", "lease_token": nil, "lease_expires_at": nil, "updated_at": now,
	}); err != nil {
		return nil, err
	}
	updated, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if err := h.recordActivity(teamID, issueID, "issue.approved",
		ActivityActor{Kind: "member", MemberID: actor.Member.ID}, map[string]any{}, now); err != nil {
		return nil, err
	}
	if err := h.publishIssueUpdate(teamID, updated, []string{"status"}, issue.Status); err != nil {
		return nil, err
	}
	return updated, nil
}

// RejectReview stores the rework instructions and hands the issue back to the
// bound host. The hub never starts the rework itself.
func (h *Hub) RejectReview(teamID string, actor *Principal, issueID, instructions string, now int64) (*Issue, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if issue.Status != "in_review" {
		return nil, FailWith(CodeInvalidState, "Only an issue in review can be rejected.",
			map[string]any{"status": issue.Status})
	}
	if err := h.assertReviewer(issue, actor); err != nil {
		return nil, err
	}
	if strings.TrimSpace(instructions) == "" {
		return nil, FailWith(CodeValidationFailed, "instructions are required.",
			map[string]any{"field": "instructions"})
	}
	var agent *Agent
	if issue.AssigneeAgentID != nil {
		agent, err = h.FindAgent(teamID, *issue.AssigneeAgentID)
		if err != nil {
			return nil, err
		}
	}
	hostID := ""
	if agent != nil {
		hostID = agent.HostID
	}
	nextStatus := "assigned"
	if hostID != "" {
		host, err := queryHost(h.db, "SELECT "+hostColumns+" FROM hosts WHERE id = ?", hostID)
		if err != nil {
			return nil, err
		}
		if host == nil || host.Status != "online" {
			nextStatus = "waiting_host"
		}
	}
	if err := updateIssueRow(h.db, issueID, map[string]any{
		"status": nextStatus, "rework_instructions": instructions, "lease_token": nil,
		"lease_expires_at": nil, "executing_host_id": nil, "execution_attempt_id": nil, "updated_at": now,
	}); err != nil {
		return nil, err
	}
	updated, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if err := h.recordActivity(teamID, issueID, "issue.rework_requested",
		ActivityActor{Kind: "member", MemberID: actor.Member.ID},
		map[string]any{"instructions": instructions, "status": nextStatus}, now); err != nil {
		return nil, err
	}
	events := []ChannelEvent{
		{Event: "issue.updated", Payload: map[string]any{
			"issue": toIssueView(updated), "changed_fields": []string{"status", "rework_instructions"},
		}},
		{Event: "issue.status_changed", Payload: map[string]any{
			"issue_id": issueID, "old_status": issue.Status, "new_status": nextStatus,
		}},
	}
	if hostID != "" {
		events = append(events, ChannelEvent{
			Event:        "issue.rework",
			Payload:      map[string]any{"issue_id": issueID, "instructions": instructions, "reviewer_member_id": actor.Member.ID},
			TargetHostID: strPointer(hostID),
		})
	}
	if err := h.publish(teamID, events); err != nil {
		return nil, err
	}
	return updated, nil
}

// SummaryWithinLimit applies the settlement summary cap.
func SummaryWithinLimit(summary string, present bool) (*string, error) {
	if !present {
		return nil, nil
	}
	if err := AssertChars(summary, ExecutionSummaryLimit, "summary"); err != nil {
		return nil, err
	}
	return strPointer(summary), nil
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
