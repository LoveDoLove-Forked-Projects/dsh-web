package hub

// The email invite: an admin names an address, the account service resolves it,
// and the membership lands bound and active, so the invitee's first assertion
// sign-in finds the row instead of 409 NOT_LINKED.

import (
	"net/http"
	"strings"
	"testing"
)

func inviteRequest(server *testHub, teamID, token, email, role string) apiResult {
	return server.api("POST", "/api/v1/teams/"+teamID+"/members/invite", apiOptions{
		token: token, body: map[string]any{"email": email, "role": role},
	})
}

func TestInviteBindsTheAccountAndSignsTheInviteeIn(t *testing.T) {
	key := newAccountKey(t)
	server := startTestHub(t, startOptions{jwks: accountJWKS(key)})
	team := server.seedTeam()

	const email = "welcome@example.test"
	const sub = "acct_welcome"
	server.fake.addAccountUser(email, sub)

	invited := inviteRequest(server, team.teamID, team.admin.accessToken, email, "member")
	if invited.status != http.StatusCreated {
		t.Fatalf("invite: %d %s", invited.status, invited.text)
	}
	row, _ := invited.body["member"].(map[string]any)
	if value := stringField(row, "account_user_id"); value != sub {
		t.Fatalf("the invited row is bound to %q, want %q", value, sub)
	}
	if stringField(row, "status") != "active" {
		t.Fatalf("the invited row is not active: %s", invited.text)
	}
	if stringField(row, "role") != "member" {
		t.Fatalf("the invited row does not carry the requested role: %s", invited.text)
	}
	if stringField(row, "display_name") != "welcome" {
		t.Fatalf("the invited row is not named after the address: %s", invited.text)
	}
	if id := numberField(row, "github_user_id"); id >= 0 {
		t.Fatalf("an email-invited row claims a real GitHub id: %d", id)
	}

	// The invite asked the contract's endpoint, with the admin token, for the email.
	var lookup *recordedCall
	for _, call := range server.fake.recorded() {
		if strings.HasSuffix(call.URL, accountLookupPath) {
			found := call
			lookup = &found
		}
	}
	if lookup == nil {
		t.Fatal("the invite never called the account service lookup")
	}
	if lookup.URL != accountServiceBase+accountLookupPath || lookup.Method != "POST" {
		t.Fatalf("the lookup was %s %s", lookup.Method, lookup.URL)
	}
	if value := lookup.Header.Get("x-admin-token"); value != accountAdminToken {
		t.Fatalf("the lookup carried the admin token %q", value)
	}
	if !strings.Contains(lookup.Body, email) {
		t.Fatalf("the lookup did not name the address: %s", lookup.Body)
	}

	// The invitee signs in with the assertion the account service mints for that
	// account id: one request, no second step to make the invite work.
	signedIn := server.signInAssertion(t, key.assertion(t, assertionOptions{sub: sub}))
	if signedIn.status != http.StatusOK {
		t.Fatalf("the invited account cannot sign in: %d %s", signedIn.status, signedIn.text)
	}
	signInRow, _ := signedIn.body["member"].(map[string]any)
	if stringField(signInRow, "id") != stringField(row, "id") {
		t.Fatalf("the invited account signed in as %v: %s", signInRow["id"], signedIn.text)
	}

	// The role is the requested one, not a default.
	server.fake.addAccountUser("second@example.test", "acct_second")
	second := inviteRequest(server, team.teamID, team.admin.accessToken, "second@example.test", "admin")
	if second.status != http.StatusCreated {
		t.Fatalf("second invite: %d %s", second.status, second.text)
	}
	if role := stringField(second.body["member"].(map[string]any), "role"); role != "admin" {
		t.Fatalf("the second invite carries role %q", role)
	}

	// A plain member cannot invite anyone.
	inviteeToken, _ := signedIn.body["access_token"].(string)
	denied := inviteRequest(server, team.teamID, inviteeToken, "third@example.test", "member")
	if denied.status != http.StatusForbidden || errorCode(denied.body) != string(CodeForbidden) {
		t.Fatalf("plain member invite: %d %s", denied.status, denied.text)
	}
}

func TestInviteTwiceIsAlreadyMember(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	const email = "repeat@example.test"
	server.fake.addAccountUser(email, "acct_repeat")

	first := inviteRequest(server, team.teamID, team.admin.accessToken, email, "member")
	if first.status != http.StatusCreated {
		t.Fatalf("first invite: %d %s", first.status, first.text)
	}
	firstRow, _ := first.body["member"].(map[string]any)

	again := inviteRequest(server, team.teamID, team.admin.accessToken, email, "member")
	if again.status != http.StatusConflict || errorCode(again.body) != string(CodeAlreadyMember) {
		t.Fatalf("second invite: %d %s", again.status, again.text)
	}
	if details := errorDetails(again.body); stringField(details, "member_id") != stringField(firstRow, "id") {
		t.Fatalf("the refusal names %v: %s", details["member_id"], again.text)
	}

	// The account is the identity, so a second address resolving to it is refused
	// as well.
	server.fake.addAccountUser("alias@example.test", "acct_repeat")
	alias := inviteRequest(server, team.teamID, team.admin.accessToken, "alias@example.test", "member")
	if alias.status != http.StatusConflict || errorCode(alias.body) != string(CodeAlreadyMember) {
		t.Fatalf("aliased invite: %d %s", alias.status, alias.text)
	}
	if details := errorDetails(alias.body); stringField(details, "member_id") != stringField(firstRow, "id") {
		t.Fatalf("the aliased refusal names %v: %s", details["member_id"], alias.text)
	}
}

func TestInviteUnknownEmailIsUserNotFound(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	missing := inviteRequest(server, team.teamID, team.admin.accessToken, "nobody@example.test", "member")
	if missing.status != http.StatusNotFound || errorCode(missing.body) != string(CodeUserNotFound) {
		t.Fatalf("unknown address: %d %s", missing.status, missing.text)
	}
	message := errorMessage(missing.body)
	for _, expected := range []string{"Whale", "Apple", "invite again"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("the refusal does not tell the admin what to do (%q missing): %s", expected, message)
		}
	}
	if details := errorDetails(missing.body); stringField(details, "email") != "nobody@example.test" {
		t.Fatalf("the refusal names %v", details["email"])
	}
}

func TestInviteWhenTheAccountServiceFailsIsAccountUnavailable(t *testing.T) {
	t.Run("upstream error status", func(t *testing.T) {
		server := startTestHub(t)
		team := server.seedTeam()
		server.fake.setLookupStatus(http.StatusInternalServerError)
		refused := inviteRequest(server, team.teamID, team.admin.accessToken, "anyone@example.test", "member")
		if refused.status != http.StatusBadGateway || errorCode(refused.body) != string(CodeAccountUnavailable) {
			t.Fatalf("upstream 500: %d %s", refused.status, refused.text)
		}
		if strings.Contains(refused.text, "injected") {
			t.Fatalf("the upstream body reached the client: %s", refused.text)
		}
	})

	t.Run("admin token rejected", func(t *testing.T) {
		server := startTestHub(t)
		team := server.seedTeam()
		server.fake.setLookupStatus(http.StatusUnauthorized)
		refused := inviteRequest(server, team.teamID, team.admin.accessToken, "anyone@example.test", "member")
		if refused.status != http.StatusBadGateway || errorCode(refused.body) != string(CodeAccountUnavailable) {
			t.Fatalf("upstream 401: %d %s", refused.status, refused.text)
		}
	})

	t.Run("transport failure", func(t *testing.T) {
		server := startTestHub(t)
		team := server.seedTeam()
		server.fake.setLookupUnreachable()
		refused := inviteRequest(server, team.teamID, team.admin.accessToken, "anyone@example.test", "member")
		if refused.status != http.StatusBadGateway || errorCode(refused.body) != string(CodeAccountUnavailable) {
			t.Fatalf("unreachable lookup: %d %s", refused.status, refused.text)
		}
	})
}

func TestInviteWithoutTheAccountServiceSettingsIsNotConfigured(t *testing.T) {
	t.Run("both settings missing", func(t *testing.T) {
		server := startTestHub(t)
		team := server.seedTeam()
		// Bootstrap resolves the first admin's address through the same admin API, so
		// a hub that never had these settings cannot reach this state at all. The
		// settings are closed on the running hub instead: that is what an operator
		// who removes the token after the team exists leaves behind.
		server.setAccountAdminAPI("", "")
		closed := inviteRequest(server, team.teamID, team.admin.accessToken, "anyone@example.test", "member")
		if closed.status != http.StatusServiceUnavailable || errorCode(closed.body) != string(CodeNotConfigured) {
			t.Fatalf("invite without settings: %d %s", closed.status, closed.text)
		}
		message := errorMessage(closed.body)
		for _, expected := range []string{"ACCOUNT_SERVICE_BASE", "ACCOUNT_ADMIN_TOKEN"} {
			if !strings.Contains(message, expected) {
				t.Fatalf("the refusal does not name %q: %s", expected, message)
			}
		}
	})

	t.Run("only the admin token missing", func(t *testing.T) {
		server := startTestHub(t)
		team := server.seedTeam()
		server.setAccountAdminAPI(accountServiceBase, "")
		closed := inviteRequest(server, team.teamID, team.admin.accessToken, "anyone@example.test", "member")
		if closed.status != http.StatusServiceUnavailable || errorCode(closed.body) != string(CodeNotConfigured) {
			t.Fatalf("invite without the token: %d %s", closed.status, closed.text)
		}
		message := errorMessage(closed.body)
		if !strings.Contains(message, "ACCOUNT_ADMIN_TOKEN") {
			t.Fatalf("the refusal does not name the missing token: %s", message)
		}
		if strings.Contains(message, "ACCOUNT_SERVICE_BASE") {
			t.Fatalf("the refusal names a setting that is present: %s", message)
		}
	})
}

func TestInviteAuditsTheJoinWithoutTheAddress(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.fake.addAccountUser("audit.target@example.test", "acct_audit")

	invited := inviteRequest(server, team.teamID, team.admin.accessToken, "audit.target@example.test", "member")
	if invited.status != http.StatusCreated {
		t.Fatalf("invite: %d %s", invited.status, invited.text)
	}
	audit := ""
	for _, line := range server.loggedLines() {
		if strings.Contains(line, "member.joined") {
			audit = line
			break
		}
	}
	if audit == "" {
		t.Fatal("the invite wrote no audit line")
	}
	if !strings.Contains(audit, "[audit] member.joined") {
		t.Fatalf("the audit line is not tagged: %s", audit)
	}
	if strings.Contains(audit, "audit.target@example.test") {
		t.Fatalf("the audit line carries the whole address: %s", audit)
	}
	if !strings.Contains(audit, "email=a***@example.test") {
		t.Fatalf("the audit line does not carry the masked address: %s", audit)
	}
	invitedRow, _ := invited.body["member"].(map[string]any)
	if !strings.Contains(audit, "member="+stringField(invitedRow, "id")) {
		t.Fatalf("the audit line does not name the member: %s", audit)
	}
	if !strings.Contains(audit, "account=acct_audit") {
		t.Fatalf("the audit line does not name the account: %s", audit)
	}
	if !strings.Contains(audit, "actor="+stringField(team.admin.member, "id")) {
		t.Fatalf("the audit line does not name the admin: %s", audit)
	}
}
