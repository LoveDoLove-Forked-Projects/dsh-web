package hub

// GitHub OAuth: the transition login the iOS app finishes with PKCE and the Web
// GUI finishes in the browser.

import (
	"crypto/sha256"
	"errors"
	"net/http"
	"net/url"
	"strconv"
)

// oauthStateTTLMS is section 11's OAuth state lifetime; a browser round trip is
// far shorter.
const oauthStateTTLMS = 600_000

type githubUser struct {
	ID        int64
	Login     string
	Name      *string
	AvatarURL *string
}

type authorizeRequest struct {
	Client              string
	RedirectURI         string
	State               string
	CodeChallenge       *string
	CodeChallengeMethod *string
}

// base64URLByteLength is the decoded size of a base64url string, or -1 when it
// is not base64url at all.
func base64URLByteLength(value string) int {
	for _, character := range value {
		switch {
		case character >= 'A' && character <= 'Z',
			character >= 'a' && character <= 'z',
			character >= '0' && character <= '9',
			character == '-', character == '_':
		default:
			return -1
		}
	}
	decoded, err := fromBase64URL(value)
	if err != nil {
		return -1
	}
	return len(decoded)
}

func requireBase64URL(value string, minimumBytes int, field string) error {
	if base64URLByteLength(value) < minimumBytes {
		return FailWith(CodeValidationFailed,
			field+" must be base64url encoding at least "+strconv.Itoa(minimumBytes)+" bytes.",
			map[string]any{"field": field})
	}
	return nil
}

// parseAuthorizeRequest validates the authorize query before anything is stored
// (supplement A1.6): the client owns the state, the redirect target and, on iOS,
// the PKCE challenge.
func parseAuthorizeRequest(origin string, query url.Values) (*authorizeRequest, error) {
	client := query.Get("client")
	if client != "web" && client != "ios" {
		return nil, FailWith(CodeValidationFailed, "client is required and must be 'web' or 'ios'.",
			map[string]any{"field": "client"})
	}
	state := query.Get("state")
	if state == "" {
		return nil, FailWith(CodeValidationFailed, "state is required.", map[string]any{"field": "state"})
	}
	if err := requireBase64URL(state, 32, "state"); err != nil {
		return nil, err
	}
	redirectURI := query.Get("redirect_uri")
	if redirectURI == "" {
		return nil, FailWith(CodeValidationFailed, "redirect_uri is required.",
			map[string]any{"field": "redirect_uri"})
	}
	if client == "ios" {
		if redirectURI != iosRedirectURI {
			return nil, FailWith(CodeValidationFailed,
				"redirect_uri for the ios client must be exactly "+iosRedirectURI+".",
				map[string]any{"field": "redirect_uri"})
		}
	} else {
		parsed, err := url.Parse(redirectURI)
		if err != nil || parsed.Scheme == "" || parsed.Host == "" {
			return nil, FailWith(CodeValidationFailed, "redirect_uri must be an absolute URL.",
				map[string]any{"field": "redirect_uri"})
		}
		if parsed.Scheme+"://"+parsed.Host != origin {
			return nil, FailWith(CodeValidationFailed,
				"redirect_uri for the web client must share this hub origin.",
				map[string]any{"field": "redirect_uri"})
		}
	}
	codeChallenge := query.Get("code_challenge")
	codeChallengeMethod := query.Get("code_challenge_method")
	if client == "ios" {
		if codeChallenge == "" {
			return nil, FailWith(CodeValidationFailed, "code_challenge is required for the ios client.",
				map[string]any{"field": "code_challenge"})
		}
		if codeChallengeMethod != "S256" {
			return nil, FailWith(CodeValidationFailed, "code_challenge_method must be 'S256'.",
				map[string]any{"field": "code_challenge_method"})
		}
		if err := requireBase64URL(codeChallenge, 32, "code_challenge"); err != nil {
			return nil, err
		}
	} else if codeChallenge != "" {
		if codeChallengeMethod != "S256" {
			return nil, FailWith(CodeValidationFailed,
				"code_challenge_method must be 'S256' when a challenge is supplied.",
				map[string]any{"field": "code_challenge_method"})
		}
		if err := requireBase64URL(codeChallenge, 32, "code_challenge"); err != nil {
			return nil, err
		}
	}
	request := &authorizeRequest{Client: client, RedirectURI: redirectURI, State: state}
	if codeChallenge != "" {
		challenge := codeChallenge
		method := "S256"
		request.CodeChallenge = &challenge
		request.CodeChallengeMethod = &method
	}
	return request, nil
}

func writeRedirect(w http.ResponseWriter, location string, cookies []string) {
	for _, cookie := range cookies {
		w.Header().Add("set-cookie", cookie)
	}
	w.Header().Set("location", location)
	w.WriteHeader(http.StatusFound)
}

func (h *Hub) githubSettings() (*GitHubSettings, error) {
	if h.config.GitHub == nil {
		return nil, Fail(CodeNotConfigured,
			"GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured on this hub.")
	}
	return h.config.GitHub, nil
}

// beginAuthorize remembers the pending authorization and redirects to GitHub.
func (h *Hub) beginAuthorize(r *http.Request, now int64) (*url.URL, []string, error) {
	settings, err := h.githubSettings()
	if err != nil {
		return nil, nil, err
	}
	origin := requestOrigin(r)
	request, err := parseAuthorizeRequest(origin, r.URL.Query())
	if err != nil {
		return nil, nil, err
	}
	_, err = h.db.Exec(
		`INSERT INTO oauth_states (state, client, redirect_uri, code_challenge, code_challenge_method,
		 created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		request.State, request.Client, request.RedirectURI, request.CodeChallenge,
		request.CodeChallengeMethod, now, now+oauthStateTTLMS)
	if err != nil {
		return nil, nil, FailWith(CodeConflict,
			"This state value already has a pending authorization.", map[string]any{"field": "state"})
	}
	target, err := url.Parse(githubOAuthBase + "/login/oauth/authorize")
	if err != nil {
		return nil, nil, err
	}
	query := target.Query()
	query.Set("client_id", settings.ClientID)
	query.Set("redirect_uri", origin+githubCallbackPath)
	query.Set("scope", "read:user")
	query.Set("state", request.State)
	if request.CodeChallenge != nil {
		query.Set("code_challenge", *request.CodeChallenge)
		query.Set("code_challenge_method", "S256")
	}
	target.RawQuery = query.Encode()
	cookies := make([]string, 0)
	if request.Client == "web" {
		cookies = append(cookies, sessionCookie(oauthStateCookieName, request.State, oauthStateTTLMS/1000))
	}
	return target, cookies, nil
}

func (h *Hub) exchangeCodeForGithubToken(code string, codeVerifier *string, redirectURI string) (string, error) {
	settings, err := h.githubSettings()
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("client_id", settings.ClientID)
	form.Set("client_secret", settings.ClientSecret)
	form.Set("code", code)
	form.Set("redirect_uri", redirectURI)
	if codeVerifier != nil {
		form.Set("code_verifier", *codeVerifier)
	}
	response, err := h.callOutbound("POST", githubOAuthBase+"/login/oauth/access_token", map[string]string{
		"accept":       "application/json",
		"content-type": "application/x-www-form-urlencoded",
	}, form.Encode())
	if err != nil {
		return "", Fail(CodeInvalidOAuthCode, "GitHub could not be reached for the code exchange.")
	}
	body, _ := response.Body.(map[string]any)
	accessToken, _ := body["access_token"].(string)
	if accessToken == "" {
		reason, _ := body["error"].(string)
		if reason == "" {
			reason = "unknown_error"
		}
		if codeVerifier != nil {
			return "", FailWith(CodeInvalidPKCE,
				"GitHub rejected the code exchange ("+reason+").", map[string]any{"github_error": reason})
		}
		return "", FailWith(CodeInvalidOAuthCode,
			"GitHub rejected the authorization code ("+reason+").", map[string]any{"github_error": reason})
	}
	return accessToken, nil
}

func (h *Hub) fetchGithubUser(accessToken string) (*githubUser, error) {
	response, err := h.callOutbound("GET", githubAPIBase+"/user", map[string]string{
		"authorization": "Bearer " + accessToken,
		"accept":        "application/vnd.github+json",
		"user-agent":    "dsh-team-hub",
	}, "")
	if err != nil {
		return nil, Fail(CodeInvalidOAuthCode, "GitHub did not return a usable user profile.")
	}
	body, ok := response.Body.(map[string]any)
	if !ok {
		return nil, Fail(CodeInvalidOAuthCode, "GitHub did not return a usable user profile.")
	}
	id, idOK := body["id"].(float64)
	login, loginOK := body["login"].(string)
	if !idOK || !loginOK {
		return nil, Fail(CodeInvalidOAuthCode, "GitHub did not return a usable user profile.")
	}
	user := &githubUser{ID: int64(id), Login: login}
	if name, ok := body["name"].(string); ok {
		user.Name = &name
	}
	if avatar, ok := body["avatar_url"].(string); ok {
		user.AvatarURL = &avatar
	}
	return user, nil
}

// resolveMemberForGithubUser activates an invited membership on first login and
// binds the numeric GitHub user id.
func (h *Hub) resolveMemberForGithubUser(user *githubUser, now int64) (*Member, error) {
	existing, err := queryMember(h.db,
		"SELECT "+memberColumns+" FROM members WHERE github_user_id = ? ORDER BY created_at LIMIT 1", user.ID)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.Status == "suspended" {
			return nil, Fail(CodeForbidden, "This membership is suspended.")
		}
		if existing.Status == "invited" {
			displayName := existing.DisplayName
			if user.Name != nil {
				displayName = *user.Name
			}
			avatar := existing.AvatarURL
			if user.AvatarURL != nil {
				avatar = user.AvatarURL
			}
			if _, err := h.db.Exec("UPDATE members SET status = 'active', display_name = ?, "+
				"avatar_url = ?, updated_at = ? WHERE id = ?", displayName, avatar, now, existing.ID); err != nil {
				return nil, err
			}
			return &Member{ID: existing.ID, TeamID: existing.TeamID, GithubUserID: existing.GithubUserID,
				GithubUsername: existing.GithubUsername, DisplayName: displayName, AvatarURL: avatar,
				AccountUserID: existing.AccountUserID, Role: existing.Role, Status: "active",
				CreatedAt: existing.CreatedAt, UpdatedAt: now}, nil
		}
		return existing, nil
	}
	byUsername, err := queryMember(h.db,
		"SELECT "+memberColumns+" FROM members WHERE github_username = ? COLLATE NOCASE ORDER BY created_at LIMIT 1",
		user.Login)
	if err != nil {
		return nil, err
	}
	if byUsername == nil {
		return nil, Fail(CodeForbidden, "This GitHub account is not a member of any team on this hub.")
	}
	if byUsername.Status == "suspended" {
		return nil, Fail(CodeForbidden, "This membership is suspended.")
	}
	displayName := byUsername.DisplayName
	if user.Name != nil {
		displayName = *user.Name
	}
	avatar := byUsername.AvatarURL
	if user.AvatarURL != nil {
		avatar = user.AvatarURL
	}
	if _, err := h.db.Exec("UPDATE members SET status = 'active', github_user_id = ?, display_name = ?, "+
		"avatar_url = ?, updated_at = ? WHERE id = ?", user.ID, displayName, avatar, now, byUsername.ID); err != nil {
		return nil, err
	}
	return &Member{ID: byUsername.ID, TeamID: byUsername.TeamID, GithubUserID: user.ID,
		GithubUsername: byUsername.GithubUsername, DisplayName: displayName, AvatarURL: avatar,
		AccountUserID: byUsername.AccountUserID, Role: byUsername.Role, Status: "active",
		CreatedAt: byUsername.CreatedAt, UpdatedAt: now}, nil
}

// signInWithCode exchanges an authorization code at GitHub and opens a session.
func (h *Hub) signInWithCode(code string, codeVerifier *string, redirectURI string, now int64) (*SessionTokens, *Member, error) {
	githubToken, err := h.exchangeCodeForGithubToken(code, codeVerifier, redirectURI)
	if err != nil {
		return nil, nil, err
	}
	user, err := h.fetchGithubUser(githubToken)
	if err != nil {
		return nil, nil, err
	}
	member, err := h.resolveMemberForGithubUser(user, now)
	if err != nil {
		return nil, nil, err
	}
	tokens, _, err := h.issueSession(member, now)
	if err != nil {
		return nil, nil, err
	}
	return tokens, member, nil
}

// verifyPkce finds the pending authorization by code and compares the verifier
// against the challenge the client stored at authorize time.
func (h *Hub) verifyPkce(code string, codeVerifier *string, now int64) (*OAuthState, error) {
	state, err := scanOAuthState(h.db.QueryRow(
		"SELECT "+oauthStateColumns+" FROM oauth_states WHERE code = ?", code))
	if errors.Is(err, errNoRows) {
		return nil, Fail(CodeInvalidOAuthCode, "The authorization code is unknown or expired.")
	}
	if err != nil {
		return nil, err
	}
	if state.ExpiresAt <= now {
		return nil, Fail(CodeInvalidOAuthCode, "The authorization code is unknown or expired.")
	}
	if state.CodeChallenge != nil {
		if codeVerifier == nil || *codeVerifier == "" {
			return nil, FailWith(CodeInvalidPKCE,
				"code_verifier is required for a PKCE authorization.",
				map[string]any{"field": "code_verifier"})
		}
		digest := sha256.Sum256([]byte(*codeVerifier))
		if toBase64URL(digest[:]) != *state.CodeChallenge {
			return nil, Fail(CodeInvalidPKCE, "code_verifier does not match the stored code_challenge.")
		}
	}
	return state, nil
}

// completeAuthorizationCode is POST /auth/token: the iOS PKCE finish.
func (h *Hub) completeAuthorizationCode(code string, codeVerifier *string, redirectURI string, now int64) (*SessionTokens, *Member, error) {
	state, err := h.verifyPkce(code, codeVerifier, now)
	if err != nil {
		return nil, nil, err
	}
	tokens, member, err := h.signInWithCode(code, codeVerifier, redirectURI, now)
	if err != nil {
		return nil, nil, err
	}
	if _, err := h.db.Exec("DELETE FROM oauth_states WHERE state = ?", state.State); err != nil {
		return nil, nil, err
	}
	return tokens, member, nil
}

// completeCallback finishes the Web login or hands the code to the app.
func (h *Hub) completeCallback(r *http.Request, now int64) (*url.URL, []string, error) {
	if _, err := h.githubSettings(); err != nil {
		return nil, nil, err
	}
	query := r.URL.Query()
	code := query.Get("code")
	state := query.Get("state")
	if code == "" {
		return nil, nil, Fail(CodeInvalidOAuthCode, "The callback carries no authorization code.")
	}
	if state == "" {
		return nil, nil, Fail(CodeInvalidOAuthCode, "The callback carries no state.")
	}
	row, err := scanOAuthState(h.db.QueryRow(
		"SELECT "+oauthStateColumns+" FROM oauth_states WHERE state = ?", state))
	if errors.Is(err, errNoRows) {
		return nil, nil, Fail(CodeInvalidOAuthCode, "The authorization state is unknown or expired.")
	}
	if err != nil {
		return nil, nil, err
	}
	if row.ExpiresAt <= now {
		return nil, nil, Fail(CodeInvalidOAuthCode, "The authorization state is unknown or expired.")
	}
	if row.Client == "web" && cookieValue(r, oauthStateCookieName) != state {
		return nil, nil, Fail(CodeInvalidOAuthCode,
			"The callback state does not match the browser that started the login.")
	}
	if row.Client == "ios" {
		// The app finishes at POST /auth/token, so the code is recorded on the
		// pending authorization instead of being consumed here.
		if _, err := h.db.Exec("UPDATE oauth_states SET code = ? WHERE state = ?", code, state); err != nil {
			return nil, nil, err
		}
		target, err := url.Parse(row.RedirectURI)
		if err != nil {
			return nil, nil, Fail(CodeValidationFailed, "The pending authorization names an unusable redirect_uri.")
		}
		values := target.Query()
		values.Set("code", code)
		values.Set("state", state)
		target.RawQuery = values.Encode()
		return target, nil, nil
	}
	if _, err := h.db.Exec("DELETE FROM oauth_states WHERE state = ?", state); err != nil {
		return nil, nil, err
	}
	tokens, _, err := h.signInWithCode(code, nil, requestOrigin(r)+githubCallbackPath, now)
	if err != nil {
		return nil, nil, err
	}
	target, err := url.Parse(row.RedirectURI)
	if err != nil {
		return nil, nil, Fail(CodeValidationFailed, "The pending authorization names an unusable redirect_uri.")
	}
	values := target.Query()
	values.Set("state", state)
	target.RawQuery = values.Encode()
	return target, sessionCookies(tokens), nil
}
