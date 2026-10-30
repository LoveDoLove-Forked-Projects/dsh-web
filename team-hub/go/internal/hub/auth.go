package hub

// Session identity: signed access tokens, rotating refresh tokens, Host tokens
// by hash, the cookie the Web GUI carries, and the section 11 quotas.

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

const (
	accessTokenTTLMS   = 7_200_000
	refreshTokenTTLMS  = 2_592_000_000
	accessTokenPrefix  = "th_usr_"
	refreshTokenPrefix = "th_ref_"
	hostTokenPrefix    = "th_host_"
	hostTokenHexLength = 64

	bootstrapTokenHeader = "X-Bootstrap-Token"

	sessionCookieName    = "th_session"
	refreshCookieName    = "th_refresh"
	oauthStateCookieName = "th_oauth_state"

	rateLimitWindowMS  = 60_000
	rateLimitAuthPerIP = 20
	rateLimitMember    = 120
	rateLimitHost      = 120
)

// Principal is the caller of a request: a member session or a Host token.
type Principal struct {
	Kind      string
	Member    *Member
	Host      *Host
	SessionID string
}

// SessionTokens is the token pair every sign-in route answers with.
type SessionTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
}

func toBase64URL(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

func fromBase64URL(value string) ([]byte, error) {
	trimmed := strings.TrimRight(value, "=")
	return base64.RawURLEncoding.DecodeString(trimmed)
}

func (h *Hub) signAccessToken(memberID, sessionID string, now int64) string {
	expiresAt := now + accessTokenTTLMS
	payload := toBase64URL([]byte(memberID + "|" + sessionID + "|" + strconv.FormatInt(expiresAt, 10)))
	mac := hmac.New(sha256.New, []byte(h.config.SessionSecret))
	mac.Write([]byte(payload))
	return accessTokenPrefix + payload + "." + toBase64URL(mac.Sum(nil))
}

// verifyAccessToken checks the signature first and the expiry second.
func (h *Hub) verifyAccessToken(token string, now int64) (memberID string, sessionID string, ok bool) {
	if !strings.HasPrefix(token, accessTokenPrefix) {
		return "", "", false
	}
	body := strings.TrimPrefix(token, accessTokenPrefix)
	separator := strings.Index(body, ".")
	if separator < 0 {
		return "", "", false
	}
	payload := body[:separator]
	signature := body[separator+1:]
	mac := hmac.New(sha256.New, []byte(h.config.SessionSecret))
	mac.Write([]byte(payload))
	expected := toBase64URL(mac.Sum(nil))
	if !hmac.Equal([]byte(signature), []byte(expected)) {
		return "", "", false
	}
	decoded, err := fromBase64URL(payload)
	if err != nil {
		return "", "", false
	}
	parts := strings.Split(string(decoded), "|")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", "", false
	}
	expiresAt, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || expiresAt <= now {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func (h *Hub) sessionAlive(sessionID string, now int64) (bool, error) {
	var alive int
	err := h.db.QueryRow(
		"SELECT 1 FROM refresh_tokens WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1",
		sessionID, now).Scan(&alive)
	if errors.Is(err, errNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// issueSession opens a new session and returns its token pair.
func (h *Hub) issueSession(member *Member, now int64) (*SessionTokens, string, error) {
	sessionID := RandomHex(16)
	refreshToken := refreshTokenPrefix + RandomHex(32)
	_, err := h.db.Exec(
		`INSERT INTO refresh_tokens (id, member_id, session_id, token_hash, expires_at, created_at, revoked_at)
		 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
		NewID("rtok", now), member.ID, sessionID, SHA256Hex(refreshToken), now+refreshTokenTTLMS, now)
	if err != nil {
		return nil, "", err
	}
	return &SessionTokens{
		AccessToken:  h.signAccessToken(member.ID, sessionID, now),
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		ExpiresIn:    accessTokenTTLMS / 1000,
	}, sessionID, nil
}

func (h *Hub) refreshTokenRow(presented string) (*RefreshToken, error) {
	row, err := scanRefreshToken(h.db.QueryRow(
		"SELECT "+refreshTokenColumns+" FROM refresh_tokens WHERE token_hash = ?", SHA256Hex(presented)))
	if errors.Is(err, errNoRows) {
		return nil, nil
	}
	return row, err
}

// rotateRefreshToken revokes the presented token and replaces it in one
// transaction, so a replay of the old token can never win a second session.
func (h *Hub) rotateRefreshToken(presented string, now int64) (*SessionTokens, *Member, error) {
	row, err := h.refreshTokenRow(presented)
	if err != nil {
		return nil, nil, err
	}
	if row == nil || row.RevokedAt != nil || row.ExpiresAt <= now {
		return nil, nil, Fail(CodeInvalidRefreshToken, "Refresh token is unknown, revoked, or expired.")
	}
	member, err := queryMember(h.db, "SELECT "+memberColumns+" FROM members WHERE id = ?", row.MemberID)
	if err != nil {
		return nil, nil, err
	}
	if member == nil || member.Status != "active" {
		return nil, nil, Fail(CodeInvalidRefreshToken, "The member behind this refresh token is not active.")
	}
	refreshToken := refreshTokenPrefix + RandomHex(32)
	tokens := &SessionTokens{
		AccessToken:  h.signAccessToken(member.ID, row.SessionID, now),
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		ExpiresIn:    accessTokenTTLMS / 1000,
	}
	err = h.db.Tx(func(tx *sql.Tx) error {
		if _, err := tx.Exec("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?", now, row.ID); err != nil {
			return err
		}
		_, err := tx.Exec(
			`INSERT INTO refresh_tokens (id, member_id, session_id, token_hash, expires_at, created_at, revoked_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL)`,
			NewID("rtok", now), member.ID, row.SessionID, SHA256Hex(refreshToken), now+refreshTokenTTLMS, now)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	return tokens, member, nil
}

// revokeSession terminates the session the presented token belongs to.
func (h *Hub) revokeSession(presented string, now int64) error {
	row, err := h.refreshTokenRow(presented)
	if err != nil {
		return err
	}
	if row == nil {
		return Fail(CodeUnauthorized, "Refresh token is unknown.")
	}
	_, err = h.db.Exec("UPDATE refresh_tokens SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
		now, row.SessionID)
	return err
}

// revokeMemberSessions terminates every session of one member.
func (h *Hub) revokeMemberSessions(memberID string, now int64) error {
	_, err := h.db.Exec("UPDATE refresh_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL",
		now, memberID)
	return err
}

// cookieValue reads one cookie of the request.
func cookieValue(r *http.Request, name string) string {
	cookie, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return cookie.Value
}

func bearerFromRequest(r *http.Request) string {
	header := r.Header.Get("authorization")
	if len(header) >= 7 && strings.EqualFold(header[:7], "bearer ") {
		value := strings.TrimSpace(header[7:])
		if value != "" {
			return value
		}
	}
	return cookieValue(r, sessionCookieName)
}

// authenticate resolves the caller to a member or a host principal. Team
// membership itself is checked by the router, which knows the team from the
// path; this only establishes identity.
func (h *Hub) authenticate(r *http.Request, now int64) (*Principal, error) {
	token := bearerFromRequest(r)
	if token == "" {
		return nil, Fail(CodeUnauthorized, "Missing bearer token.")
	}
	if strings.HasPrefix(token, hostTokenPrefix) {
		host, err := queryHost(h.db, "SELECT "+hostColumns+" FROM hosts WHERE token_hash = ?", SHA256Hex(token))
		if err != nil {
			return nil, err
		}
		if host == nil {
			return nil, Fail(CodeUnauthorized, "Host token is not recognised.")
		}
		if host.Status == "revoked" {
			return nil, Fail(CodeUnauthorized, "Host token has been revoked.")
		}
		return &Principal{Kind: "host", Host: host}, nil
	}
	memberID, sessionID, ok := h.verifyAccessToken(token, now)
	if !ok {
		return nil, Fail(CodeUnauthorized, "Access token is invalid or expired.")
	}
	member, err := queryMember(h.db, "SELECT "+memberColumns+" FROM members WHERE id = ?", memberID)
	if err != nil {
		return nil, err
	}
	if member == nil {
		return nil, Fail(CodeUnauthorized, "The member behind this token no longer exists.")
	}
	if member.Status != "active" {
		return nil, Fail(CodeUnauthorized, "The member behind this token is not active.")
	}
	alive, err := h.sessionAlive(sessionID, now)
	if err != nil {
		return nil, err
	}
	if !alive {
		return nil, Fail(CodeUnauthorized, "This session has been revoked.")
	}
	return &Principal{Kind: "member", Member: member, SessionID: sessionID}, nil
}

func requireMember(principal *Principal) (*Principal, error) {
	if principal == nil || principal.Kind != "member" {
		return nil, Fail(CodeForbidden, "This endpoint requires a member session token.")
	}
	return principal, nil
}

func requireAdmin(principal *Principal) (*Principal, error) {
	member, err := requireMember(principal)
	if err != nil {
		return nil, err
	}
	if member.Member.Role != "admin" {
		return nil, Fail(CodeForbidden, "This endpoint requires the admin role.")
	}
	return member, nil
}

func requireHost(principal *Principal) (*Principal, error) {
	if principal == nil || principal.Kind != "host" {
		return nil, Fail(CodeForbidden, "This endpoint requires a Host token.")
	}
	return principal, nil
}

// consumeQuota applies the section 11 counters, one row per bucket and window.
func (h *Hub) consumeQuota(scope, identity string, limit int, now int64) error {
	windowStart := (now / rateLimitWindowMS) * rateLimitWindowMS
	bucketKey := scope + ":" + identity
	var used int64
	err := h.db.QueryRow(
		`INSERT INTO rate_limits (bucket_key, window_start, request_count) VALUES (?, ?, 1)
		 ON CONFLICT(bucket_key, window_start) DO UPDATE SET request_count = request_count + 1
		 RETURNING request_count`,
		bucketKey, windowStart).Scan(&used)
	if err != nil {
		return err
	}
	if used > int64(limit) {
		return FailWith(CodeRateLimited,
			"Rate limit of "+strconv.Itoa(limit)+" requests per minute exceeded.",
			map[string]any{
				"limit":          limit,
				"window_ms":      rateLimitWindowMS,
				"retry_after_ms": windowStart + rateLimitWindowMS - now,
			})
	}
	return nil
}

// requireBootstrapToken guards the one route that runs before any member
// exists: the operator's one-shot secret is the whole gate.
func (h *Hub) requireBootstrapToken(r *http.Request) error {
	secret := h.config.BootstrapToken
	if secret == "" {
		return Fail(CodeNotConfigured,
			"BOOTSTRAP_TOKEN is not configured on this hub; bootstrap is closed.")
	}
	presented := r.Header.Get(bootstrapTokenHeader)
	if presented == "" {
		return Fail(CodeUnauthorized, "Bootstrap requires the "+bootstrapTokenHeader+" header.")
	}
	if !hmac.Equal([]byte(SHA256Hex(presented)), []byte(SHA256Hex(secret))) {
		return Fail(CodeUnauthorized, "The bootstrap token is not valid.")
	}
	return nil
}

// mintHostToken returns a fresh Host Token and its stored hash.
func mintHostToken() (token string, hash string) {
	token = hostTokenPrefix + RandomHex(hostTokenHexLength/2)
	return token, SHA256Hex(token)
}

// sessionCookie serialises one session cookie; the Web GUI never reads these
// from JavaScript.
func sessionCookie(name, value string, maxAgeSeconds int64) string {
	return name + "=" + value + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=" +
		strconv.FormatInt(maxAgeSeconds, 10)
}

func sessionCookies(tokens *SessionTokens) []string {
	return []string{
		sessionCookie(sessionCookieName, tokens.AccessToken, tokens.ExpiresIn),
		sessionCookie(refreshCookieName, tokens.RefreshToken, refreshTokenTTLMS/1000),
	}
}
