package hub

// The lease state machine of PROTOCOL.md section 5, identical to the Worker's:
// claim is one conditional UPDATE, renewal is the only place an expired lease is
// refused, and settlement is idempotent per execution attempt.

// LeaseDurationMS is section 13's lease length.
const LeaseDurationMS = 60_000

func (h *Hub) assertHostOwnsIssue(host *Principal, issue *Issue) (*Agent, error) {
	if deref(issue.AssigneeType) != "agent" || issue.AssigneeAgentID == nil {
		return nil, FailWith(CodeHostMismatch, "This issue is not assigned to an agent.",
			map[string]any{"issue_id": issue.ID})
	}
	agent, err := h.FindAgent(issue.TeamID, *issue.AssigneeAgentID)
	if err != nil {
		return nil, err
	}
	if agent == nil || agent.HostID != host.Host.ID {
		return nil, FailWith(CodeHostMismatch, "The assigned agent belongs to another host.",
			map[string]any{"issue_id": issue.ID})
	}
	return agent, nil
}

// ClaimIssue applies supplement A4.4: the transition is one conditional UPDATE,
// so two hosts racing for the same card cannot both win. The reconnect variant
// keeps the attempt and lease the caller already owns.
func (h *Hub) ClaimIssue(teamID string, host *Principal, issueID, presentedAttempt, presentedLease string,
	hasAttempt, hasLease bool, now int64) (*ClaimResult, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if _, err := h.assertHostOwnsIssue(host, issue); err != nil {
		return nil, err
	}
	expiresAt := now + LeaseDurationMS
	reconnecting := hasAttempt && presentedAttempt != "" && hasLease &&
		issue.LeaseToken != nil && presentedLease == *issue.LeaseToken &&
		issue.ExecutionAttemptID != nil && presentedAttempt == *issue.ExecutionAttemptID
	leaseToken := NewUUID()
	attemptID := NewUUID()
	if reconnecting {
		leaseToken = *issue.LeaseToken
		attemptID = *issue.ExecutionAttemptID
	}
	result, err := h.db.Exec(
		"UPDATE issues SET status = 'running', lease_token = ?, lease_expires_at = ?, "+
			"execution_attempt_id = ?, executing_host_id = ?, updated_at = ? "+
			"WHERE id = ? AND team_id = ? AND status IN ('assigned', 'waiting_host') "+
			"AND assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)",
		leaseToken, expiresAt, attemptID, host.Host.ID, now, issueID, teamID, host.Host.ID)
	if err != nil {
		return nil, err
	}
	if changed(result) == 0 {
		if reconnecting {
			continued, err := h.db.Exec(
				"UPDATE issues SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND team_id = ? "+
					"AND status = 'running' AND execution_attempt_id = ? AND lease_token = ? "+
					"AND assignee_agent_id IN (SELECT id FROM agents WHERE host_id = ?)",
				expiresAt, now, issueID, teamID, presentedAttempt, presentedLease, host.Host.ID)
			if err != nil {
				return nil, err
			}
			if changed(continued) > 0 {
				return &ClaimResult{LeaseToken: leaseToken, LeaseExpiresAt: expiresAt,
					ExecutionAttemptID: attemptID}, nil
			}
		}
		// The read above may predate a claim that won in the meantime, so the
		// reason is decided from the state the database holds now.
		current, err := h.FindIssue(teamID, issueID)
		if err != nil {
			return nil, err
		}
		if current.Status == "running" {
			return nil, FailWith(CodeLeaseHeldByOther,
				"Another execution attempt holds the active lease.",
				map[string]any{"lease_expires_at": current.LeaseExpiresAt})
		}
		return nil, FailWith(CodeInvalidState,
			"The issue is "+current.Status+" and cannot be claimed.", map[string]any{"status": current.Status})
	}
	if _, err := h.db.Exec("UPDATE agents SET status = 'busy', updated_at = ? WHERE id = ?",
		now, issue.AssigneeAgentID); err != nil {
		return nil, err
	}
	started, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return nil, err
	}
	if err := h.recordActivity(teamID, issueID, "issue.claimed",
		ActivityActor{Kind: "host", HostID: host.Host.ID},
		map[string]any{"execution_attempt_id": attemptID, "reconnected": reconnecting}, now); err != nil {
		return nil, err
	}
	if err := h.publish(teamID, []ChannelEvent{
		{Event: "issue.claimed", Payload: map[string]any{"issue_id": issueID, "executing_host_id": host.Host.ID}},
		{Event: "issue.status_changed", Payload: map[string]any{
			"issue_id": issueID, "old_status": issue.Status, "new_status": started.Status}},
		{Event: "issue.updated", Payload: map[string]any{
			"issue": toIssueView(started), "changed_fields": []string{"status", "lease_expires_at"}}},
	}); err != nil {
		return nil, err
	}
	return &ClaimResult{LeaseToken: leaseToken, LeaseExpiresAt: expiresAt, ExecutionAttemptID: attemptID}, nil
}

// RenewLease extends an unexpired lease by one lease duration. An expired lease
// is refused here, and the card steps back to waiting_host.
func (h *Hub) RenewLease(teamID string, host *Principal, issueID, leaseToken string, now int64) (int64, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return 0, err
	}
	if _, err := h.assertHostOwnsIssue(host, issue); err != nil {
		return 0, err
	}
	if issue.Status != "running" || issue.ExecutingHostID == nil || *issue.ExecutingHostID != host.Host.ID {
		return 0, FailWith(CodeLeaseExpired, "The issue is not running under this host.",
			map[string]any{"status": issue.Status})
	}
	if issue.LeaseToken == nil || *issue.LeaseToken != leaseToken {
		return 0, Fail(CodeLeaseExpired, "The lease token does not match the active lease.")
	}
	if issue.LeaseExpiresAt == nil || *issue.LeaseExpiresAt <= now {
		if err := h.expireLease(issue, now, "lease_expired"); err != nil {
			return 0, err
		}
		return 0, FailWith(CodeLeaseExpired, "The lease expired before this renewal.",
			map[string]any{"issue_id": issue.ID})
	}
	expiresAt := now + LeaseDurationMS
	if _, err := h.db.Exec("UPDATE issues SET lease_expires_at = ?, updated_at = ? WHERE id = ?",
		expiresAt, now, issue.ID); err != nil {
		return 0, err
	}
	return expiresAt, nil
}

// SettlementBody is the settle body after the router's field extraction.
type SettlementBody struct {
	Outcome              string
	HasOutcome           bool
	Summary              string
	HasSummary           bool
	Error                string
	HasError             bool
	VerificationEvidence any
	ExecutionAttemptID   string
	HasAttempt           bool
}

// SettleIssue writes the execution outcome back: success enters in_review,
// failure enters failed. A replay of the same attempt is a no-op.
func (h *Hub) SettleIssue(teamID string, host *Principal, issueID string, body SettlementBody, now int64) (string, error) {
	issue, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return "", err
	}
	if _, err := h.assertHostOwnsIssue(host, issue); err != nil {
		return "", err
	}
	if body.Outcome != "succeeded" && body.Outcome != "failed" {
		return "", FailWith(CodeValidationFailed, "outcome must be 'succeeded' or 'failed'.",
			map[string]any{"field": "outcome"})
	}
	summary, err := SummaryWithinLimit(body.Summary, body.HasSummary)
	if err != nil {
		return "", err
	}
	attemptMatches := body.HasAttempt && issue.ExecutionAttemptID != nil &&
		body.ExecutionAttemptID == *issue.ExecutionAttemptID
	if body.HasAttempt && !attemptMatches {
		return "", FailWith(CodeLeaseExpired, "This execution attempt is not the one running the issue.",
			map[string]any{"execution_attempt_id": issue.ExecutionAttemptID})
	}
	if issue.Status == "in_review" || issue.Status == "failed" {
		if !body.HasAttempt || attemptMatches {
			return issue.Status, nil
		}
		return "", FailWith(CodeInvalidState, "The issue already settled under a different attempt.",
			map[string]any{"status": issue.Status})
	}
	reconnectWriteBack := issue.Status == "waiting_host" && attemptMatches
	if issue.Status != "running" && !reconnectWriteBack {
		return "", FailWith(CodeLeaseExpired, "The issue is not running.",
			map[string]any{"status": issue.Status})
	}
	leaseExpired := issue.LeaseExpiresAt != nil && *issue.LeaseExpiresAt <= now
	if leaseExpired && !attemptMatches {
		if err := h.expireLease(issue, now, "lease_expired"); err != nil {
			return "", err
		}
		return "", Fail(CodeLeaseExpired, "The lease expired before settlement.")
	}
	if issue.ExecutingHostID != nil && *issue.ExecutingHostID != host.Host.ID {
		return "", FailWith(CodeHostMismatch, "Another host is executing this issue.",
			map[string]any{"issue_id": issue.ID})
	}

	nextStatus := "in_review"
	if body.Outcome == "failed" {
		nextStatus = "failed"
	}
	var failureError any
	if body.Outcome == "failed" {
		if body.HasError {
			failureError = body.Error
		} else {
			failureError = "execution failed"
		}
	}
	var summaryValue any
	if summary != nil {
		summaryValue = *summary
	}
	if _, err := h.db.Exec(
		"UPDATE issues SET status = ?, execution_summary = ?, failure_error = ?, lease_token = NULL, "+
			"lease_expires_at = NULL, rework_instructions = NULL, updated_at = ? WHERE id = ?",
		nextStatus, summaryValue, failureError, now, issue.ID); err != nil {
		return "", err
	}
	if _, err := h.db.Exec("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?",
		now, issue.AssigneeAgentID); err != nil {
		return "", err
	}
	settled, err := h.FindIssue(teamID, issueID)
	if err != nil {
		return "", err
	}
	activityType := "issue.settled_in_review"
	if body.Outcome == "failed" {
		activityType = "issue.failed"
	}
	var errorValue any
	if body.HasError {
		errorValue = body.Error
	}
	if err := h.recordActivity(teamID, issueID, activityType,
		ActivityActor{Kind: "host", HostID: host.Host.ID},
		map[string]any{
			"execution_attempt_id":  issue.ExecutionAttemptID,
			"summary":               summaryValue,
			"error":                 errorValue,
			"verification_evidence": body.VerificationEvidence,
		}, now); err != nil {
		return "", err
	}
	if err := h.publish(teamID, []ChannelEvent{
		{Event: "issue.status_changed", Payload: map[string]any{
			"issue_id": issueID, "old_status": issue.Status, "new_status": nextStatus}},
		{Event: "issue.updated", Payload: map[string]any{
			"issue": toIssueView(settled), "changed_fields": []string{"status", "execution_summary"}}},
	}); err != nil {
		return "", err
	}
	if nextStatus == "in_review" && settled.ReviewerMemberID != nil {
		if err := h.sendPush([]string{*settled.ReviewerMemberID}, PushNotification{
			TeamID: teamID, IssueID: settled.ID, EventType: "review_requested",
			Body: reviewRequestedAlert(settled.Number, settled.Title),
		}, now); err != nil {
			return "", err
		}
	}
	return nextStatus, nil
}

// expireLease returns a running issue whose lease lapsed, or whose host went
// offline, to waiting_host. The assignee agent never changes.
func (h *Hub) expireLease(issue *Issue, now int64, reason string) error {
	if _, err := h.db.Exec("UPDATE issues SET status = 'waiting_host', updated_at = ? WHERE id = ?",
		now, issue.ID); err != nil {
		return err
	}
	if issue.AssigneeAgentID != nil {
		if _, err := h.db.Exec("UPDATE agents SET status = 'idle', updated_at = ? WHERE id = ?",
			now, *issue.AssigneeAgentID); err != nil {
			return err
		}
	}
	waiting, err := queryIssue(h.db, "SELECT "+issueColumns+" FROM issues WHERE id = ?", issue.ID)
	if err != nil {
		return err
	}
	if err := h.recordActivity(issue.TeamID, issue.ID, "issue.host_offline",
		ActivityActor{Kind: "system"},
		map[string]any{"reason": reason, "execution_attempt_id": issue.ExecutionAttemptID}, now); err != nil {
		return err
	}
	if waiting == nil {
		return nil
	}
	return h.publish(issue.TeamID, []ChannelEvent{
		{Event: "issue.status_changed", Payload: map[string]any{
			"issue_id": issue.ID, "old_status": "running", "new_status": "waiting_host"}},
		{Event: "issue.updated", Payload: map[string]any{
			"issue": toIssueView(waiting), "changed_fields": []string{"status"}}},
	})
}

// SweepExpiredLeases expires every running lease of the team that lapsed.
func (h *Hub) SweepExpiredLeases(teamID string, now int64) (int, error) {
	issues, err := Collect(h.db,
		"SELECT "+issueColumns+" FROM issues WHERE team_id = ? AND status = 'running' "+
			"AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?", scanIssue, teamID, now)
	if err != nil {
		return 0, err
	}
	for _, issue := range issues {
		if err := h.expireLease(issue, now, "lease_expired"); err != nil {
			return 0, err
		}
	}
	return len(issues), nil
}

// SweepHostRunningIssues expires the running issues of a host that just went
// offline.
func (h *Hub) SweepHostRunningIssues(teamID, hostID string, now int64) (int, error) {
	issues, err := Collect(h.db,
		"SELECT "+issueColumns+" FROM issues WHERE team_id = ? AND status = 'running' "+
			"AND executing_host_id = ?", scanIssue, teamID, hostID)
	if err != nil {
		return 0, err
	}
	for _, issue := range issues {
		if err := h.expireLease(issue, now, "host_offline"); err != nil {
			return 0, err
		}
	}
	return len(issues), nil
}

// SweepAssignedAwaitingHost moves an assigned agent card whose host is not
// online to waiting_host, which is section 4's rule for it.
func (h *Hub) SweepAssignedAwaitingHost(teamID string, now int64) (int, error) {
	issues, err := Collect(h.db,
		"SELECT "+issueColumnsI+" FROM issues i JOIN agents a ON a.id = i.assignee_agent_id "+
			"JOIN hosts h ON h.id = a.host_id WHERE i.team_id = ? AND i.status = 'assigned' "+
			"AND h.status != 'online'", scanIssue, teamID)
	if err != nil {
		return 0, err
	}
	for _, issue := range issues {
		if _, err := h.db.Exec("UPDATE issues SET status = 'waiting_host', updated_at = ? WHERE id = ?",
			now, issue.ID); err != nil {
			return 0, err
		}
		waiting, err := queryIssue(h.db, "SELECT "+issueColumns+" FROM issues WHERE id = ?", issue.ID)
		if err != nil {
			return 0, err
		}
		if err := h.recordActivity(teamID, issue.ID, "issue.waiting_host", ActivityActor{Kind: "system"},
			map[string]any{"reason": "host_offline"}, now); err != nil {
			return 0, err
		}
		if waiting == nil {
			continue
		}
		if err := h.publish(teamID, []ChannelEvent{
			{Event: "issue.status_changed", Payload: map[string]any{
				"issue_id": issue.ID, "old_status": "assigned", "new_status": "waiting_host"}},
			{Event: "issue.updated", Payload: map[string]any{
				"issue": toIssueView(waiting), "changed_fields": []string{"status"}}},
		}); err != nil {
			return 0, err
		}
	}
	return len(issues), nil
}
