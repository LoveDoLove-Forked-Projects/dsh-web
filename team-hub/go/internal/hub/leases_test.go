package hub

// The lease state machine against the real service: the three claim refusals, the
// renewal expiry, settlement idempotency and the foreign-attempt refusal.

import (
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

type leaseFixture struct {
	server  *testHub
	team    seededTeam
	hostA   seededHost
	hostB   seededHost
	issueID string
}

func newLeaseFixture(t *testing.T) *leaseFixture {
	t.Helper()
	server := startTestHub(t)
	team := server.seedTeam()
	hostA := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	hostB := server.seedHost(team.teamID, team.admin.accessToken, "host-b",
		[]map[string]any{{"name": "dev-bot", "preset_id": "liangshen"}})
	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "lease fixture", "assignee_type": "agent", "assignee_id": stringField(hostA.agents[0], "id"),
	})
	return &leaseFixture{
		server: server, team: team, hostA: hostA, hostB: hostB, issueID: stringField(issue, "id"),
	}
}

func (f *leaseFixture) claim(token string, body map[string]any) apiResult {
	f.server.t.Helper()
	return f.server.api("POST", "/api/v1/teams/"+f.team.teamID+"/issues/"+f.issueID+"/claim",
		apiOptions{token: token, body: body})
}

func (f *leaseFixture) claimOK() apiResult {
	f.server.t.Helper()
	result := f.claim(f.hostA.hostToken, map[string]any{})
	if result.status != http.StatusOK {
		f.server.t.Fatalf("claim failed: %d %s", result.status, result.text)
	}
	return result
}

func (f *leaseFixture) settle(token string, body map[string]any) apiResult {
	f.server.t.Helper()
	return f.server.api("POST", "/api/v1/teams/"+f.team.teamID+"/issues/"+f.issueID+"/settle",
		apiOptions{token: token, body: body})
}

func TestClaimRefusesActiveLeaseHeldByAnotherAttempt(t *testing.T) {
	fixture := newLeaseFixture(t)
	first := fixture.claimOK()

	second := fixture.claim(fixture.hostA.hostToken, map[string]any{})
	if second.status != http.StatusConflict || errorCode(second.body) != string(CodeLeaseHeldByOther) {
		t.Fatalf("second claim: %d %s", second.status, second.text)
	}
	details := errorDetails(second.body)
	if numberField(details, "lease_expires_at") != numberField(first.body, "lease_expires_at") {
		t.Fatalf("the refusal did not name the active expiry: %s", second.text)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "running" {
		t.Fatalf("issue status: %s", status)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM agents WHERE id = ?",
		stringField(fixture.hostA.agents[0], "id")); status != "busy" {
		t.Fatalf("agent status: %s", status)
	}
}

func TestClaimRefusesHostThatDoesNotOwnTheAgent(t *testing.T) {
	fixture := newLeaseFixture(t)
	result := fixture.claim(fixture.hostB.hostToken, map[string]any{})
	if result.status != http.StatusForbidden || errorCode(result.body) != string(CodeHostMismatch) {
		t.Fatalf("foreign host claim: %d %s", result.status, result.text)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "assigned" {
		t.Fatalf("the refused claim changed the card: %s", status)
	}
}

func TestClaimRefusesNonClaimableStatus(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	settled := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "execution_attempt_id": stringField(claim.body, "execution_attempt_id"),
	})
	if settled.status != http.StatusOK {
		t.Fatalf("settle: %d %s", settled.status, settled.text)
	}
	result := fixture.claim(fixture.hostA.hostToken, map[string]any{})
	if result.status != http.StatusUnprocessableEntity || errorCode(result.body) != string(CodeInvalidState) {
		t.Fatalf("claim of a reviewed card: %d %s", result.status, result.text)
	}
}

func TestClaimNeverAnswersLeaseExpired(t *testing.T) {
	fixture := newLeaseFixture(t)
	fixture.claimOK()
	if _, err := fixture.server.hub.DB().Exec(
		"UPDATE issues SET lease_expires_at = ? WHERE id = ?", time.Now().UnixMilli()-1, fixture.issueID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}
	result := fixture.claim(fixture.hostA.hostToken, map[string]any{})
	if result.status != http.StatusConflict || errorCode(result.body) != string(CodeLeaseHeldByOther) {
		t.Fatalf("claim after expiry: %d %s", result.status, result.text)
	}
}

func TestReconnectClaimKeepsTheAttempt(t *testing.T) {
	fixture := newLeaseFixture(t)
	first := fixture.claimOK()

	reconnect := fixture.claim(fixture.hostA.hostToken, map[string]any{
		"execution_attempt_id": stringField(first.body, "execution_attempt_id"),
		"lease_token":          stringField(first.body, "lease_token"),
	})
	if reconnect.status != http.StatusOK {
		t.Fatalf("reconnect: %d %s", reconnect.status, reconnect.text)
	}
	if stringField(reconnect.body, "execution_attempt_id") != stringField(first.body, "execution_attempt_id") ||
		stringField(reconnect.body, "lease_token") != stringField(first.body, "lease_token") {
		t.Fatalf("reconnect minted a new attempt: %s", reconnect.text)
	}
	if numberField(reconnect.body, "lease_expires_at") < numberField(first.body, "lease_expires_at") {
		t.Fatalf("reconnect shortened the lease: %s", reconnect.text)
	}
}

func TestRenewLeaseAfterExpiryStepsTheCardBack(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	if _, err := fixture.server.hub.DB().Exec(
		"UPDATE issues SET lease_expires_at = ? WHERE id = ?", time.Now().UnixMilli()-1000, fixture.issueID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}

	renewed := fixture.server.api("POST",
		"/api/v1/teams/"+fixture.team.teamID+"/issues/"+fixture.issueID+"/renew-lease",
		apiOptions{token: fixture.hostA.hostToken, body: map[string]any{
			"lease_token": stringField(claim.body, "lease_token"),
		}})
	if renewed.status != http.StatusPreconditionFailed || errorCode(renewed.body) != string(CodeLeaseExpired) {
		t.Fatalf("renew after expiry: %d %s", renewed.status, renewed.text)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "waiting_host" {
		t.Fatalf("the card did not step back: %s", status)
	}
	agentStatus, _ := one[string](fixture.server, "SELECT status FROM agents WHERE id = ?",
		stringField(fixture.hostA.agents[0], "id"))
	if agentStatus != "idle" {
		t.Fatalf("agent status after expiry: %s", agentStatus)
	}

	reclaimed := fixture.claimOK()
	if stringField(reclaimed.body, "execution_attempt_id") == stringField(claim.body, "execution_attempt_id") {
		t.Fatalf("the reclaimed card reused the old attempt: %s", reclaimed.text)
	}
}

func TestRenewLeaseRefusals(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	base := "/api/v1/teams/" + fixture.team.teamID + "/issues/" + fixture.issueID + "/renew-lease"

	wrongToken := fixture.server.api("POST", base, apiOptions{
		token: fixture.hostA.hostToken, body: map[string]any{"lease_token": "not-the-lease"},
	})
	if wrongToken.status != http.StatusPreconditionFailed || errorCode(wrongToken.body) != string(CodeLeaseExpired) {
		t.Fatalf("wrong lease token: %d %s", wrongToken.status, wrongToken.text)
	}

	foreign := fixture.server.api("POST", base, apiOptions{
		token: fixture.hostB.hostToken, body: map[string]any{"lease_token": stringField(claim.body, "lease_token")},
	})
	if foreign.status != http.StatusForbidden || errorCode(foreign.body) != string(CodeHostMismatch) {
		t.Fatalf("foreign renew: %d %s", foreign.status, foreign.text)
	}

	missing := fixture.server.api("POST", base, apiOptions{token: fixture.hostA.hostToken, body: map[string]any{}})
	if missing.status != http.StatusBadRequest || errorCode(missing.body) != string(CodeValidationFailed) {
		t.Fatalf("missing lease token: %d %s", missing.status, missing.text)
	}

	renewed := fixture.server.api("POST", base, apiOptions{
		token: fixture.hostA.hostToken, body: map[string]any{"lease_token": stringField(claim.body, "lease_token")},
	})
	if renewed.status != http.StatusOK {
		t.Fatalf("renew: %d %s", renewed.status, renewed.text)
	}
	if numberField(renewed.body, "lease_expires_at") <= numberField(claim.body, "lease_expires_at") {
		t.Fatalf("renew did not extend the lease: %s", renewed.text)
	}
}

func TestSettleIsIdempotentPerAttempt(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	attempt := stringField(claim.body, "execution_attempt_id")

	first := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "summary": "all checks passed", "execution_attempt_id": attempt,
	})
	if first.status != http.StatusOK || stringField(first.body, "status") != "in_review" {
		t.Fatalf("settle: %d %s", first.status, first.text)
	}
	if lease, _ := one[*string](fixture.server, "SELECT lease_token FROM issues WHERE id = ?", fixture.issueID); lease != nil {
		t.Fatalf("the lease survived settlement: %v", lease)
	}
	summary, _ := one[string](fixture.server, "SELECT execution_summary FROM issues WHERE id = ?", fixture.issueID)
	if summary != "all checks passed" {
		t.Fatalf("summary: %q", summary)
	}

	replay := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "summary": "all checks passed", "execution_attempt_id": attempt,
	})
	if replay.status != http.StatusOK || stringField(replay.body, "status") != "in_review" {
		t.Fatalf("replayed settle: %d %s", replay.status, replay.text)
	}
	var settlements int
	if err := fixture.server.hub.DB().QueryRow(
		"SELECT COUNT(*) FROM activity WHERE issue_id = ? AND activity_type = 'issue.settled_in_review'",
		fixture.issueID).Scan(&settlements); err != nil {
		t.Fatalf("count settlements: %v", err)
	}
	if settlements != 1 {
		t.Fatalf("a replay wrote a second settlement: %d", settlements)
	}
}

func TestSettleRefusesForeignExecutionAttempt(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	attempt := stringField(claim.body, "execution_attempt_id")

	foreign := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "execution_attempt_id": "attempt-from-an-earlier-round",
	})
	if foreign.status != http.StatusPreconditionFailed || errorCode(foreign.body) != string(CodeLeaseExpired) {
		t.Fatalf("foreign attempt: %d %s", foreign.status, foreign.text)
	}
	if !strings.Contains(errorMessage(foreign.body), "not the one running") {
		t.Fatalf("the refusal does not explain itself: %s", foreign.text)
	}
	details := errorDetails(foreign.body)
	if stringField(details, "execution_attempt_id") != attempt {
		t.Fatalf("the refusal did not name the running attempt: %s", foreign.text)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "running" {
		t.Fatalf("the refused settlement changed the card: %s", status)
	}
}

func TestSettleAfterLeaseExpiry(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	if _, err := fixture.server.hub.DB().Exec(
		"UPDATE issues SET lease_expires_at = ? WHERE id = ?", time.Now().UnixMilli()-1000, fixture.issueID); err != nil {
		t.Fatalf("expire lease: %v", err)
	}

	refused := fixture.settle(fixture.hostA.hostToken, map[string]any{"outcome": "succeeded"})
	if refused.status != http.StatusPreconditionFailed || errorCode(refused.body) != string(CodeLeaseExpired) {
		t.Fatalf("expired settlement: %d %s", refused.status, refused.text)
	}
	if status, _ := one[string](fixture.server, "SELECT status FROM issues WHERE id = ?", fixture.issueID); status != "waiting_host" {
		t.Fatalf("the card did not step back: %s", status)
	}

	// A late write-back that names the running attempt is still honoured.
	late := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "execution_attempt_id": stringField(claim.body, "execution_attempt_id"),
	})
	if late.status != http.StatusOK || stringField(late.body, "status") != "in_review" {
		t.Fatalf("late write-back: %d %s", late.status, late.text)
	}
}

func TestSettleFailedOutcomeAndRetry(t *testing.T) {
	fixture := newLeaseFixture(t)
	claim := fixture.claimOK()
	failed := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "failed", "error": "tests failed",
		"execution_attempt_id": stringField(claim.body, "execution_attempt_id"),
	})
	if failed.status != http.StatusOK || stringField(failed.body, "status") != "failed" {
		t.Fatalf("failed settlement: %d %s", failed.status, failed.text)
	}
	failure, _ := one[string](fixture.server, "SELECT failure_error FROM issues WHERE id = ?", fixture.issueID)
	if failure != "tests failed" {
		t.Fatalf("failure_error: %q", failure)
	}

	retried := fixture.server.api("PATCH", "/api/v1/teams/"+fixture.team.teamID+"/issues/"+fixture.issueID,
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{"status": "assigned"}})
	if retried.status != http.StatusOK {
		t.Fatalf("retry: %d %s", retried.status, retried.text)
	}
	if attempt, _ := one[*string](fixture.server, "SELECT execution_attempt_id FROM issues WHERE id = ?", fixture.issueID); attempt != nil {
		t.Fatalf("the retry kept the failed attempt: %v", attempt)
	}
	if failure, _ := one[*string](fixture.server, "SELECT failure_error FROM issues WHERE id = ?", fixture.issueID); failure != nil {
		t.Fatalf("the retry kept the failure text: %v", failure)
	}
	fixture.claimOK()

	// Only a failed card can be retried.
	second := fixture.server.api("PATCH", "/api/v1/teams/"+fixture.team.teamID+"/issues/"+fixture.issueID,
		apiOptions{token: fixture.team.admin.accessToken, body: map[string]any{"status": "assigned"}})
	if second.status != http.StatusUnprocessableEntity || errorCode(second.body) != string(CodeInvalidState) {
		t.Fatalf("retry of a running card: %d %s", second.status, second.text)
	}
}

func TestSettleValidatesOutcomeAndSummary(t *testing.T) {
	fixture := newLeaseFixture(t)
	fixture.claimOK()

	badOutcome := fixture.settle(fixture.hostA.hostToken, map[string]any{"outcome": "maybe"})
	if badOutcome.status != http.StatusBadRequest || errorCode(badOutcome.body) != string(CodeValidationFailed) {
		t.Fatalf("bad outcome: %d %s", badOutcome.status, badOutcome.text)
	}
	missingOutcome := fixture.settle(fixture.hostA.hostToken, map[string]any{})
	if missingOutcome.status != http.StatusBadRequest {
		t.Fatalf("missing outcome: %d %s", missingOutcome.status, missingOutcome.text)
	}
	longSummary := strings.Repeat("x", ExecutionSummaryLimit+1)
	tooLong := fixture.settle(fixture.hostA.hostToken, map[string]any{
		"outcome": "succeeded", "summary": longSummary,
	})
	if tooLong.status != http.StatusBadRequest || errorCode(tooLong.body) != string(CodeValidationFailed) {
		t.Fatalf("long summary: %d %s", tooLong.status, tooLong.text)
	}
}

func TestConcurrentClaimsHaveOneWinner(t *testing.T) {
	fixture := newLeaseFixture(t)
	const contenders = 5
	results := make([]apiResult, contenders)
	var wait sync.WaitGroup
	for index := 0; index < contenders; index++ {
		wait.Add(1)
		go func(slot int) {
			defer wait.Done()
			results[slot] = fixture.claim(fixture.hostA.hostToken, map[string]any{})
		}(index)
	}
	wait.Wait()
	winners := 0
	for index, result := range results {
		switch {
		case result.status == http.StatusOK:
			winners++
		case result.status == http.StatusConflict && errorCode(result.body) == string(CodeLeaseHeldByOther):
		default:
			t.Fatalf("contender %d: %d %s", index, result.status, result.text)
		}
	}
	if winners != 1 {
		t.Fatalf("expected exactly one winner, got %d", winners)
	}
	var attempt string
	if err := fixture.server.hub.DB().QueryRow("SELECT execution_attempt_id FROM issues WHERE id = ?", fixture.issueID).Scan(&attempt); err != nil {
		t.Fatalf("read attempt: %v", err)
	}
	if attempt == "" {
		t.Fatalf("the winner left no attempt id")
	}
}
