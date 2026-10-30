package hub

// One function per route: body extraction, the domain call, the wire response.

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	// Credentials are headers only, which a browser page cannot forge, so the
	// origin check is not the boundary here.
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Hub) handleAuthorize(c *routeContext) error {
	target, cookies, err := h.beginAuthorize(c.r, c.now)
	if err != nil {
		return err
	}
	writeRedirect(c.w, target.String(), cookies)
	return nil
}

func (h *Hub) handleCallback(c *routeContext) error {
	target, cookies, err := h.completeCallback(c.r, c.now)
	if err != nil {
		return err
	}
	writeRedirect(c.w, target.String(), cookies)
	return nil
}

func sessionResponse(tokens *SessionTokens, member *Member) map[string]any {
	return map[string]any{
		"access_token":  tokens.AccessToken,
		"refresh_token": tokens.RefreshToken,
		"token_type":    tokens.TokenType,
		"expires_in":    tokens.ExpiresIn,
		"member":        toMemberView(member),
	}
}

func (h *Hub) handleToken(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	code, err := RequireString(body, "code")
	if err != nil {
		return err
	}
	verifier, hasVerifier := OptionalString(body, "code_verifier")
	if _, err := RequireString(body, "redirect_uri"); err != nil {
		return err
	}
	var verifierPointer *string
	if hasVerifier {
		verifierPointer = &verifier
	}
	tokens, member, err := h.completeAuthorizationCode(code, verifierPointer,
		requestOrigin(c.r)+githubCallbackPath, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, sessionResponse(tokens, member))
	return nil
}

func (h *Hub) handleRefresh(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	presented, _ := OptionalString(body, "refresh_token")
	if presented == "" {
		presented = cookieValue(c.r, refreshCookieName)
	}
	if presented == "" {
		return Fail(CodeInvalidRefreshToken, "refresh_token is required.")
	}
	tokens, member, err := h.rotateRefreshToken(presented, c.now)
	if err != nil {
		return err
	}
	for _, cookie := range sessionCookies(tokens) {
		c.w.Header().Add("set-cookie", cookie)
	}
	WriteJSON(c.w, http.StatusOK, sessionResponse(tokens, member))
	return nil
}

func (h *Hub) handleRevoke(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	presented, _ := OptionalString(body, "refresh_token")
	if presented == "" {
		presented = cookieValue(c.r, refreshCookieName)
	}
	if presented == "" {
		return Fail(CodeUnauthorized, "refresh_token is required.")
	}
	if err := h.revokeSession(presented, c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func (h *Hub) handleAccountSignIn(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	assertion, err := RequireString(body, "assertion")
	if err != nil {
		return err
	}
	tokens, member, err := h.signInWithAccountAssertion(assertion, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, sessionResponse(tokens, member))
	return nil
}

func (h *Hub) handleAccountLink(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	assertion, err := RequireString(body, "assertion")
	if err != nil {
		return err
	}
	member, err := h.linkAccountIdentity(c.principal.Member, assertion, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"member": toMemberView(member)})
	return nil
}

func (h *Hub) handleBootstrap(c *routeContext) error {
	if err := h.requireBootstrapToken(c.r); err != nil {
		return err
	}
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	teamName, err := RequireString(body, "team_name")
	if err != nil {
		return err
	}
	teamSlug, err := RequireString(body, "team_slug")
	if err != nil {
		return err
	}
	username, err := RequireString(body, "github_username")
	if err != nil {
		return err
	}
	result, err := h.BootstrapTeam(teamName, teamSlug, username, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, result)
	return nil
}

func (h *Hub) handleMe(c *routeContext) error {
	response, err := h.DescribeMe(c.principal)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, response)
	return nil
}

func (h *Hub) handleAgents(c *routeContext) error {
	bindings, err := h.ListAgentBindings(c.teamID())
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"agents": bindings})
	return nil
}

func (h *Hub) handleMembers(c *routeContext) error {
	members, err := h.ListMembers(c.teamID())
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"members": members})
	return nil
}

func (h *Hub) handleInviteMember(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	username, err := RequireString(body, "github_username")
	if err != nil {
		return err
	}
	role, err := RequireString(body, "role")
	if err != nil {
		return err
	}
	if role != "admin" && role != "member" {
		return FailWith(CodeValidationFailed, "role must be 'admin' or 'member'.", map[string]any{"field": "role"})
	}
	member, err := h.InviteMember(c.teamID(), c.principal, username, role, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, map[string]any{"member": member})
	return nil
}

func (h *Hub) handleRemoveMember(c *routeContext) error {
	if err := h.RemoveMember(c.teamID(), c.r.PathValue("memberId"), c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func (h *Hub) handleHostToken(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	hostname, err := RequireString(body, "hostname")
	if err != nil {
		return err
	}
	minted, err := h.IssueHostToken(c.teamID(), c.principal, hostname, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, minted)
	return nil
}

func (h *Hub) handleRevokeHostToken(c *routeContext) error {
	if err := h.RevokeHostToken(c.teamID(), c.r.PathValue("hostId"), c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func parseAgentDefinitions(body map[string]any) ([]AgentDefinition, error) {
	raw, present := body["agents"]
	if !present || raw == nil {
		return nil, nil
	}
	entries, ok := raw.([]any)
	if !ok {
		return nil, FailWith(CodeValidationFailed, "agents must be an array.", map[string]any{"field": "agents"})
	}
	definitions := make([]AgentDefinition, 0, len(entries))
	for _, entry := range entries {
		record, ok := entry.(map[string]any)
		if !ok {
			return nil, FailWith(CodeValidationFailed, "Every agent definition must be an object.",
				map[string]any{"field": "agents"})
		}
		name, _ := record["name"].(string)
		if name == "" {
			return nil, FailWith(CodeValidationFailed, "Every agent definition needs a name.",
				map[string]any{"field": "agents"})
		}
		preset, _ := record["preset_id"].(string)
		if preset == "" {
			return nil, FailWith(CodeValidationFailed, "Every agent definition needs a preset_id.",
				map[string]any{"field": "agents"})
		}
		definition := AgentDefinition{Name: name, PresetID: preset}
		if model, ok := record["model"].(string); ok && model != "" {
			definition.Model = strPointer(model)
		}
		if effort, ok := record["reasoning_effort"].(string); ok && effort != "" {
			definition.ReasoningEffort = strPointer(effort)
		}
		definitions = append(definitions, definition)
	}
	return definitions, nil
}

func (h *Hub) handleRegisterHost(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	hostname, err := RequireString(body, "hostname")
	if err != nil {
		return err
	}
	clientVersion, err := RequireString(body, "client_version")
	if err != nil {
		return err
	}
	agents, err := parseAgentDefinitions(body)
	if err != nil {
		return err
	}
	result, err := h.RegisterHost(c.principal.Host, hostname, clientVersion, agents, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, result)
	return nil
}

func (h *Hub) handleHeartbeat(c *routeContext) error {
	serverTime, err := h.Heartbeat(c.principal.Host, c.r.PathValue("hostId"), c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"ok": true, "server_time": serverTime})
	return nil
}

func (h *Hub) handleListIssues(c *routeContext) error {
	teamID := c.teamID()
	// Hosts poll this endpoint; sweeping here is what turns three missed
	// heartbeats into waiting_host without waiting for the timer.
	if _, err := h.SweepTeam(teamID, c.now); err != nil {
		return err
	}
	query := c.r.URL.Query()
	options := ListIssueOptions{}
	if raw := query.Get("status"); raw != "" {
		for _, status := range strings.Split(raw, ",") {
			options.Statuses = append(options.Statuses, strings.TrimSpace(status))
		}
	}
	if raw, ok := query["assignee"]; ok && len(raw) > 0 {
		options.Assignee = raw[0]
		options.HasAssignee = true
	}
	if raw, ok := query["assignee_host_id"]; ok && len(raw) > 0 {
		options.AssigneeHostID = raw[0]
		options.HasAssigneeHost = true
	}
	if c.principal != nil && c.principal.Kind == "host" {
		options.RestrictToHost = c.principal.Host.ID
		options.HasRestrict = true
	}
	issues, err := h.ListIssues(teamID, options)
	if err != nil {
		return err
	}
	views := make([]IssueView, 0, len(issues))
	for _, issue := range issues {
		views = append(views, toIssueView(issue))
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"issues": views})
	return nil
}

func (h *Hub) handleCreateIssue(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	title, err := RequireString(body, "title")
	if err != nil {
		return err
	}
	request := CreateIssueBody{Title: title}
	if description, ok := OptionalString(body, "description"); ok {
		request.Description = description
	}
	if assigneeType, ok := OptionalString(body, "assignee_type"); ok {
		if assigneeType != "member" && assigneeType != "agent" {
			return FailWith(CodeValidationFailed, "assignee_type must be 'member' or 'agent'.",
				map[string]any{"field": "assignee_type"})
		}
		request.AssigneeType = assigneeType
		request.HasAssigneeType = true
	}
	if assigneeID, ok := OptionalString(body, "assignee_id"); ok {
		request.AssigneeID = assigneeID
	}
	if reviewer, ok := OptionalString(body, "reviewer_member_id"); ok {
		request.ReviewerMemberID = reviewer
		request.HasReviewer = true
	}
	issue, err := h.CreateIssue(c.teamID(), c.principal, request, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, map[string]any{"issue": toIssueView(issue)})
	return nil
}

func (h *Hub) handleGetIssue(c *routeContext) error {
	issue, err := h.FindIssue(c.teamID(), c.r.PathValue("issueId"))
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"issue": toIssueView(issue)})
	return nil
}

func (h *Hub) handlePatchIssue(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	request := PatchIssueBody{}
	if title, ok := OptionalString(body, "title"); ok {
		request.Title = title
		request.HasTitle = true
	}
	if description, ok := OptionalString(body, "description"); ok {
		request.Description = description
		request.HasDescription = true
	}
	if assigneeType, ok := OptionalString(body, "assignee_type"); ok {
		if assigneeType != "member" && assigneeType != "agent" {
			return FailWith(CodeValidationFailed, "assignee_type must be 'member' or 'agent'.",
				map[string]any{"field": "assignee_type"})
		}
		request.AssigneeType = assigneeType
		request.HasAssigneeType = true
	}
	if assigneeID, ok := OptionalString(body, "assignee_id"); ok {
		request.AssigneeID = assigneeID
	}
	if reviewer, ok := OptionalString(body, "reviewer_member_id"); ok {
		request.ReviewerMemberID = reviewer
		request.HasReviewer = true
	}
	if status, ok := OptionalString(body, "status"); ok {
		request.Status = status
		request.HasStatus = true
	}
	issue, err := h.PatchIssue(c.teamID(), c.principal, c.r.PathValue("issueId"), request, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"issue": toIssueView(issue)})
	return nil
}

func (h *Hub) handleClaim(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	attempt, hasAttempt := OptionalString(body, "execution_attempt_id")
	lease, hasLease := OptionalString(body, "lease_token")
	result, err := h.ClaimIssue(c.teamID(), c.principal, c.r.PathValue("issueId"), attempt, lease,
		hasAttempt, hasLease, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, result)
	return nil
}

func (h *Hub) handleRenewLease(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	leaseToken, err := RequireString(body, "lease_token")
	if err != nil {
		return err
	}
	expiresAt, err := h.RenewLease(c.teamID(), c.principal, c.r.PathValue("issueId"), leaseToken, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"lease_expires_at": expiresAt})
	return nil
}

func (h *Hub) handleSettle(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	request := SettlementBody{}
	if outcome, ok := OptionalString(body, "outcome"); ok {
		request.Outcome = outcome
		request.HasOutcome = true
	}
	if summary, ok := OptionalString(body, "summary"); ok {
		request.Summary = summary
		request.HasSummary = true
	}
	if failure, ok := OptionalString(body, "error"); ok {
		request.Error = failure
		request.HasError = true
	}
	if evidence, ok := body["verification_evidence"]; ok {
		request.VerificationEvidence = evidence
	}
	if attempt, ok := OptionalString(body, "execution_attempt_id"); ok {
		request.ExecutionAttemptID = attempt
		request.HasAttempt = true
	}
	status, err := h.SettleIssue(c.teamID(), c.principal, c.r.PathValue("issueId"), request, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"ok": true, "status": status})
	return nil
}

func (h *Hub) handleApproveReview(c *routeContext) error {
	issue, err := h.ApproveReview(c.teamID(), c.principal, c.r.PathValue("issueId"), c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"ok": true, "status": issue.Status})
	return nil
}

func (h *Hub) handleRejectReview(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	instructions, err := RequireString(body, "instructions")
	if err != nil {
		return err
	}
	issue, err := h.RejectReview(c.teamID(), c.principal, c.r.PathValue("issueId"), instructions, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"ok": true, "status": issue.Status})
	return nil
}

func (h *Hub) handleListComments(c *routeContext) error {
	comments, err := h.ListComments(c.teamID(), c.r.PathValue("issueId"))
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"comments": comments})
	return nil
}

func (h *Hub) handleCreateComment(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	content, err := RequireString(body, "content")
	if err != nil {
		return err
	}
	authorType, hasAuthorType := OptionalString(body, "author_type")
	authorAgentID, hasAuthorAgentID := OptionalString(body, "author_agent_id")
	comment, err := h.CreateComment(c.teamID(), c.principal, c.r.PathValue("issueId"), content,
		authorType, hasAuthorType, authorAgentID, hasAuthorAgentID, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, map[string]any{"comment": toCommentView(comment)})
	return nil
}

func (h *Hub) handleActivity(c *routeContext) error {
	limit, err := IntParam(c.r, "limit", 50, 1, 100)
	if err != nil {
		return err
	}
	before, hasBefore := c.r.URL.Query()["before"]
	beforeValue := ""
	if hasBefore && len(before) > 0 {
		beforeValue = before[0]
	}
	page, err := h.ListActivityFeed(c.teamID(), c.r.PathValue("issueId"), beforeValue, hasBefore, limit)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, page)
	return nil
}

func (h *Hub) handleCreateQuestion(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	text, err := RequireString(body, "question_text")
	if err != nil {
		return err
	}
	options, hasOptions := OptionalArray(body, "options")
	multiSelect, _ := OptionalBool(body, "multi_select")
	question, err := h.CreateQuestion(c.teamID(), c.principal, c.r.PathValue("issueId"), text,
		options, hasOptions, multiSelect, c.now)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusCreated, map[string]any{"question": toQuestionView(question)})
	return nil
}

func (h *Hub) handleAnswerQuestion(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	selected, hasSelected := OptionalArray(body, "selected")
	custom, hasCustom := OptionalString(body, "custom")
	if err := h.AnswerQuestion(c.teamID(), c.principal, c.r.PathValue("questionId"), selected,
		hasSelected, custom, hasCustom, c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func (h *Hub) handleWithdrawQuestion(c *routeContext) error {
	if err := h.WithdrawQuestion(c.teamID(), c.principal, c.r.PathValue("questionId"), c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(map[string]any{"status": "dismissed"}))
	return nil
}

func (h *Hub) handleListQuestions(c *routeContext) error {
	query := c.r.URL.Query()
	status, hasStatus := query["status"]
	statusValue := ""
	if hasStatus && len(status) > 0 {
		statusValue = status[0]
	}
	issueID, hasIssue := query["issue_id"]
	issueValue := ""
	if hasIssue && len(issueID) > 0 {
		issueValue = issueID[0]
	}
	questions, err := h.ListQuestions(c.teamID(), statusValue, issueValue, hasStatus, hasIssue)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, map[string]any{"questions": questions})
	return nil
}

func (h *Hub) handleInbox(c *routeContext) error {
	inbox, err := h.GetInbox(c.teamID(), c.principal)
	if err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, inbox)
	return nil
}

func (h *Hub) handleMentionRead(c *routeContext) error {
	if err := h.MarkMentionRead(c.teamID(), c.principal, c.r.PathValue("commentId"), c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func (h *Hub) handleWebSocket(c *routeContext) error {
	if !strings.EqualFold(c.r.Header.Get("Upgrade"), "websocket") {
		return Fail(CodeValidationFailed, "This endpoint requires a WebSocket upgrade.")
	}
	teamID := c.teamID()
	hostID := ""
	if c.principal != nil && c.principal.Kind == "host" {
		hostID = c.principal.Host.ID
	}
	var since *int64
	if raw := c.r.URL.Query().Get("since_seq"); raw != "" {
		if value, ok := leadingInt64(raw); ok {
			since = &value
		}
	}
	connection, err := upgrader.Upgrade(c.w, c.r, nil)
	if err != nil {
		return nil
	}
	connection.SetReadLimit(WsFrameLimitBytes + 1)
	attached := h.channel.Attach(teamID, hostID, since, connection)
	for {
		messageType, data, err := connection.ReadMessage()
		if err != nil {
			if errors.Is(err, websocket.ErrReadLimit) {
				attached.closeWith(1009, "PAYLOAD_TOO_LARGE")
			}
			h.channel.Detach(teamID, attached)
			_ = connection.Close()
			return nil
		}
		result := h.channel.HandleFrame(teamID, attached, messageType == websocket.BinaryMessage, data)
		if result == FrameClosed {
			h.channel.Detach(teamID, attached)
			return nil
		}
	}
}

func (h *Hub) handleRegisterPushToken(c *routeContext) error {
	body, err := ReadJSONBody(c.r)
	if err != nil {
		return err
	}
	platform, err := RequireString(body, "platform")
	if err != nil {
		return err
	}
	deviceToken, err := RequireString(body, "device_token")
	if err != nil {
		return err
	}
	bundleID, err := RequireString(body, "bundle_id")
	if err != nil {
		return err
	}
	environment, err := RequireString(body, "environment")
	if err != nil {
		return err
	}
	if platform != "ios" && platform != "macos" {
		return FailWith(CodeValidationFailed, "platform must be 'ios' or 'macos'.",
			map[string]any{"field": "platform"})
	}
	if environment != "production" && environment != "sandbox" {
		return FailWith(CodeValidationFailed, "environment must be 'production' or 'sandbox'.",
			map[string]any{"field": "environment"})
	}
	if err := h.RegisterPushToken(c.principal.Member.ID, platform, deviceToken, bundleID, environment, c.now); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}

func (h *Hub) handleDeletePushToken(c *routeContext) error {
	if err := h.DeletePushToken(c.principal.Member.ID, c.r.PathValue("token")); err != nil {
		return err
	}
	WriteJSON(c.w, http.StatusOK, OkBody(nil))
	return nil
}
