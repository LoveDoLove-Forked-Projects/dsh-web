package hub

// Registration, heartbeat, the issue matrix, comments, the audit feed, the inbox
// and session rotation, all against the real service.

import (
	"net/http"
	"strings"
	"testing"
)

func TestHealthAndReadiness(t *testing.T) {
	server := startTestHub(t)

	health := server.api("GET", "/healthz", apiOptions{omitProtocol: true})
	if health.status != http.StatusOK || stringField(health.body, "status") != "ok" {
		t.Fatalf("healthz: %d %s", health.status, health.text)
	}
	if stringField(health.body, "protocol_version") != ProtocolVersion {
		t.Fatalf("healthz protocol: %s", health.text)
	}

	ready := server.api("GET", "/readyz", apiOptions{omitProtocol: true})
	if ready.status != http.StatusOK || stringField(ready.body, "status") != "ready" {
		t.Fatalf("readyz: %d %s", ready.status, ready.text)
	}
	if stringField(ready.body, "database") != "ok" {
		t.Fatalf("readyz database: %s", ready.text)
	}
	migrations, _ := ready.body["migrations"].(map[string]any)
	if numberField(migrations, "applied") != 4 {
		t.Fatalf("readyz migrations: %s", ready.text)
	}
	if pending, ok := migrations["pending"].([]any); !ok || len(pending) != 0 {
		t.Fatalf("readyz pending: %s", ready.text)
	}
	features, _ := ready.body["features"].(map[string]any)
	if features["bootstrap"] != true || features["github_login"] != true {
		t.Fatalf("readyz features: %s", ready.text)
	}
}

func TestProtocolNegotiationAndUnknownRoutes(t *testing.T) {
	server := startTestHub(t)

	missing := server.api("GET", "/api/v1/me", apiOptions{omitProtocol: true})
	if missing.status != http.StatusBadRequest || errorCode(missing.body) != string(CodeUnsupportedProtocol) {
		t.Fatalf("missing protocol header: %d %s", missing.status, missing.text)
	}

	wrong := server.api("GET", "/api/v1/me", apiOptions{
		headers: map[string]string{ProtocolHeader: "2.0.0"},
	})
	if wrong.status != http.StatusBadRequest || errorCode(wrong.body) != string(CodeUnsupportedProtocol) {
		t.Fatalf("wrong major version: %d %s", wrong.status, wrong.text)
	}
	if details := errorDetails(wrong.body); stringField(details, "supported") != ProtocolVersion {
		t.Fatalf("wrong major details: %s", wrong.text)
	}

	unknown := server.api("POST", "/api/v1/nope", apiOptions{})
	if unknown.status != http.StatusNotFound || errorCode(unknown.body) != string(CodeNotFound) {
		t.Fatalf("unknown route: %d %s", unknown.status, unknown.text)
	}

	wrongMethod := server.api("DELETE", "/api/v1/me", apiOptions{})
	if wrongMethod.status != http.StatusNotFound || errorCode(wrongMethod.body) != string(CodeNotFound) {
		t.Fatalf("unknown method: %d %s", wrongMethod.status, wrongMethod.text)
	}

	anonymous := server.api("GET", "/api/v1/me", apiOptions{})
	if anonymous.status != http.StatusUnauthorized || errorCode(anonymous.body) != string(CodeUnauthorized) {
		t.Fatalf("anonymous request: %d %s", anonymous.status, anonymous.text)
	}
}

func TestBootstrapRunsOnce(t *testing.T) {
	server := startTestHub(t)

	badToken := server.api("POST", "/api/v1/bootstrap", apiOptions{
		headers: map[string]string{"X-Bootstrap-Token": "wrong"},
		body:    map[string]any{"team_name": "Team", "team_slug": "team", "email": "first.admin@example.test"},
	})
	if badToken.status != http.StatusUnauthorized || errorCode(badToken.body) != string(CodeUnauthorized) {
		t.Fatalf("bad bootstrap token: %d %s", badToken.status, badToken.text)
	}

	team := server.seedTeam()
	// The address is one the account service does not know, and the answer is still
	// CONFLICT: a hub that already bootstrapped refuses the call before it looks
	// anything up.
	second := server.api("POST", "/api/v1/bootstrap", apiOptions{
		headers: map[string]string{"X-Bootstrap-Token": bootstrapToken},
		body:    map[string]any{"team_name": "Team Two", "team_slug": "team-two", "email": "nobody@example.test"},
	})
	if second.status != http.StatusConflict || errorCode(second.body) != string(CodeConflict) {
		t.Fatalf("second bootstrap: %d %s", second.status, second.text)
	}
	if details := errorDetails(second.body); stringField(details, "team_id") != team.teamID {
		t.Fatalf("second bootstrap details: %s", second.text)
	}
}

func TestBootstrapClosedWhenTokenMissing(t *testing.T) {
	server := startTestHub(t, startOptions{env: map[string]string{"BOOTSTRAP_TOKEN": ""}})
	result := server.api("POST", "/api/v1/bootstrap", apiOptions{
		body: map[string]any{"team_name": "Team", "team_slug": "team", "email": "first.admin@example.test"},
	})
	if result.status != http.StatusServiceUnavailable || errorCode(result.body) != string(CodeNotConfigured) {
		t.Fatalf("bootstrap without token: %d %s", result.status, result.text)
	}
}

func TestHostRegistrationAndHeartbeat(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	minted := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/tokens", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"hostname": "host-a"},
	})
	if minted.status != http.StatusCreated {
		t.Fatalf("host token: %d %s", minted.status, minted.text)
	}
	hostID := stringField(minted.body, "host_id")
	hostToken := stringField(minted.body, "host_token")
	if !strings.HasPrefix(hostID, "host_") || !strings.HasPrefix(hostToken, "th_host_") {
		t.Fatalf("host identifiers: %s", minted.text)
	}

	registered := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/register", apiOptions{
		token: hostToken, body: map[string]any{
			"hostname": "host-a", "client_version": "1.4.0",
			"agents": []any{
				map[string]any{"name": "qa-bot", "preset_id": "liangshen", "model": "deepseek-v4", "reasoning_effort": "high"},
				map[string]any{"name": "dev-bot", "preset_id": "liangshen"},
			},
		},
	})
	if registered.status != http.StatusOK {
		t.Fatalf("register: %d %s", registered.status, registered.text)
	}
	if stringField(registered.body, "host_id") != hostID || stringField(registered.body, "status") != "online" {
		t.Fatalf("register body: %s", registered.text)
	}
	if conflicts, _ := registered.body["conflicts"].([]any); len(conflicts) != 0 {
		t.Fatalf("unexpected conflicts: %s", registered.text)
	}

	status, _ := one[string](server, "SELECT status FROM hosts WHERE id = ?", hostID)
	version, _ := one[string](server, "SELECT client_version FROM hosts WHERE id = ?", hostID)
	if status != "online" || version != "1.4.0" {
		t.Fatalf("host row: status=%s version=%s", status, version)
	}
	model, _ := one[string](server, "SELECT model FROM agents WHERE name = ?", "qa-bot")
	effort, _ := one[string](server, "SELECT reasoning_effort FROM agents WHERE name = ?", "qa-bot")
	if model != "deepseek-v4" || effort != "high" {
		t.Fatalf("agent binding: model=%s effort=%s", model, effort)
	}

	beat := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/"+hostID+"/heartbeat", apiOptions{token: hostToken})
	if beat.status != http.StatusOK || beat.body["ok"] != true {
		t.Fatalf("heartbeat: %d %s", beat.status, beat.text)
	}
	if numberField(beat.body, "server_time") == 0 {
		t.Fatalf("heartbeat without server_time: %s", beat.text)
	}
	if beat.headers.Get(ProtocolHeader) != ProtocolVersion {
		t.Fatalf("protocol header missing on the way out: %v", beat.headers)
	}

	second := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/register", apiOptions{
		token: hostToken, body: map[string]any{
			"hostname": "host-a", "client_version": "1.4.0",
			"agents": []any{map[string]any{"name": "qa-bot", "preset_id": "liangshen"}},
		},
	})
	if second.status != http.StatusOK {
		t.Fatalf("second register: %d %s", second.status, second.text)
	}
	if devBot, _ := one[string](server, "SELECT status FROM agents WHERE name = ?", "dev-bot"); devBot != "offline" {
		t.Fatalf("dropped agent not marked offline: %s", devBot)
	}
}

func TestHostRegistrationReportsConflicts(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.seedHost(team.teamID, team.admin.accessToken, "host-a", []map[string]any{
		{"name": "shared-bot", "preset_id": "liangshen"},
	})

	other := server.seedHost(team.teamID, team.admin.accessToken, "host-b", []map[string]any{
		{"name": "shared-bot", "preset_id": "liangshen"},
	})
	if len(other.agents) != 0 {
		t.Fatalf("the clashing name was accepted: %v", other.agents)
	}

	minted := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/tokens", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"hostname": "host-c"},
	})
	hostToken := stringField(minted.body, "host_token")
	registered := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/register", apiOptions{
		token: hostToken, body: map[string]any{
			"hostname": "host-c", "client_version": "1.0.0",
			"agents": []any{
				map[string]any{"name": "shared-bot", "preset_id": "liangshen"},
				map[string]any{"name": "own-bot", "preset_id": "liangshen"},
			},
		},
	})
	conflicts, _ := registered.body["conflicts"].([]any)
	if len(conflicts) != 1 {
		t.Fatalf("expected one conflict: %s", registered.text)
	}
	conflict, _ := conflicts[0].(map[string]any)
	if stringField(conflict, "name") != "shared-bot" {
		t.Fatalf("conflict body: %s", registered.text)
	}
	agents, _ := registered.body["agents"].([]any)
	if len(agents) != 1 {
		t.Fatalf("the accepted agents were not reported: %s", registered.text)
	}
}

func TestMemberIssueLifecycle(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	adminID := stringField(team.admin.member, "id")

	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "member card", "description": "body",
		"assignee_type": "member", "assignee_id": adminID,
	})
	if stringField(issue, "status") != "assigned" || stringField(issue, "id") == "" {
		t.Fatalf("created issue: %v", issue)
	}
	issueID := stringField(issue, "id")

	// A member card with no reviewer cannot be submitted for review.
	blocked := server.api("PATCH", "/api/v1/teams/"+team.teamID+"/issues/"+issueID, apiOptions{
		token: team.admin.accessToken, body: map[string]any{"status": "in_review"},
	})
	if blocked.status != http.StatusUnprocessableEntity || errorCode(blocked.body) != string(CodeInvalidState) {
		t.Fatalf("submit without reviewer: %d %s", blocked.status, blocked.text)
	}

	patched := server.api("PATCH", "/api/v1/teams/"+team.teamID+"/issues/"+issueID, apiOptions{
		token: team.admin.accessToken, body: map[string]any{
			"title": "renamed", "reviewer_member_id": adminID,
		},
	})
	updated, ok := patched.body["issue"].(map[string]any)
	if patched.status != http.StatusOK || !ok {
		t.Fatalf("patch: %d %s", patched.status, patched.text)
	}
	if stringField(updated, "title") != "renamed" {
		t.Fatalf("title not applied: %s", patched.text)
	}

	submitted := server.api("PATCH", "/api/v1/teams/"+team.teamID+"/issues/"+issueID, apiOptions{
		token: team.admin.accessToken, body: map[string]any{"status": "in_review"},
	})
	if submitted.status != http.StatusOK {
		t.Fatalf("submit for review: %d %s", submitted.status, submitted.text)
	}
	if got, _ := one[string](server, "SELECT status FROM issues WHERE id = ?", issueID); got != "in_review" {
		t.Fatalf("issue status: %s", got)
	}

	detail := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/"+issueID, apiOptions{
		token: team.admin.accessToken,
	})
	detailIssue, _ := detail.body["issue"].(map[string]any)
	if detail.status != http.StatusOK || stringField(detailIssue, "id") != issueID {
		t.Fatalf("issue detail: %d %s", detail.status, detail.text)
	}
	missing := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/issue_missing", apiOptions{
		token: team.admin.accessToken,
	})
	if missing.status != http.StatusNotFound || errorCode(missing.body) != string(CodeIssueNotFound) {
		t.Fatalf("unknown issue: %d %s", missing.status, missing.text)
	}

	approved := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/review/approve", apiOptions{
		token: team.admin.accessToken,
	})
	if approved.status != http.StatusOK || stringField(approved.body, "status") != "done" {
		t.Fatalf("approve: %d %s", approved.status, approved.text)
	}

	// A card in review is not claimable, and the refusal is a state error.
	claim := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/claim", apiOptions{
		token: team.admin.accessToken, body: map[string]any{},
	})
	if claim.status != http.StatusForbidden || errorCode(claim.body) != string(CodeForbidden) {
		t.Fatalf("member token on a host route: %d %s", claim.status, claim.text)
	}
}

func TestAgentIssueWaitsForOfflineHostAndLists(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	agentID := stringField(host.agents[0], "id")

	// The host went offline before the card was written.
	if _, err := server.hub.DB().Exec("UPDATE hosts SET status = 'offline' WHERE id = ?", host.hostID); err != nil {
		t.Fatalf("offline host: %v", err)
	}
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "agent card", "assignee_type": "agent", "assignee_id": agentID,
	})
	if stringField(issue, "status") != "waiting_host" {
		t.Fatalf("expected waiting_host: %v", issue)
	}
	if stringField(issue, "reviewer_member_id") == "" {
		t.Fatalf("the creator was not defaulted as reviewer: %v", issue)
	}

	listed := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"status": "waiting_host"},
	})
	issues, _ := listed.body["issues"].([]any)
	if listed.status != http.StatusOK || len(issues) != 1 {
		t.Fatalf("issue list: %d %s", listed.status, listed.text)
	}

	unknownFilter := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"status": "pending"},
	})
	if unknownFilter.status != http.StatusBadRequest || errorCode(unknownFilter.body) != string(CodeValidationFailed) {
		t.Fatalf("unknown status filter: %d %s", unknownFilter.status, unknownFilter.text)
	}

	// A host only sees the cards of its own agents.
	server.seedHost(team.teamID, team.admin.accessToken, "host-b",
		[]map[string]any{{"name": "dev-bot", "preset_id": "liangshen"}})
	restricted := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues", apiOptions{token: host.hostToken})
	hostIssues, _ := restricted.body["issues"].([]any)
	if restricted.status != http.StatusOK || len(hostIssues) != 1 {
		t.Fatalf("host issue list: %d %s", restricted.status, restricted.text)
	}

	agents := server.api("GET", "/api/v1/teams/"+team.teamID+"/agents", apiOptions{token: team.admin.accessToken})
	bindings, _ := agents.body["agents"].([]any)
	if agents.status != http.StatusOK || len(bindings) != 2 {
		t.Fatalf("agent roster: %d %s", agents.status, agents.text)
	}
}

func TestReviewRejectionReturnsCardToBoundHost(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "review me", "assignee_type": "agent", "assignee_id": stringField(host.agents[0], "id"),
	})
	issueID := stringField(issue, "id")

	claim := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/claim", apiOptions{
		token: host.hostToken, body: map[string]any{},
	})
	if claim.status != http.StatusOK {
		t.Fatalf("claim: %d %s", claim.status, claim.text)
	}
	settle := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/settle", apiOptions{
		token: host.hostToken, body: map[string]any{
			"outcome": "succeeded", "summary": "done", "execution_attempt_id": stringField(claim.body, "execution_attempt_id"),
		},
	})
	if settle.status != http.StatusOK {
		t.Fatalf("settle: %d %s", settle.status, settle.text)
	}

	rejected := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/review/reject", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"instructions": "add a regression test"},
	})
	if rejected.status != http.StatusOK || stringField(rejected.body, "status") != "assigned" {
		t.Fatalf("reject: %d %s", rejected.status, rejected.text)
	}
	instructions, _ := one[string](server, "SELECT rework_instructions FROM issues WHERE id = ?", issueID)
	if instructions != "add a regression test" {
		t.Fatalf("rework instructions: %q", instructions)
	}
	if executing, _ := one[*string](server, "SELECT executing_host_id FROM issues WHERE id = ?", issueID); executing != nil {
		t.Fatalf("the lease was not cleared: %v", executing)
	}

	// A plain member who is not the reviewer cannot decide.
	other := server.inviteAndLogin(team.teamID, team.admin.accessToken, "hubot")
	reclaimed := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/claim", apiOptions{
		token: host.hostToken, body: map[string]any{},
	})
	if reclaimed.status != http.StatusOK {
		t.Fatalf("reclaim after rework: %d %s", reclaimed.status, reclaimed.text)
	}
	server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/settle", apiOptions{
		token: host.hostToken, body: map[string]any{
			"outcome": "succeeded", "execution_attempt_id": stringField(reclaimed.body, "execution_attempt_id"),
		},
	})
	refused := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/review/reject", apiOptions{
		token: other.accessToken, body: map[string]any{"instructions": "mine now"},
	})
	if refused.status != http.StatusForbidden || errorCode(refused.body) != string(CodeForbidden) {
		t.Fatalf("foreign reviewer: %d %s", refused.status, refused.text)
	}
}

func TestCommentsAuditFeedAndInbox(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	// A member bound to an account carries the "account:" placeholder handle, which
	// a mention cannot express, so the mention legs need the other member shape: a
	// row carried by a GitHub identity.
	mentioned := server.unboundMemberAndLogin(team.teamID, "octocat")
	mentionedID := stringField(mentioned.member, "id")
	other := server.inviteAndLogin(team.teamID, team.admin.accessToken, "hubot")
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "thread", "assignee_type": "member", "assignee_id": mentionedID,
	})
	issueID := stringField(issue, "id")

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/comments", apiOptions{
		token: other.accessToken, body: map[string]any{"content": "@octocat please look"},
	})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	listed := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/comments", apiOptions{
		token: team.admin.accessToken,
	})
	comments, _ := listed.body["comments"].([]any)
	if listed.status != http.StatusOK || len(comments) != 1 {
		t.Fatalf("comments: %d %s", listed.status, listed.text)
	}

	// The host token may only post as an agent it owns.
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	refused := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/comments", apiOptions{
		token: host.hostToken, body: map[string]any{"content": "human?", "author_type": "human"},
	})
	if refused.status != http.StatusForbidden || errorCode(refused.body) != string(CodeForbidden) {
		t.Fatalf("host human comment: %d %s", refused.status, refused.text)
	}
	accepted := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/comments", apiOptions{
		token: host.hostToken, body: map[string]any{
			"content": "agent here", "author_type": "agent", "author_agent_id": stringField(host.agents[0], "id"),
		},
	})
	if accepted.status != http.StatusCreated {
		t.Fatalf("agent comment: %d %s", accepted.status, accepted.text)
	}
	foreignAgent := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/comments", apiOptions{
		token: host.hostToken, body: map[string]any{
			"content": "not mine", "author_type": "agent", "author_agent_id": "agent_missing",
		},
	})
	if foreignAgent.status != http.StatusForbidden || errorCode(foreignAgent.body) != string(CodeHostMismatch) {
		t.Fatalf("foreign agent comment: %d %s", foreignAgent.status, foreignAgent.text)
	}

	activity := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/activity", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"limit": "2"},
	})
	entries, _ := activity.body["activity"].([]any)
	if activity.status != http.StatusOK || len(entries) != 2 {
		t.Fatalf("activity page: %d %s", activity.status, activity.text)
	}
	cursor := stringField(activity.body, "next_cursor")
	if cursor == "" {
		t.Fatalf("activity page has no cursor: %s", activity.text)
	}
	next := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/activity", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"limit": "2", "before": cursor},
	})
	nextEntries, _ := next.body["activity"].([]any)
	if next.status != http.StatusOK || len(nextEntries) == 0 {
		t.Fatalf("second activity page: %d %s", next.status, next.text)
	}
	badCursor := server.api("GET", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/activity", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"before": "act_unknown"},
	})
	if badCursor.status != http.StatusBadRequest || errorCode(badCursor.body) != string(CodeValidationFailed) {
		t.Fatalf("bad cursor: %d %s", badCursor.status, badCursor.text)
	}

	inbox := server.api("GET", "/api/v1/teams/"+team.teamID+"/inbox", apiOptions{token: mentioned.accessToken})
	if inbox.status != http.StatusOK {
		t.Fatalf("inbox: %d %s", inbox.status, inbox.text)
	}
	mentions, _ := inbox.body["mentions"].([]any)
	if len(mentions) != 1 {
		t.Fatalf("inbox mentions: %s", inbox.text)
	}
	mention, _ := mentions[0].(map[string]any)
	commentRecord, _ := mention["comment"].(map[string]any)
	commentID := stringField(commentRecord, "id")
	read := server.api("POST", "/api/v1/teams/"+team.teamID+"/inbox/mentions/"+commentID+"/read", apiOptions{
		token: mentioned.accessToken,
	})
	if read.status != http.StatusOK {
		t.Fatalf("mark read: %d %s", read.status, read.text)
	}
	after := server.api("GET", "/api/v1/teams/"+team.teamID+"/inbox", apiOptions{token: mentioned.accessToken})
	afterMentions, _ := after.body["mentions"].([]any)
	if len(afterMentions) != 0 {
		t.Fatalf("mention still unread: %s", after.text)
	}
	assigned, _ := after.body["assigned"].([]any)
	if len(assigned) != 1 {
		t.Fatalf("inbox assigned: %s", after.text)
	}
}

func TestSessionRefreshAndRevoke(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	rotated := server.api("POST", "/auth/refresh", apiOptions{body: map[string]any{
		"refresh_token": team.admin.refreshToken,
	}})
	if rotated.status != http.StatusOK {
		t.Fatalf("refresh: %d %s", rotated.status, rotated.text)
	}
	newAccess := stringField(rotated.body, "access_token")
	newRefresh := stringField(rotated.body, "refresh_token")
	if newAccess == "" || newRefresh == team.admin.refreshToken {
		t.Fatalf("token was not rotated: %s", rotated.text)
	}

	replay := server.api("POST", "/auth/refresh", apiOptions{body: map[string]any{
		"refresh_token": team.admin.refreshToken,
	}})
	if replay.status != http.StatusUnauthorized || errorCode(replay.body) != string(CodeInvalidRefreshToken) {
		t.Fatalf("replayed refresh token: %d %s", replay.status, replay.text)
	}

	me := server.api("GET", "/api/v1/me", apiOptions{token: newAccess})
	if me.status != http.StatusOK {
		t.Fatalf("rotated access token: %d %s", me.status, me.text)
	}

	revoked := server.api("POST", "/auth/revoke", apiOptions{
		token: newAccess, body: map[string]any{"refresh_token": newRefresh},
	})
	if revoked.status != http.StatusOK {
		t.Fatalf("revoke: %d %s", revoked.status, revoked.text)
	}
	dead := server.api("GET", "/api/v1/me", apiOptions{token: newAccess})
	if dead.status != http.StatusUnauthorized || errorCode(dead.body) != string(CodeUnauthorized) {
		t.Fatalf("revoked session: %d %s", dead.status, dead.text)
	}
}

func TestRevokedHostTokenIsRefused(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})

	revoked := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/"+host.hostID+"/revoke-token", apiOptions{
		token: team.admin.accessToken,
	})
	if revoked.status != http.StatusOK {
		t.Fatalf("revoke host token: %d %s", revoked.status, revoked.text)
	}
	beat := server.api("POST", "/api/v1/teams/"+team.teamID+"/hosts/"+host.hostID+"/heartbeat", apiOptions{
		token: host.hostToken,
	})
	if beat.status != http.StatusUnauthorized || errorCode(beat.body) != string(CodeUnauthorized) {
		t.Fatalf("revoked host token: %d %s", beat.status, beat.text)
	}
}

func TestTeamIsolation(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	otherTeamID := "team_01j7b5w8m4f9q2e3r6t1y8u4i0"
	if _, err := server.hub.DB().Exec(
		"INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'Other', 'other', 1, 1)",
		otherTeamID); err != nil {
		t.Fatalf("insert second team: %v", err)
	}

	member := server.api("GET", "/api/v1/teams/"+otherTeamID+"/issues", apiOptions{token: team.admin.accessToken})
	if member.status != http.StatusForbidden || errorCode(member.body) != string(CodeForbidden) {
		t.Fatalf("member of another team: %d %s", member.status, member.text)
	}
	hostResult := server.api("GET", "/api/v1/teams/"+otherTeamID+"/issues", apiOptions{token: host.hostToken})
	if hostResult.status != http.StatusForbidden || errorCode(hostResult.body) != string(CodeHostMismatch) {
		t.Fatalf("host of another team: %d %s", hostResult.status, hostResult.text)
	}
	missing := server.api("GET", "/api/v1/teams/team_missing/issues", apiOptions{token: team.admin.accessToken})
	if missing.status != http.StatusNotFound || errorCode(missing.body) != string(CodeNotFound) {
		t.Fatalf("unknown team: %d %s", missing.status, missing.text)
	}
}

func TestPushTokenRequiresAPNsAndPurgesUnregisteredDevices(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	closed := server.api("POST", "/api/v1/push-tokens", apiOptions{
		token: team.admin.accessToken, body: map[string]any{
			"platform": "ios", "device_token": "device-1", "bundle_id": "com.example.hub", "environment": "sandbox",
		},
	})
	if closed.status != http.StatusServiceUnavailable || errorCode(closed.body) != string(CodeNotConfigured) {
		t.Fatalf("push token without APNs: %d %s", closed.status, closed.text)
	}

	withPush := startTestHub(t, startOptions{env: map[string]string{
		"APNS_KEY_ID": "key-id", "APNS_TEAM_ID": "team-id", "APNS_BUNDLE_ID": "com.example.hub",
		"APNS_PRIVATE_KEY_P8": testAPNsKey(t),
	}})
	pushTeam := withPush.seedTeam()
	pushAdminID := stringField(pushTeam.admin.member, "id")
	registered := withPush.api("POST", "/api/v1/push-tokens", apiOptions{
		token: pushTeam.admin.accessToken, body: map[string]any{
			"platform": "ios", "device_token": "device-1", "bundle_id": "com.example.hub", "environment": "sandbox",
		},
	})
	if registered.status != http.StatusOK {
		t.Fatalf("push token registration: %d %s", registered.status, registered.text)
	}
	// The device is assigned a card, which is the assigned push notification.
	withPush.createIssue(pushTeam.teamID, pushTeam.admin.accessToken, map[string]any{
		"title": "notify me", "assignee_type": "member", "assignee_id": pushAdminID,
	})
	var delivered int
	if err := withPush.hub.DB().QueryRow("SELECT COUNT(*) FROM push_tokens").Scan(&delivered); err != nil {
		t.Fatalf("count push tokens: %v", err)
	}
	if delivered != 1 {
		t.Fatalf("push token was purged on a 200: %d", delivered)
	}

	withPush.fake.mu.Lock()
	withPush.fake.pushStatus = 410
	withPush.fake.mu.Unlock()
	withPush.createIssue(pushTeam.teamID, pushTeam.admin.accessToken, map[string]any{
		"title": "gone", "assignee_type": "member", "assignee_id": pushAdminID,
	})
	if err := withPush.hub.DB().QueryRow("SELECT COUNT(*) FROM push_tokens").Scan(&delivered); err != nil {
		t.Fatalf("count push tokens after 410: %v", err)
	}
	if delivered != 0 {
		t.Fatalf("an unregistered device was not purged: %d", delivered)
	}
}

func TestReviewerSeesOwnQueue(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "review queue", "assignee_type": "agent", "assignee_id": stringField(host.agents[0], "id"),
	})
	issueID := stringField(issue, "id")
	claim := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/claim", apiOptions{
		token: host.hostToken, body: map[string]any{},
	})
	server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/settle", apiOptions{
		token: host.hostToken, body: map[string]any{
			"outcome": "succeeded", "execution_attempt_id": stringField(claim.body, "execution_attempt_id"),
		},
	})
	inbox := server.api("GET", "/api/v1/teams/"+team.teamID+"/inbox", apiOptions{token: team.admin.accessToken})
	reviews, _ := inbox.body["review"].([]any)
	if len(reviews) != 1 {
		t.Fatalf("review inbox: %s", inbox.text)
	}
}

func testAPNsKey(t *testing.T) string {
	t.Helper()
	return generateP8(t)
}
