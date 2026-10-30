package hub

// The suite talks to the service the way a client does: a real SQLite file on
// disk, a real HTTP listener on an ephemeral loopback port and real WebSocket
// handshakes. The one seam is outbound HTTP (GitHub, the account service, APNs),
// which is the same injection point the Worker suite uses.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

const (
	bootstrapToken = "bootstrap-token-for-tests"
	accountJWKSUrl = "https://account.example/jwks.json"
	accountIssuer  = "https://account.example"
	accountAudienc = "dsh-team-hub"
	accountSubject = "acct_hubot"

	// accountServiceBase is ACCOUNT_SERVICE_BASE: the host the fake outbound serves
	// both the JWKS and the admin email lookup on.
	accountServiceBase = "https://account.example"
	accountAdminToken  = "{{SECRET_admininvite}}"

	// bootstrapAdminEmail is the address the first admin bootstraps with. The
	// fake account service resolves it to accountSubject, so every seeded hub has
	// the same enterable admin, named after the address's local part.
	bootstrapAdminEmail = "first.admin@example.test"
	bootstrapAdminName  = "first.admin"
)

type githubAccount struct {
	ID        int64  `json:"id"`
	Login     string `json:"login"`
	Name      string `json:"name"`
	AvatarURL string `json:"avatar_url"`
}

var octocat = githubAccount{ID: 1001, Login: "octocat", Name: "Octo Cat"}
var hubot = githubAccount{ID: 1002, Login: "hubot", Name: "Hub Ot"}

type recordedCall struct {
	Method string
	URL    string
	Header http.Header
	Body   string
}

// fakeOutbound serves the GitHub, account service and APNs contracts and records
// every request, so a test can assert what the hub actually built.
type fakeOutbound struct {
	mu                sync.Mutex
	calls             []recordedCall
	accounts          map[string]githubAccount
	users             map[string]string
	jwks              any
	status            int
	pushStatus        int
	lookupStatus      int
	lookupUnreachable bool
}

func newFakeOutbound() *fakeOutbound {
	fake := &fakeOutbound{accounts: map[string]githubAccount{}, users: map[string]string{}}
	for _, account := range []githubAccount{octocat, hubot} {
		fake.accounts[account.Login] = account
	}
	return fake
}

// addAccountUser teaches the fake account service one email, so an invite can
// resolve it to the user id its assertions carry as sub.
func (f *fakeOutbound) addAccountUser(email, userID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users[email] = userID
}

// setLookupStatus makes the account-service lookup answer one injected status
// instead of resolving anything, which is how the hub's 502 path is exercised.
func (f *fakeOutbound) setLookupStatus(status int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookupStatus = status
}

// setLookupUnreachable makes the lookup fail at the transport, the other shape of
// "the account service is not there".
func (f *fakeOutbound) setLookupUnreachable() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookupUnreachable = true
}

func (f *fakeOutbound) Do(request *http.Request) (*http.Response, error) {
	body := ""
	if request.Body != nil {
		raw, _ := io.ReadAll(request.Body)
		body = string(raw)
	}
	f.mu.Lock()
	f.calls = append(f.calls, recordedCall{
		Method: request.Method, URL: request.URL.String(), Header: request.Header.Clone(), Body: body,
	})
	jwks := f.jwks
	status := f.status
	pushStatus := f.pushStatus
	lookupStatus := f.lookupStatus
	unreachable := f.lookupUnreachable
	users := map[string]string{}
	for email, userID := range f.users {
		users[email] = userID
	}
	f.mu.Unlock()

	parsed, err := url.Parse(request.URL.String())
	if err != nil {
		return nil, err
	}
	write := func(code int, payload any) (*http.Response, error) {
		encoded, _ := json.Marshal(payload)
		return &http.Response{
			StatusCode: code,
			Header:     http.Header{"content-type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(string(encoded))),
		}, nil
	}
	if status != 0 {
		return write(status, map[string]any{"error": "injected"})
	}
	switch {
	case parsed.Host == "github.com" && parsed.Path == "/login/oauth/access_token":
		form, _ := url.ParseQuery(body)
		code := form.Get("code")
		account, ok := f.accounts[code]
		if !ok {
			return write(200, map[string]any{"error": "bad_verification_code"})
		}
		return write(200, map[string]any{"access_token": "gho_" + account.Login, "token_type": "bearer"})
	case parsed.Host == "api.github.com" && parsed.Path == "/user":
		token := strings.TrimPrefix(request.Header.Get("authorization"), "Bearer ")
		login := strings.TrimPrefix(token, "gho_")
		account, ok := f.accounts[login]
		if !ok {
			return write(401, map[string]any{"message": "Bad credentials"})
		}
		return write(200, account)
	case parsed.Host == "api.github.com" && strings.HasPrefix(parsed.Path, "/users/"):
		login := strings.TrimPrefix(parsed.Path, "/users/")
		account, ok := f.accounts[login]
		if !ok {
			return write(404, map[string]any{"message": "Not Found"})
		}
		return write(200, account)
	case parsed.Host == "account.example" && parsed.Path == "/jwks.json":
		if jwks == nil {
			return write(503, map[string]any{"error": "not_configured"})
		}
		return write(200, jwks)
	case parsed.Host == "account.example" && parsed.Path == accountLookupPath:
		if unreachable {
			return nil, errors.New("dial tcp 203.0.113.7:443: connect: connection refused")
		}
		if request.Header.Get("x-admin-token") != accountAdminToken {
			return write(401, map[string]any{"error": "unauthorized"})
		}
		if lookupStatus != 0 {
			return write(lookupStatus, map[string]any{"error": "injected"})
		}
		var lookup struct {
			Email string `json:"email"`
		}
		if err := json.Unmarshal([]byte(body), &lookup); err != nil {
			return write(400, map[string]any{"error": "bad_request"})
		}
		userID, ok := users[lookup.Email]
		if !ok {
			return write(404, map[string]any{"error": "user_not_found"})
		}
		return write(200, map[string]any{"user_id": userID, "email": lookup.Email})
	case parsed.Host == "api.push.apple.com" || parsed.Host == "api.sandbox.push.apple.com":
		if pushStatus != 0 {
			return write(pushStatus, map[string]any{"reason": "injected"})
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
	}
	return write(404, map[string]any{"message": "unexpected outbound host " + parsed.Host})
}

func (f *fakeOutbound) recorded() []recordedCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]recordedCall, len(f.calls))
	copy(out, f.calls)
	return out
}

type testHub struct {
	t      *testing.T
	hub    *Hub
	base   string
	fake   *fakeOutbound
	dir    string
	client *http.Client

	logMu sync.Mutex
	logs  []string
}

// recordLog keeps every line the hub logs, so a test can read an audit entry the
// hub deliberately does not expose on the wire.
func (h *testHub) recordLog(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	h.logMu.Lock()
	defer h.logMu.Unlock()
	h.logs = append(h.logs, line)
}

func (h *testHub) loggedLines() []string {
	h.logMu.Lock()
	defer h.logMu.Unlock()
	return append([]string{}, h.logs...)
}

type startOptions struct {
	env  map[string]string
	jwks any
}

func migrationsDir(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot resolve the test file path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", "migrations"))
}

func startTestHub(t *testing.T, options ...startOptions) *testHub {
	t.Helper()
	directory := t.TempDir()
	fake := newFakeOutbound()
	environment := map[string]string{
		"DATABASE_PATH":        filepath.Join(directory, "hub.sqlite"),
		"HOST":                 "127.0.0.1",
		"PORT":                 "0",
		"SWEEP_INTERVAL_MS":    "0",
		SessionSecretEnv:       "test-session-signing-key",
		"BOOTSTRAP_TOKEN":      bootstrapToken,
		"GITHUB_CLIENT_ID":     "test-github-client-id",
		"GITHUB_CLIENT_SECRET": "test-github-client-secret",
		"ACCOUNT_JWKS_URL":     accountJWKSUrl,
		"ACCOUNT_ISSUER":       accountIssuer,
		"ACCOUNT_AUDIENCE":     accountAudienc,
		"ACCOUNT_SERVICE_BASE": accountServiceBase,
		"ACCOUNT_ADMIN_TOKEN":  accountAdminToken,
		"MIGRATIONS_DIR":       migrationsDir(t),
	}
	for _, option := range options {
		for name, value := range option.env {
			if value == "" {
				delete(environment, name)
				continue
			}
			environment[name] = value
		}
		if option.jwks != nil {
			fake.jwks = option.jwks
		}
	}
	report := LoadConfig(environment, migrationsDir(t))
	if len(report.Errors) > 0 {
		t.Fatalf("test configuration is invalid: %v", report.Errors)
	}
	server := &testHub{
		t: t, hub: nil, base: "", fake: fake, dir: directory,
		client: &http.Client{
			Timeout: 10 * time.Second,
			// The OAuth routes answer 302 on purpose; a test reads the location, it
			// never follows it out of the process.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
	}
	app, err := New(report.Config, Options{Outbound: fake, Logf: func(format string, args ...any) {
		t.Logf("[hub] "+format, args...)
		server.recordLog(format, args...)
	}})
	if err != nil {
		t.Fatalf("new hub: %v", err)
	}
	base, err := app.Start()
	if err != nil {
		t.Fatalf("start hub: %v", err)
	}
	server.hub = app
	server.base = base
	t.Cleanup(func() {
		if err := app.Close(); err != nil {
			t.Errorf("close hub: %v", err)
		}
	})
	return server
}

type apiOptions struct {
	token        string
	body         any
	rawBody      string
	headers      map[string]string
	query        map[string]string
	omitProtocol bool
}

type apiResult struct {
	status  int
	body    map[string]any
	headers http.Header
	text    string
}

func (h *testHub) api(method, path string, options apiOptions) apiResult {
	h.t.Helper()
	target := h.base + path
	if len(options.query) > 0 {
		values := url.Values{}
		for name, value := range options.query {
			values.Set(name, value)
		}
		target += "?" + values.Encode()
	}
	var reader io.Reader
	if options.rawBody != "" {
		reader = strings.NewReader(options.rawBody)
	} else if options.body != nil {
		encoded, err := json.Marshal(options.body)
		if err != nil {
			h.t.Fatalf("encode body: %v", err)
		}
		reader = strings.NewReader(string(encoded))
	}
	request, err := http.NewRequest(method, target, reader)
	if err != nil {
		h.t.Fatalf("build request: %v", err)
	}
	if !options.omitProtocol {
		request.Header.Set(ProtocolHeader, ProtocolVersion)
	}
	if options.token != "" {
		request.Header.Set("authorization", "Bearer "+options.token)
	}
	if options.body != nil || options.rawBody != "" {
		request.Header.Set("content-type", "application/json")
	}
	for name, value := range options.headers {
		request.Header.Set(name, value)
	}
	response, err := h.client.Do(request)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	result := apiResult{status: response.StatusCode, headers: response.Header, text: string(raw)}
	if len(raw) > 0 {
		var parsed any
		if err := json.Unmarshal(raw, &parsed); err == nil {
			if record, ok := parsed.(map[string]any); ok {
				result.body = record
			}
		}
	}
	return result
}

func errorCode(body map[string]any) string {
	if body == nil {
		return ""
	}
	record, ok := body["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := record["code"].(string)
	return code
}

func errorDetails(body map[string]any) map[string]any {
	record, ok := body["error"].(map[string]any)
	if !ok {
		return nil
	}
	details, _ := record["details"].(map[string]any)
	return details
}

func errorMessage(body map[string]any) string {
	record, ok := body["error"].(map[string]any)
	if !ok {
		return ""
	}
	message, _ := record["message"].(string)
	return message
}

type session struct {
	accessToken  string
	refreshToken string
	member       map[string]any
}

// finishGithubFlow runs the iOS PKCE flow's authorize, callback and token legs
// and returns the token exchange however it answered.
func (h *testHub) githubAuthorizeAndCallback(username, verifier string) {
	h.t.Helper()
	state := randomBase64URL(32)
	challenge := sha256.Sum256([]byte(verifier))
	authorize := h.api("GET", "/auth/github/authorize", apiOptions{
		query: map[string]string{
			"client": "ios", "redirect_uri": iosRedirectURI, "state": state,
			"code_challenge":        base64.RawURLEncoding.EncodeToString(challenge[:]),
			"code_challenge_method": "S256",
		},
		omitProtocol: true,
	})
	if authorize.status != http.StatusFound {
		h.t.Fatalf("authorize failed: %d %s", authorize.status, authorize.text)
	}
	callback := h.api("GET", "/auth/github/callback", apiOptions{
		query:        map[string]string{"code": username, "state": state},
		omitProtocol: true,
	})
	if callback.status != http.StatusFound {
		h.t.Fatalf("callback failed: %d %s", callback.status, callback.text)
	}
}

func (h *testHub) finishGithubFlow(username, verifier string) apiResult {
	h.t.Helper()
	h.githubAuthorizeAndCallback(username, verifier)
	return h.api("POST", "/auth/token", apiOptions{body: map[string]any{
		"code": username, "code_verifier": verifier, "redirect_uri": iosRedirectURI,
	}})
}

func (h *testHub) login(username string) session {
	h.t.Helper()
	verifier := "verifier-for-" + username + "-0123456789abcdef"
	token := h.finishGithubFlow(username, verifier)
	if token.status != http.StatusOK {
		h.t.Fatalf("token exchange failed: %d %s", token.status, token.text)
	}
	access, _ := token.body["access_token"].(string)
	refresh, _ := token.body["refresh_token"].(string)
	member, _ := token.body["member"].(map[string]any)
	return session{accessToken: access, refreshToken: refresh, member: member}
}

type seededTeam struct {
	teamID string
	admin  session
}

func (h *testHub) seedTeam() seededTeam {
	h.t.Helper()
	h.fake.addAccountUser(bootstrapAdminEmail, accountSubject)
	created := h.api("POST", "/api/v1/bootstrap", apiOptions{
		headers: map[string]string{"X-Bootstrap-Token": bootstrapToken},
		body:    map[string]any{"team_name": "Team Test", "team_slug": "team-test", "email": bootstrapAdminEmail},
	})
	if created.status != http.StatusCreated {
		h.t.Fatalf("bootstrap failed: %d %s", created.status, created.text)
	}
	team, _ := created.body["team"].(map[string]any)
	teamID, _ := team["id"].(string)
	// The bootstrap response names the admin row it wrote; the session is minted
	// directly because most hubs in this suite hold no assertion signing key.
	return seededTeam{teamID: teamID, admin: h.sessionFor(created.body["member"])}
}

// setAccountAdminAPI rewrites the account-service admin settings of a running
// hub. A hub cannot bootstrap its first admin without them, so this is the only
// way to reach the state an operator reaches by removing the token after the
// team exists: the team is there and the admin API is closed. The suite disables
// the sweeper, so no other goroutine is reading the configuration here.
func (h *testHub) setAccountAdminAPI(base, token string) {
	h.t.Helper()
	h.hub.config.AccountServiceBase = base
	h.hub.config.AccountAdminToken = token
}

// sessionFor mints a session for a member the hub already created. The invite
// route binds an account but the fixtures here hold no signing key, so the token
// is issued directly: what these callers need is a working member session, and
// the account-service sign-in is what the account tests cover.
func (h *testHub) sessionFor(view any) session {
	h.t.Helper()
	record, _ := view.(map[string]any)
	member, err := queryMember(h.hub.DB(), "SELECT "+memberColumns+" FROM members WHERE id = ?",
		stringField(record, "id"))
	if err != nil || member == nil {
		h.t.Fatalf("read the member the hub created: %v", err)
	}
	tokens, _, err := h.hub.issueSession(member, h.hub.now())
	if err != nil {
		h.t.Fatalf("issue a session for the member: %v", err)
	}
	return session{accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken, member: record}
}

// inviteAndLogin invites a second member by email and hands back a session for
// them. The address resolves through the fake account service, exactly as the
// real invite resolves it.
func (h *testHub) inviteAndLogin(teamID, adminToken, handle string) session {
	h.t.Helper()
	email := handle + "@example.test"
	h.fake.addAccountUser(email, "acct_invitee_"+handle)
	invited := h.api("POST", "/api/v1/teams/"+teamID+"/members/invite", apiOptions{
		token: adminToken, body: map[string]any{"email": email, "role": "member"},
	})
	if invited.status != http.StatusCreated {
		h.t.Fatalf("invite failed: %d %s", invited.status, invited.text)
	}
	return h.sessionFor(invited.body["member"])
}

// unboundMemberAndLogin seeds a member that entered through GitHub and has not
// bound an account yet, then signs it in through the GitHub flow. The invite and
// bootstrap routes always bind an account, so the binding rules need the other
// real shape: a row carried by a GitHub identity alone, which is a row whose
// mention handle is its login, exactly as 0005 backfills one.
func (h *testHub) unboundMemberAndLogin(teamID, handle string) session {
	h.t.Helper()
	account, ok := h.fake.accounts[handle]
	if !ok {
		h.t.Fatalf("unknown fixture account %q", handle)
	}
	now := h.hub.now()
	member := &Member{
		ID: NewID("mem", now), TeamID: teamID, GithubUserID: account.ID, GithubUsername: account.Login,
		MentionHandle: strings.ToLower(account.Login),
		DisplayName:   account.Name, Role: "member", Status: "active", CreatedAt: now, UpdatedAt: now,
	}
	if _, err := h.hub.DB().Exec(
		`INSERT INTO members (id, team_id, github_user_id, github_username, mention_handle, display_name,
		 avatar_url, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		member.ID, member.TeamID, member.GithubUserID, member.GithubUsername, member.MentionHandle,
		member.DisplayName, member.AvatarURL, member.Role, member.Status, member.CreatedAt,
		member.UpdatedAt); err != nil {
		h.t.Fatalf("seed an unbound member: %v", err)
	}
	return h.login(handle)
}

type seededHost struct {
	hostID    string
	hostToken string
	agents    []map[string]any
}

func (h *testHub) seedHost(teamID, adminToken, hostname string, agents []map[string]any) seededHost {
	h.t.Helper()
	minted := h.api("POST", "/api/v1/teams/"+teamID+"/hosts/tokens", apiOptions{
		token: adminToken, body: map[string]any{"hostname": hostname},
	})
	if minted.status != http.StatusCreated {
		h.t.Fatalf("host token mint failed: %d %s", minted.status, minted.text)
	}
	hostID, _ := minted.body["host_id"].(string)
	hostToken, _ := minted.body["host_token"].(string)
	registered := h.api("POST", "/api/v1/teams/"+teamID+"/hosts/register", apiOptions{
		token: hostToken, body: map[string]any{
			"hostname": hostname, "client_version": "1.0.0", "agents": agents,
		},
	})
	if registered.status != http.StatusOK {
		h.t.Fatalf("host registration failed: %d %s", registered.status, registered.text)
	}
	reported, _ := registered.body["agents"].([]any)
	entries := make([]map[string]any, 0, len(reported))
	for _, entry := range reported {
		if record, ok := entry.(map[string]any); ok {
			entries = append(entries, record)
		}
	}
	return seededHost{hostID: hostID, hostToken: hostToken, agents: entries}
}

func (h *testHub) createIssue(teamID, token string, body map[string]any) map[string]any {
	h.t.Helper()
	created := h.api("POST", "/api/v1/teams/"+teamID+"/issues", apiOptions{token: token, body: body})
	if created.status != http.StatusCreated {
		h.t.Fatalf("issue creation failed: %d %s", created.status, created.text)
	}
	issue, _ := created.body["issue"].(map[string]any)
	return issue
}

func stringField(record map[string]any, name string) string {
	value, _ := record[name].(string)
	return value
}

func numberField(record map[string]any, name string) int64 {
	value, _ := record[name].(float64)
	return int64(value)
}

func randomBase64URL(size int) string {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(buffer)
}

// ---- account service fixtures ----

type accountKey struct {
	kid        string
	privateKey *ecdsa.PrivateKey
	public     *ecdsa.PublicKey
}

func newAccountKey(t *testing.T) *accountKey {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return &accountKey{kid: "account-test-kid", privateKey: privateKey, public: &privateKey.PublicKey}
}

func accountJWKS(key *accountKey) map[string]any {
	encode := func(value *big.Int) string {
		return base64.RawURLEncoding.EncodeToString(value.FillBytes(make([]byte, 32)))
	}
	return map[string]any{"keys": []any{map[string]any{
		"kty": "EC", "crv": "P-256", "kid": key.kid, "alg": "ES256",
		"x": encode(key.public.X), "y": encode(key.public.Y),
	}}}
}

type assertionOptions struct {
	sub string
	kid string
	iss string
	aud any
	now int64
	ttl int64
}

func (key *accountKey) assertion(t *testing.T, options assertionOptions) string {
	t.Helper()
	if options.sub == "" {
		options.sub = accountSubject
	}
	if options.kid == "" {
		options.kid = key.kid
	}
	if options.iss == "" {
		options.iss = accountIssuer
	}
	if options.aud == nil {
		options.aud = accountAudienc
	}
	if options.now == 0 {
		options.now = time.Now().UnixMilli()
	}
	if options.ttl == 0 {
		options.ttl = 300
	}
	encode := func(value any) string {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encode segment: %v", err)
		}
		return base64.RawURLEncoding.EncodeToString(encoded)
	}
	issuedAt := options.now / 1000
	header := map[string]any{"alg": "ES256", "typ": "JWT", "kid": options.kid}
	claims := map[string]any{
		"iss": options.iss, "aud": options.aud, "sub": options.sub,
		"name": "Account Holder", "iat": issuedAt, "exp": issuedAt + options.ttl,
		"jti": randomBase64URL(8),
	}
	signingInput := encode(header) + "." + encode(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, key.privateKey, digest[:])
	if err != nil {
		t.Fatalf("sign assertion: %v", err)
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func (h *testHub) bindAccount(token string, key *accountKey) {
	h.t.Helper()
	linked := h.api("POST", "/auth/account/link", apiOptions{
		token: token, body: map[string]any{"assertion": key.assertion(h.t, assertionOptions{})},
	})
	if linked.status != http.StatusOK {
		h.t.Fatalf("account link failed: %d %s", linked.status, linked.text)
	}
}

// ---- WebSocket client ----

type frame struct {
	t         string
	seq       int64
	event     string
	reason    string
	latestSeq int64
	payload   map[string]any
	ts        int64
}

type socketClient struct {
	t      *testing.T
	conn   *websocket.Conn
	frames []frame
}

func (c *socketClient) read() frame {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, data, err := c.conn.ReadMessage()
	if err != nil {
		c.t.Fatalf("read frame: %v", err)
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		c.t.Fatalf("decode frame %q: %v", string(data), err)
	}
	result := frame{t: stringField(parsed, "t")}
	result.seq = numberField(parsed, "seq")
	result.event = stringField(parsed, "event")
	result.reason = stringField(parsed, "reason")
	result.latestSeq = numberField(parsed, "latest_seq")
	result.ts = numberField(parsed, "ts")
	result.payload, _ = parsed["payload"].(map[string]any)
	return result
}

func (c *socketClient) send(text string) {
	c.t.Helper()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := c.conn.WriteMessage(websocket.TextMessage, []byte(text)); err != nil {
		c.t.Fatalf("write frame: %v", err)
	}
}

func (c *socketClient) close() { _ = c.conn.Close() }

func (h *testHub) dial(teamID string, token string, query map[string]string, omitProtocol bool) (*websocket.Conn, *http.Response, error) {
	values := url.Values{}
	for name, value := range query {
		values.Set(name, value)
	}
	target := "ws" + strings.TrimPrefix(h.base, "http") + "/api/v1/teams/" + teamID + "/ws"
	if len(values) > 0 {
		target += "?" + values.Encode()
	}
	headers := http.Header{}
	if !omitProtocol {
		headers.Set(ProtocolHeader, ProtocolVersion)
	}
	if token != "" {
		headers.Set("authorization", "Bearer "+token)
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second}
	conn, response, err := dialer.Dial(target, headers)
	return conn, response, err
}

func (h *testHub) connect(teamID, token string, query map[string]string) *socketClient {
	h.t.Helper()
	if query == nil {
		query = map[string]string{"protocol_version": ProtocolVersion}
	}
	conn, _, err := h.dial(teamID, token, query, false)
	if err != nil {
		h.t.Fatalf("websocket handshake failed: %v", err)
	}
	client := &socketClient{t: h.t, conn: conn}
	h.t.Cleanup(client.close)
	return client
}

func (h *testHub) connectCaughtUp(teamID, token string) *socketClient {
	h.t.Helper()
	latest, _ := h.hub.Channel().State(teamID)
	client := h.connect(teamID, token, map[string]string{
		"protocol_version": ProtocolVersion, "since_seq": fmt.Sprintf("%d", latest),
	})
	if latest == 0 {
		if got := client.read(); got.t != "resync_required" {
			h.t.Fatalf("expected a resync directive, got %+v", got)
		}
	}
	return client
}

// generateP8 mints a throwaway PKCS8 P-256 key for the APNs tests.
func generateP8(t *testing.T) string {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate APNs key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		t.Fatalf("marshal APNs key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// one reads a single column of a single row, which is how a test checks the row
// the state machine left behind.
func one[T any](h *testHub, query string, args ...any) (T, bool) {
	h.t.Helper()
	var value T
	err := h.hub.DB().QueryRow(query, args...).Scan(&value)
	if err != nil {
		if err == errNoRows {
			return value, false
		}
		h.t.Fatalf("query %q: %v", query, err)
	}
	return value, true
}
