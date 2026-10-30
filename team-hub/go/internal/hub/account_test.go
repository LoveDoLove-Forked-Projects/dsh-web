package hub

// Account-service assertions against the real service: every assertion is signed
// with a real P-256 key and verified through the JWKS the fake account service
// publishes over the outbound seam.

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

func boundAccountFixture(t *testing.T) (*testHub, *accountKey, seededTeam) {
	t.Helper()
	key := newAccountKey(t)
	server := startTestHub(t, startOptions{jwks: accountJWKS(key)})
	team := server.seedTeam()
	server.bindAccount(team.admin.accessToken, key)
	return server, key, team
}

func (h *testHub) signInAssertion(t *testing.T, assertion string) apiResult {
	t.Helper()
	return h.api("POST", "/auth/account", apiOptions{body: map[string]any{"assertion": assertion}})
}

func sessionCount(t *testing.T, server *testHub) int {
	t.Helper()
	var count int
	if err := server.hub.DB().QueryRow("SELECT COUNT(*) FROM refresh_tokens").Scan(&count); err != nil {
		t.Fatalf("count sessions: %v", err)
	}
	return count
}

func TestAccountAssertionNegatives(t *testing.T) {
	server, key, _ := boundAccountFixture(t)

	t.Run("another key with the published kid", func(t *testing.T) {
		impostor := newAccountKey(t)
		before := sessionCount(t, server)
		result := server.signInAssertion(t, impostor.assertion(t, assertionOptions{kid: key.kid}))
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("impostor signature: %d %s", result.status, result.text)
		}
		if message := errorMessage(result.body); !strings.Contains(message, "signature") {
			t.Fatalf("the refusal does not mention the signature: %s", result.text)
		}
		if after := sessionCount(t, server); after != before {
			t.Fatalf("a refused assertion opened a session: %d -> %d", before, after)
		}
	})

	t.Run("another audience", func(t *testing.T) {
		result := server.signInAssertion(t, key.assertion(t, assertionOptions{aud: "another-service"}))
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("foreign audience: %d %s", result.status, result.text)
		}
		if message := errorMessage(result.body); !strings.Contains(message, "audience") {
			t.Fatalf("the refusal does not mention the audience: %s", result.text)
		}
	})

	t.Run("another issuer", func(t *testing.T) {
		foreignIssuer := "https://account.example.evil"
		result := server.signInAssertion(t, key.assertion(t, assertionOptions{iss: foreignIssuer}))
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("foreign issuer: %d %s", result.status, result.text)
		}
		if details := errorDetails(result.body); stringField(details, "issuer") != foreignIssuer {
			t.Fatalf("the refusal did not name the issuer: %s", result.text)
		}
	})

	t.Run("an expired assertion", func(t *testing.T) {
		expired := key.assertion(t, assertionOptions{now: time.Now().Add(-time.Hour).UnixMilli(), ttl: 60})
		result := server.signInAssertion(t, expired)
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("expired assertion: %d %s", result.status, result.text)
		}
		if message := errorMessage(result.body); !strings.Contains(message, "expired") {
			t.Fatalf("the refusal does not mention expiry: %s", result.text)
		}
	})

	t.Run("an unpublished key id", func(t *testing.T) {
		result := server.signInAssertion(t, key.assertion(t, assertionOptions{kid: "account-key-not-published"}))
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("unpublished kid: %d %s", result.status, result.text)
		}
		if message := errorMessage(result.body); !strings.Contains(message, "key id") {
			t.Fatalf("the refusal does not mention the key id: %s", result.text)
		}
	})

	t.Run("a malformed assertion", func(t *testing.T) {
		result := server.signInAssertion(t, "not-a-jws")
		if result.status != http.StatusUnauthorized || errorCode(result.body) != string(CodeUnauthorized) {
			t.Fatalf("malformed assertion: %d %s", result.status, result.text)
		}
	})
}

func TestVerifiedAssertionOpensASessionAndNeverCreatesAMember(t *testing.T) {
	server, key, team := boundAccountFixture(t)
	before := sessionCount(t, server)
	signedIn := server.signInAssertion(t, key.assertion(t, assertionOptions{}))
	if signedIn.status != http.StatusOK {
		t.Fatalf("account sign-in: %d %s", signedIn.status, signedIn.text)
	}
	if stringField(signedIn.body, "token_type") != "Bearer" || numberField(signedIn.body, "expires_in") != 7200 {
		t.Fatalf("token shape: %s", signedIn.text)
	}
	if !strings.HasPrefix(stringField(signedIn.body, "access_token"), "th_usr_") ||
		!strings.HasPrefix(stringField(signedIn.body, "refresh_token"), "th_ref_") {
		t.Fatalf("token prefixes: %s", signedIn.text)
	}
	member, _ := signedIn.body["member"].(map[string]any)
	if stringField(member, "id") != stringField(team.admin.member, "id") {
		t.Fatalf("the session belongs to another member: %s", signedIn.text)
	}
	if after := sessionCount(t, server); after != before+1 {
		t.Fatalf("session count: %d -> %d", before, after)
	}
	me := server.api("GET", "/api/v1/me", apiOptions{token: stringField(signedIn.body, "access_token")})
	if me.status != http.StatusOK {
		t.Fatalf("session from an assertion: %d %s", me.status, me.text)
	}

	// An unbound account is refused and creates nothing.
	membersBefore, _ := one[int64](server, "SELECT COUNT(*) FROM members")
	unknown := server.signInAssertion(t, key.assertion(t, assertionOptions{sub: "acct_nobody"}))
	if unknown.status != http.StatusConflict || errorCode(unknown.body) != string(CodeNotLinked) {
		t.Fatalf("unlinked account: %d %s", unknown.status, unknown.text)
	}
	if details := errorDetails(unknown.body); stringField(details, "sub") != "acct_nobody" {
		t.Fatalf("the refusal did not carry the subject: %s", unknown.text)
	}
	membersAfter, _ := one[int64](server, "SELECT COUNT(*) FROM members")
	if membersAfter != membersBefore {
		t.Fatalf("a verified assertion created %d member(s)", membersAfter-membersBefore)
	}
	if bound, _ := one[int64](server, "SELECT COUNT(*) FROM members WHERE account_user_id IS NOT NULL"); bound != 1 {
		t.Fatalf("bound members: %d", bound)
	}
}

func TestLinkRules(t *testing.T) {
	server, key, team := boundAccountFixture(t)
	// The invite route binds an account, so the binding rules need the other real
	// shape: a member that entered through GitHub and has not bound one yet.
	member := server.unboundMemberAndLogin(team.teamID, "hubot")

	taken := server.api("POST", "/auth/account/link", apiOptions{
		token: member.accessToken,
		body:  map[string]any{"assertion": key.assertion(t, assertionOptions{})},
	})
	if taken.status != http.StatusConflict || errorCode(taken.body) != string(CodeIdentityTaken) {
		t.Fatalf("identity taken: %d %s", taken.status, taken.text)
	}
	if bound, _ := one[*string](server, "SELECT account_user_id FROM members WHERE id = ?",
		stringField(member.member, "id")); bound != nil {
		t.Fatalf("a refused link wrote the binding: %v", bound)
	}

	idempotent := server.api("POST", "/auth/account/link", apiOptions{
		token: team.admin.accessToken,
		body:  map[string]any{"assertion": key.assertion(t, assertionOptions{})},
	})
	if idempotent.status != http.StatusOK {
		t.Fatalf("repeated link: %d %s", idempotent.status, idempotent.text)
	}
	linked, _ := idempotent.body["member"].(map[string]any)
	if stringField(linked, "id") != stringField(team.admin.member, "id") {
		t.Fatalf("repeated link named another member: %s", idempotent.text)
	}
	if bound, _ := one[int64](server, "SELECT COUNT(*) FROM members WHERE account_user_id = ?", accountSubject); bound != 1 {
		t.Fatalf("binding count: %d", bound)
	}

	// A member already bound to one account cannot be rebound to another.
	conflict := server.api("POST", "/auth/account/link", apiOptions{
		token: team.admin.accessToken,
		body:  map[string]any{"assertion": key.assertion(t, assertionOptions{sub: "acct_second"})},
	})
	if conflict.status != http.StatusConflict || errorCode(conflict.body) != string(CodeConflict) {
		t.Fatalf("rebinding: %d %s", conflict.status, conflict.text)
	}
	if bound, _ := one[string](server, "SELECT account_user_id FROM members WHERE id = ?",
		stringField(team.admin.member, "id")); bound != accountSubject {
		t.Fatalf("the binding moved: %s", bound)
	}
}

func TestAccountRoutesAreClosedWithoutTheAccountService(t *testing.T) {
	server := startTestHub(t, startOptions{env: map[string]string{
		"ACCOUNT_JWKS_URL": "", "ACCOUNT_ISSUER": "", "ACCOUNT_AUDIENCE": "",
	}})
	team := server.seedTeam()
	key := newAccountKey(t)
	assertion := key.assertion(t, assertionOptions{})

	signIn := server.signInAssertion(t, assertion)
	if signIn.status != http.StatusServiceUnavailable || errorCode(signIn.body) != string(CodeNotConfigured) {
		t.Fatalf("account sign-in without settings: %d %s", signIn.status, signIn.text)
	}
	link := server.api("POST", "/auth/account/link", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"assertion": assertion},
	})
	if link.status != http.StatusServiceUnavailable || errorCode(link.body) != string(CodeNotConfigured) {
		t.Fatalf("account link without settings: %d %s", link.status, link.text)
	}
}

func TestAccountServiceUnavailable(t *testing.T) {
	key := newAccountKey(t)
	server := startTestHub(t, startOptions{jwks: accountJWKS(key)})
	team := server.seedTeam()
	server.bindAccount(team.admin.accessToken, key)

	// The account service stops answering, so a kid the cache does not hold forces
	// a fetch that fails.
	server.fake.mu.Lock()
	server.fake.jwks = nil
	server.fake.mu.Unlock()
	result := server.signInAssertion(t, key.assertion(t, assertionOptions{kid: "rotated-kid"}))
	if result.status != http.StatusBadGateway || errorCode(result.body) != string(CodeAccountUnavailable) {
		t.Fatalf("unreachable JWKS: %d %s", result.status, result.text)
	}
}

func TestGitHubRoutesAreClosedWithoutOAuthApp(t *testing.T) {
	server := startTestHub(t, startOptions{env: map[string]string{
		"GITHUB_CLIENT_ID": "", "GITHUB_CLIENT_SECRET": "",
	}})
	authorize := server.api("GET", "/auth/github/authorize", apiOptions{
		query:        map[string]string{"client": "web", "redirect_uri": server.base + "/app", "state": randomBase64URL(32)},
		omitProtocol: true,
	})
	if authorize.status != http.StatusServiceUnavailable || errorCode(authorize.body) != string(CodeNotConfigured) {
		t.Fatalf("authorize without an OAuth app: %d %s", authorize.status, authorize.text)
	}
	token := server.api("POST", "/auth/token", apiOptions{body: map[string]any{
		"code": "x", "redirect_uri": iosRedirectURI,
	}})
	if token.status != http.StatusServiceUnavailable || errorCode(token.body) != string(CodeNotConfigured) {
		t.Fatalf("token without an OAuth app: %d %s", token.status, token.text)
	}
}

func TestAuthorizeRejectsUnboundRedirectAndMissingPkce(t *testing.T) {
	server := startTestHub(t)
	foreign := server.api("GET", "/auth/github/authorize", apiOptions{
		query:        map[string]string{"client": "web", "redirect_uri": "https://elsewhere.example/app", "state": randomBase64URL(32)},
		omitProtocol: true,
	})
	if foreign.status != http.StatusBadRequest || errorCode(foreign.body) != string(CodeValidationFailed) {
		t.Fatalf("foreign redirect_uri: %d %s", foreign.status, foreign.text)
	}
	iosWithoutPkce := server.api("GET", "/auth/github/authorize", apiOptions{
		query:        map[string]string{"client": "ios", "redirect_uri": iosRedirectURI, "state": randomBase64URL(32)},
		omitProtocol: true,
	})
	if iosWithoutPkce.status != http.StatusBadRequest || errorCode(iosWithoutPkce.body) != string(CodeValidationFailed) {
		t.Fatalf("ios without PKCE: %d %s", iosWithoutPkce.status, iosWithoutPkce.text)
	}
}

func TestGithubTokenExchangeFailures(t *testing.T) {
	server := startTestHub(t)
	server.seedTeam()

	server.githubAuthorizeAndCallback("octocat", "the-verifier-the-client-kept-0123456789")
	wrongVerifier := server.api("POST", "/auth/token", apiOptions{body: map[string]any{
		"code": "octocat", "code_verifier": "a-different-verifier-0123456789",
		"redirect_uri": iosRedirectURI,
	}})
	if wrongVerifier.status != http.StatusBadRequest || errorCode(wrongVerifier.body) != string(CodeInvalidPKCE) {
		t.Fatalf("wrong code_verifier: %d %s", wrongVerifier.status, wrongVerifier.text)
	}

	unknownCode := server.api("POST", "/auth/token", apiOptions{body: map[string]any{
		"code": "no-such-code", "redirect_uri": iosRedirectURI,
	}})
	if unknownCode.status != http.StatusBadRequest || errorCode(unknownCode.body) != string(CodeInvalidOAuthCode) {
		t.Fatalf("unknown authorization code: %d %s", unknownCode.status, unknownCode.text)
	}
}

func TestGithubLoginRefusesANonMember(t *testing.T) {
	server := startTestHub(t)
	server.seedTeam()
	// hubot exists on GitHub but was never invited to this hub.
	result := server.finishGithubFlow("hubot", "verifier-for-hubot-0123456789abcdef")
	if result.status != http.StatusForbidden || errorCode(result.body) != string(CodeForbidden) {
		t.Fatalf("non-member login: %d %s", result.status, result.text)
	}
}
