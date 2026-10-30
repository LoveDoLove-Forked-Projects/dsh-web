package hub

// Bootstrap against the real service. The first admin is named by the email
// address whose assertions they sign in with: the hub resolves the address through
// the account-service admin API the invite uses and writes the row bound to it, so
// the deployment's first administrator can enter instead of dead-ending on an
// unbound row.

import (
	"net/http"
	"strings"
	"testing"
)

// bootstrapRequest posts the one-shot call with the token a first deployment holds.
func bootstrapRequest(server *testHub, email string) apiResult {
	server.t.Helper()
	return server.api("POST", "/api/v1/bootstrap", apiOptions{
		headers: map[string]string{"X-Bootstrap-Token": bootstrapToken},
		body:    map[string]any{"team_name": "Team Test", "team_slug": "team-test", "email": email},
	})
}

func TestEmailBootstrapCreatesTheSignableAdmin(t *testing.T) {
	key := newAccountKey(t)
	server := startTestHub(t, startOptions{jwks: accountJWKS(key)})
	const adminEmail = "first.admin@example.test"
	server.fake.addAccountUser(adminEmail, accountSubject)

	created := bootstrapRequest(server, adminEmail)
	if created.status != http.StatusCreated {
		t.Fatalf("bootstrap: %d %s", created.status, created.text)
	}
	row, _ := created.body["member"].(map[string]any)
	adminID := stringField(row, "id")
	if stringField(row, "role") != "admin" || stringField(row, "account_user_id") != accountSubject {
		t.Fatalf("the bootstrap admin is not the bound admin: %s", created.text)
	}

	// The address is resolved through the admin endpoint the invite uses, carrying
	// the admin token this hub is configured with.
	lookups := 0
	for _, call := range server.fake.recorded() {
		if call.URL != accountServiceBase+accountLookupPath {
			continue
		}
		lookups++
		if call.Header.Get("x-admin-token") != accountAdminToken {
			t.Fatalf("the lookup did not carry the admin token: %v", call.Header)
		}
		if !strings.Contains(call.Body, adminEmail) {
			t.Fatalf("the lookup did not carry the address: %s", call.Body)
		}
	}
	if lookups != 1 {
		t.Fatalf("bootstrap made %d admin lookups, want 1", lookups)
	}

	// The members table still demands a GitHub identity, so the row carries the
	// placeholder derived from the account: a negative id and an "account:" handle.
	// Deriving it from the account id is what keeps one account's placeholder the
	// same in every team it joins.
	githubID, githubHandle := placeholderGithubIdentity(accountSubject)
	if stored, _ := one[int64](server, "SELECT github_user_id FROM members WHERE id = ?", adminID); stored != githubID {
		t.Fatalf("github_user_id %d, want %d", stored, githubID)
	}
	if stored, _ := one[string](server, "SELECT github_username FROM members WHERE id = ?", adminID); stored != githubHandle {
		t.Fatalf("github_username %q, want %q", stored, githubHandle)
	}
	if stored, _ := one[string](server, "SELECT display_name FROM members WHERE id = ?", adminID); stored != emailLocalPart(adminEmail) {
		t.Fatalf("display_name %q, want %q", stored, emailLocalPart(adminEmail))
	}
	if status, _ := one[string](server, "SELECT status FROM members WHERE id = ?", adminID); status != "active" {
		t.Fatalf("the bootstrap admin is not active: %q", status)
	}

	// The point of the change: the account signs in on its first assertion, and the
	// session belongs to the admin the hub just created.
	signedIn := server.signInAssertion(t, key.assertion(t, assertionOptions{}))
	if signedIn.status != http.StatusOK {
		t.Fatalf("account sign-in after bootstrap: %d %s", signedIn.status, signedIn.text)
	}
	signedInRow, _ := signedIn.body["member"].(map[string]any)
	if stringField(signedInRow, "id") != adminID || stringField(signedInRow, "role") != "admin" {
		t.Fatalf("the assertion signed in as %v: %s", signedInRow["id"], signedIn.text)
	}
	me := server.api("GET", "/api/v1/me", apiOptions{token: stringField(signedIn.body, "access_token")})
	if me.status != http.StatusOK {
		t.Fatalf("me: %d %s", me.status, me.text)
	}
}

func TestBootstrapUnknownEmailIsUserNotFound(t *testing.T) {
	server := startTestHub(t)

	refused := bootstrapRequest(server, "nobody@example.test")
	if refused.status != http.StatusNotFound || errorCode(refused.body) != string(CodeUserNotFound) {
		t.Fatalf("unknown address: %d %s", refused.status, refused.text)
	}
	message := errorMessage(refused.body)
	for _, expected := range []string{"Whale", "Apple", "bootstrap"} {
		if !strings.Contains(message, expected) {
			t.Fatalf("the refusal does not tell the operator what to do (%q missing): %s", expected, message)
		}
	}
	if details := errorDetails(refused.body); stringField(details, "email") != "nobody@example.test" {
		t.Fatalf("the refusal names %v", details["email"])
	}

	// The first admin arrives with a real account or not at all.
	if teams, _ := one[int64](server, "SELECT COUNT(*) FROM teams"); teams != 0 {
		t.Fatalf("a refused bootstrap created %d team(s)", teams)
	}
	if members, _ := one[int64](server, "SELECT COUNT(*) FROM members"); members != 0 {
		t.Fatalf("a refused bootstrap created %d member(s)", members)
	}
}

func TestBootstrapWhenTheAccountServiceFailsIsAccountUnavailable(t *testing.T) {
	t.Run("upstream error status", func(t *testing.T) {
		server := startTestHub(t)
		server.fake.setLookupStatus(http.StatusInternalServerError)
		refused := bootstrapRequest(server, "anyone@example.test")
		if refused.status != http.StatusBadGateway || errorCode(refused.body) != string(CodeAccountUnavailable) {
			t.Fatalf("upstream 500: %d %s", refused.status, refused.text)
		}
		if strings.Contains(refused.text, "injected") {
			t.Fatalf("the upstream body reached the client: %s", refused.text)
		}
		if teams, _ := one[int64](server, "SELECT COUNT(*) FROM teams"); teams != 0 {
			t.Fatalf("a refused bootstrap created %d team(s)", teams)
		}
	})

	t.Run("transport failure", func(t *testing.T) {
		server := startTestHub(t)
		server.fake.setLookupUnreachable()
		refused := bootstrapRequest(server, "anyone@example.test")
		if refused.status != http.StatusBadGateway || errorCode(refused.body) != string(CodeAccountUnavailable) {
			t.Fatalf("unreachable lookup: %d %s", refused.status, refused.text)
		}
		if strings.Contains(refused.text, "connection refused") ||
			strings.Contains(refused.text, "203.0.113.7") {
			t.Fatalf("the transport error reached the client: %s", refused.text)
		}
	})
}

func TestBootstrapWithoutTheAccountServiceSettingsIsNotConfigured(t *testing.T) {
	t.Run("both settings missing", func(t *testing.T) {
		server := startTestHub(t, startOptions{env: map[string]string{
			"ACCOUNT_SERVICE_BASE": "", "ACCOUNT_ADMIN_TOKEN": "",
		}})
		closed := bootstrapRequest(server, "anyone@example.test")
		if closed.status != http.StatusServiceUnavailable || errorCode(closed.body) != string(CodeNotConfigured) {
			t.Fatalf("bootstrap without the admin API: %d %s", closed.status, closed.text)
		}
		message := errorMessage(closed.body)
		for _, expected := range []string{"ACCOUNT_SERVICE_BASE", "ACCOUNT_ADMIN_TOKEN"} {
			if !strings.Contains(message, expected) {
				t.Fatalf("the refusal does not name %q: %s", expected, message)
			}
		}
	})

	t.Run("only the admin token missing", func(t *testing.T) {
		server := startTestHub(t, startOptions{env: map[string]string{"ACCOUNT_ADMIN_TOKEN": ""}})
		closed := bootstrapRequest(server, "anyone@example.test")
		if closed.status != http.StatusServiceUnavailable || errorCode(closed.body) != string(CodeNotConfigured) {
			t.Fatalf("bootstrap without the admin token: %d %s", closed.status, closed.text)
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
