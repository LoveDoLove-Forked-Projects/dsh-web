package hub

// Questions and the sweeps that end them: ask, list, answer, withdraw, expire,
// and the process timer that runs the expiry.

import (
	"net/http"
	"testing"
	"time"
)

type questionFixture struct {
	server    *testHub
	team      seededTeam
	host      seededHost
	otherHost seededHost
	issueID   string
}

func newQuestionFixture(t *testing.T, options ...startOptions) *questionFixture {
	t.Helper()
	server := startTestHub(t, options...)
	team := server.seedTeam()
	host := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	otherHost := server.seedHost(team.teamID, team.admin.accessToken, "host-b",
		[]map[string]any{{"name": "dev-bot", "preset_id": "liangshen"}})
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "question routing", "assignee_type": "agent", "assignee_id": stringField(host.agents[0], "id"),
	})
	issueID := stringField(issue, "id")
	claim := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+issueID+"/claim", apiOptions{
		token: host.hostToken, body: map[string]any{},
	})
	if claim.status != http.StatusOK {
		t.Fatalf("claim failed: %d %s", claim.status, claim.text)
	}
	return &questionFixture{server: server, team: team, host: host, otherHost: otherHost, issueID: issueID}
}

func (f *questionFixture) ask(token string, body map[string]any) apiResult {
	f.server.t.Helper()
	return f.server.api("POST", "/api/v1/teams/"+f.team.teamID+"/issues/"+f.issueID+"/questions",
		apiOptions{token: token, body: body})
}

func (f *questionFixture) askOK(body map[string]any) map[string]any {
	f.server.t.Helper()
	result := f.ask(f.host.hostToken, body)
	if result.status != http.StatusCreated {
		f.server.t.Fatalf("question creation failed: %d %s", result.status, result.text)
	}
	question, _ := result.body["question"].(map[string]any)
	return question
}

func TestHostAsksAndMemberListsQuestions(t *testing.T) {
	fixture := newQuestionFixture(t)
	question := fixture.askOK(map[string]any{
		"question_text": "Which endpoint should ship first?",
		"options": []any{
			map[string]any{"label": "Plan A", "description": "Ship v1"},
			map[string]any{"label": "Plan B"},
		},
		"multi_select": true,
	})
	if stringField(question, "issue_id") != fixture.issueID ||
		stringField(question, "text") != "Which endpoint should ship first?" ||
		stringField(question, "status") != "pending" ||
		question["answer"] != nil || question["multi_select"] != true {
		t.Fatalf("question shape: %v", question)
	}
	options, _ := question["options"].([]any)
	if len(options) != 2 {
		t.Fatalf("options: %v", question["options"])
	}
	first, _ := options[0].(map[string]any)
	if stringField(first, "label") != "Plan A" || stringField(first, "description") != "Ship v1" {
		t.Fatalf("option shape: %v", first)
	}

	listed := fixture.server.api("GET", "/api/v1/teams/"+fixture.team.teamID+"/questions", apiOptions{
		token: fixture.team.admin.accessToken,
		query: map[string]string{"status": "pending", "issue_id": fixture.issueID},
	})
	questions, _ := listed.body["questions"].([]any)
	if listed.status != http.StatusOK || len(questions) != 1 {
		t.Fatalf("question list: %d %s", listed.status, listed.text)
	}
}

func TestQuestionRefusals(t *testing.T) {
	fixture := newQuestionFixture(t)

	foreign := fixture.ask(fixture.otherHost.hostToken, map[string]any{"question_text": "may I?"})
	if foreign.status != http.StatusForbidden || errorCode(foreign.body) != string(CodeHostMismatch) {
		t.Fatalf("foreign host question: %d %s", foreign.status, foreign.text)
	}

	unclaimed := fixture.server.createIssue(fixture.team.teamID, fixture.team.admin.accessToken, map[string]any{
		"title": "not running", "assignee_type": "agent", "assignee_id": stringField(fixture.host.agents[0], "id"),
	})
	early := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/issues/"+stringField(unclaimed, "id")+"/questions",
		apiOptions{token: fixture.host.hostToken, body: map[string]any{"question_text": "too early?"}})
	if early.status != http.StatusUnprocessableEntity || errorCode(early.body) != string(CodeInvalidState) {
		t.Fatalf("question before claim: %d %s", early.status, early.text)
	}

	unknownStatus := fixture.server.api("GET", "/api/v1/teams/"+fixture.team.teamID+"/questions", apiOptions{
		token: fixture.team.admin.accessToken, query: map[string]string{"status": "pending-ish"},
	})
	if unknownStatus.status != http.StatusBadRequest || errorCode(unknownStatus.body) != string(CodeValidationFailed) {
		t.Fatalf("unknown status filter: %d %s", unknownStatus.status, unknownStatus.text)
	}

	badOption := fixture.ask(fixture.host.hostToken, map[string]any{
		"question_text": "options?", "options": []any{map[string]any{"description": "no label"}},
	})
	if badOption.status != http.StatusBadRequest || errorCode(badOption.body) != string(CodeValidationFailed) {
		t.Fatalf("option without a label: %d %s", badOption.status, badOption.text)
	}
}

func TestFirstAnswerWinsAndIsExposed(t *testing.T) {
	fixture := newQuestionFixture(t)
	question := fixture.askOK(map[string]any{
		"question_text": "which one?", "options": []any{map[string]any{"label": "Plan A"}},
	})
	questionID := stringField(question, "id")

	empty := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/answer",
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{}})
	if empty.status != http.StatusBadRequest || errorCode(empty.body) != string(CodeValidationFailed) {
		t.Fatalf("empty answer: %d %s", empty.status, empty.text)
	}

	answered := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/answer",
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{
			"selected": []any{"Plan A"}, "custom": "Ship the v1 endpoint first",
		}})
	if answered.status != http.StatusOK || answered.body["ok"] != true {
		t.Fatalf("answer: %d %s", answered.status, answered.text)
	}

	listed := fixture.server.api("GET", "/api/v1/teams/"+fixture.team.teamID+"/questions", apiOptions{
		token: fixture.team.admin.accessToken, query: map[string]string{"status": "answered"},
	})
	questions, _ := listed.body["questions"].([]any)
	if len(questions) != 1 {
		t.Fatalf("answered list: %s", listed.text)
	}
	stored, _ := questions[0].(map[string]any)
	answer, _ := stored["answer"].(map[string]any)
	selected, _ := answer["selected"].([]any)
	if stringField(stored, "status") != "answered" || len(selected) != 1 ||
		stringField(answer, "custom") != "Ship the v1 endpoint first" ||
		stringField(stored, "first_responder_member_id") == "" || numberField(stored, "answered_at") == 0 {
		t.Fatalf("answered shape: %s", listed.text)
	}

	second := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/answer",
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{"custom": "Plan B"}})
	if second.status != http.StatusConflict || errorCode(second.body) != string(CodeQuestionAnswered) {
		t.Fatalf("second answer: %d %s", second.status, second.text)
	}
	if details := errorDetails(second.body); stringField(details, "first_responder_member_id") == "" {
		t.Fatalf("the refusal did not name the responder: %s", second.text)
	}
}

func TestWithdrawRules(t *testing.T) {
	fixture := newQuestionFixture(t)
	question := fixture.askOK(map[string]any{"question_text": "withdraw me"})
	questionID := stringField(question, "id")
	member := fixture.server.inviteAndLogin(fixture.team.teamID, fixture.team.admin.accessToken, "hubot")

	refused := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/withdraw",
		apiOptions{token: member.accessToken})
	if refused.status != http.StatusForbidden || errorCode(refused.body) != string(CodeForbidden) {
		t.Fatalf("plain member withdraw: %d %s", refused.status, refused.text)
	}

	foreignHost := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/withdraw",
		apiOptions{token: fixture.otherHost.hostToken})
	if foreignHost.status != http.StatusForbidden || errorCode(foreignHost.body) != string(CodeHostMismatch) {
		t.Fatalf("foreign host withdraw: %d %s", foreignHost.status, foreignHost.text)
	}

	withdrawn := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/withdraw",
		apiOptions{token: fixture.team.admin.accessToken})
	if withdrawn.status != http.StatusOK || stringField(withdrawn.body, "status") != "dismissed" {
		t.Fatalf("admin withdraw: %d %s", withdrawn.status, withdrawn.text)
	}
	again := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/withdraw",
		apiOptions{token: fixture.team.admin.accessToken})
	if again.status != http.StatusConflict || errorCode(again.body) != string(CodeQuestionNotPending) {
		t.Fatalf("second withdraw: %d %s", again.status, again.text)
	}

	own := fixture.askOK(map[string]any{"question_text": "host withdraws"})
	byHost := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/questions/"+stringField(own, "id")+"/withdraw",
		apiOptions{token: fixture.host.hostToken})
	if byHost.status != http.StatusOK {
		t.Fatalf("asking host withdraw: %d %s", byHost.status, byHost.text)
	}

	answered := fixture.askOK(map[string]any{"question_text": "answer me"})
	answeredID := stringField(answered, "id")
	fixture.server.api("POST", "/api/v1/teams/"+fixture.team.teamID+"/questions/"+answeredID+"/answer",
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{"custom": "done"}})
	late := fixture.server.api("POST", "/api/v1/teams/"+fixture.team.teamID+"/questions/"+answeredID+"/withdraw",
		apiOptions{token: fixture.team.admin.accessToken})
	if late.status != http.StatusConflict || errorCode(late.body) != string(CodeQuestionNotPending) {
		t.Fatalf("withdraw of an answered question: %d %s", late.status, late.text)
	}
}

func TestSweepExpiresAQuestionAndTheAnswerIsRefused(t *testing.T) {
	fixture := newQuestionFixture(t)
	question := fixture.askOK(map[string]any{"question_text": "too late?"})
	questionID := stringField(question, "id")
	if _, err := fixture.server.hub.DB().Exec("UPDATE questions SET expires_at = ? WHERE id = ?",
		time.Now().UnixMilli()-1, questionID); err != nil {
		t.Fatalf("expire question: %v", err)
	}

	result, err := fixture.server.hub.Sweep()
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if result.QuestionsExpired != 1 {
		t.Fatalf("the sweep expired %d questions", result.QuestionsExpired)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM questions WHERE id = ?", questionID); status != "expired" {
		t.Fatalf("question status: %s", status)
	}

	answered := fixture.server.api("POST", "/api/v1/teams/"+fixture.team.teamID+"/questions/"+questionID+"/answer",
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{"custom": "late"}})
	if answered.status != http.StatusConflict || errorCode(answered.body) != string(CodeQuestionNotPending) {
		t.Fatalf("answer after expiry: %d %s", answered.status, answered.text)
	}
}

func TestSweepRunsFromTheProcessTimer(t *testing.T) {
	fixture := newQuestionFixture(t, startOptions{env: map[string]string{"SWEEP_INTERVAL_MS": "50"}})
	question := fixture.askOK(map[string]any{"question_text": "tick"})
	questionID := stringField(question, "id")
	if _, err := fixture.server.hub.DB().Exec("UPDATE questions SET expires_at = ? WHERE id = ?",
		time.Now().UnixMilli()-1, questionID); err != nil {
		t.Fatalf("expire question: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, _ := one[string](fixture.server, "SELECT status FROM questions WHERE id = ?", questionID)
		if status == "expired" {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("the process timer never swept the expired question")
}

func TestSweepTakesOfflineHostsAndTheirLeases(t *testing.T) {
	fixture := newQuestionFixture(t)
	if _, err := fixture.server.hub.DB().Exec("UPDATE hosts SET last_heartbeat_at = ? WHERE id = ?",
		time.Now().UnixMilli()-120_000, fixture.host.hostID); err != nil {
		t.Fatalf("age the heartbeat: %v", err)
	}

	result, err := fixture.server.hub.Sweep()
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if result.HostsOffline != 1 || result.LeasesExpired != 1 {
		t.Fatalf("sweep counts: %+v", result)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM hosts WHERE id = ?", fixture.host.hostID); status != "offline" {
		t.Fatalf("host status: %s", status)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "waiting_host" {
		t.Fatalf("issue status: %s", status)
	}

	// An assigned card whose host is offline also waits for it.
	offlineHost := fixture.server.seedHost(fixture.team.teamID, fixture.team.admin.accessToken, "host-c",
		[]map[string]any{{"name": "idle-bot", "preset_id": "liangshen"}})
	if _, err := fixture.server.hub.DB().Exec("UPDATE hosts SET status = 'offline' WHERE id = ?", offlineHost.hostID); err != nil {
		t.Fatalf("offline host: %v", err)
	}
	assigned := fixture.server.createIssue(fixture.team.teamID, fixture.team.admin.accessToken, map[string]any{
		"title": "waits", "assignee_type": "agent", "assignee_id": stringField(offlineHost.agents[0], "id"),
	})
	if stringField(assigned, "status") != "waiting_host" {
		t.Fatalf("assigned card on an offline host: %v", assigned)
	}
}
