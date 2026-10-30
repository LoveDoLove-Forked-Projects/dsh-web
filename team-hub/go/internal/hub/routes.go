package hub

// The route table, in the Worker's order and with the Worker's own policies: a
// per-route auth policy, the section 1 version negotiation, the team check, and
// the section 11 quota. Registration uses net/http's method-plus-path patterns.

import (
	"net"
	"net/http"
	"strings"
)

type authPolicy int

const (
	authPublic authPolicy = iota
	authMember
	authAdmin
	authHost
	authMemberOrHost
	authAdminOrHost
)

type protocolPolicy int

const (
	protocolHeader protocolPolicy = iota
	protocolBrowser
	protocolWebSocket
)

type routeSpec struct {
	method         string
	pattern        string
	auth           authPolicy
	protocol       protocolPolicy
	requiresGitHub bool
	handler        func(*routeContext) error
}

type routeContext struct {
	w         http.ResponseWriter
	r         *http.Request
	principal *Principal
	now       int64
}

func (c *routeContext) teamID() string { return c.r.PathValue("teamId") }

func (h *Hub) routes() []routeSpec {
	return []routeSpec{
		{"GET", "/auth/github/authorize", authPublic, protocolBrowser, true, h.handleAuthorize},
		{"GET", "/auth/github/callback", authPublic, protocolBrowser, true, h.handleCallback},
		{"POST", "/auth/token", authPublic, protocolHeader, true, h.handleToken},
		{"POST", "/auth/refresh", authPublic, protocolHeader, false, h.handleRefresh},
		{"POST", "/auth/revoke", authMember, protocolHeader, false, h.handleRevoke},
		{"POST", "/auth/account", authPublic, protocolHeader, false, h.handleAccountSignIn},
		{"POST", "/auth/account/link", authMember, protocolHeader, false, h.handleAccountLink},

		{"POST", "/api/v1/bootstrap", authPublic, protocolHeader, false, h.handleBootstrap},
		{"GET", "/api/v1/me", authMember, protocolHeader, false, h.handleMe},

		{"GET", "/api/v1/teams/{teamId}/agents", authMember, protocolHeader, false, h.handleAgents},
		{"GET", "/api/v1/teams/{teamId}/members", authMember, protocolHeader, false, h.handleMembers},
		{"POST", "/api/v1/teams/{teamId}/members/invite", authAdmin, protocolHeader, false, h.handleInviteMember},
		{"DELETE", "/api/v1/teams/{teamId}/members/{memberId}", authAdmin, protocolHeader, false, h.handleRemoveMember},

		{"POST", "/api/v1/teams/{teamId}/hosts/tokens", authAdmin, protocolHeader, false, h.handleHostToken},
		{"POST", "/api/v1/teams/{teamId}/hosts/{hostId}/revoke-token", authAdmin, protocolHeader, false, h.handleRevokeHostToken},
		{"POST", "/api/v1/teams/{teamId}/hosts/register", authHost, protocolHeader, false, h.handleRegisterHost},
		{"POST", "/api/v1/teams/{teamId}/hosts/{hostId}/heartbeat", authHost, protocolHeader, false, h.handleHeartbeat},

		{"GET", "/api/v1/teams/{teamId}/issues", authMemberOrHost, protocolHeader, false, h.handleListIssues},
		{"POST", "/api/v1/teams/{teamId}/issues", authMember, protocolHeader, false, h.handleCreateIssue},
		{"GET", "/api/v1/teams/{teamId}/issues/{issueId}", authMemberOrHost, protocolHeader, false, h.handleGetIssue},
		{"PATCH", "/api/v1/teams/{teamId}/issues/{issueId}", authMember, protocolHeader, false, h.handlePatchIssue},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/claim", authHost, protocolHeader, false, h.handleClaim},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/renew-lease", authHost, protocolHeader, false, h.handleRenewLease},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/settle", authHost, protocolHeader, false, h.handleSettle},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/review/approve", authMember, protocolHeader, false, h.handleApproveReview},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/review/reject", authMember, protocolHeader, false, h.handleRejectReview},
		{"GET", "/api/v1/teams/{teamId}/issues/{issueId}/comments", authMemberOrHost, protocolHeader, false, h.handleListComments},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/comments", authMemberOrHost, protocolHeader, false, h.handleCreateComment},
		{"GET", "/api/v1/teams/{teamId}/issues/{issueId}/activity", authMember, protocolHeader, false, h.handleActivity},
		{"POST", "/api/v1/teams/{teamId}/issues/{issueId}/questions", authHost, protocolHeader, false, h.handleCreateQuestion},

		{"POST", "/api/v1/teams/{teamId}/questions/{questionId}/answer", authMember, protocolHeader, false, h.handleAnswerQuestion},
		{"POST", "/api/v1/teams/{teamId}/questions/{questionId}/withdraw", authAdminOrHost, protocolHeader, false, h.handleWithdrawQuestion},
		{"GET", "/api/v1/teams/{teamId}/questions", authMember, protocolHeader, false, h.handleListQuestions},

		{"GET", "/api/v1/teams/{teamId}/inbox", authMember, protocolHeader, false, h.handleInbox},
		{"POST", "/api/v1/teams/{teamId}/inbox/mentions/{commentId}/read", authMember, protocolHeader, false, h.handleMentionRead},

		{"GET", "/api/v1/teams/{teamId}/ws", authMemberOrHost, protocolWebSocket, false, h.handleWebSocket},

		{"POST", "/api/v1/push-tokens", authMember, protocolHeader, false, h.handleRegisterPushToken},
		{"DELETE", "/api/v1/push-tokens/{token}", authMember, protocolHeader, false, h.handleDeletePushToken},
	}
}

// registerRoutes wires every route onto the mux under its method and pattern.
func (h *Hub) registerRoutes() {
	for _, spec := range h.routes() {
		spec := spec
		h.mux.HandleFunc(spec.method+" "+spec.pattern, func(w http.ResponseWriter, r *http.Request) {
			h.dispatch(w, r, spec)
		})
	}
	h.mux.HandleFunc("GET /healthz", h.handleHealthz)
	h.mux.HandleFunc("GET /readyz", h.handleReadyz)
}

func (h *Hub) dispatch(w http.ResponseWriter, r *http.Request, spec routeSpec) {
	now := h.now()
	defer func() {
		if recovered := recover(); recovered != nil {
			h.logf("[http] panic on %s %s: %v", r.Method, r.URL.Path, recovered)
			WriteError(w, Fail(CodeInternal, "Unhandled internal error."))
		}
	}()
	principal, err := h.prepare(r, spec, now)
	if err != nil {
		WriteError(w, err)
		return
	}
	context := &routeContext{w: w, r: r, principal: principal, now: now}
	if err := spec.handler(context); err != nil {
		WriteError(w, err)
	}
}

func (h *Hub) prepare(r *http.Request, spec routeSpec, now int64) (*Principal, error) {
	if spec.requiresGitHub && h.config.GitHub == nil {
		return nil, Fail(CodeNotConfigured,
			"GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are not configured on this hub.")
	}
	switch spec.protocol {
	case protocolHeader:
		if err := RequireProtocolVersion(r); err != nil {
			return nil, err
		}
	case protocolWebSocket:
		if err := RequireWebSocketProtocolVersion(r); err != nil {
			return nil, err
		}
	}
	var principal *Principal
	if spec.auth != authPublic {
		resolved, err := h.authenticate(r, now)
		if err != nil {
			return nil, err
		}
		principal = resolved
	}
	if err := enforceAuthPolicy(spec.auth, principal); err != nil {
		return nil, err
	}
	if teamID := r.PathValue("teamId"); teamID != "" {
		if _, err := h.GetTeam(teamID); err != nil {
			return nil, err
		}
		if principal != nil {
			principalTeam := ""
			if principal.Kind == "host" {
				principalTeam = principal.Host.TeamID
			} else {
				principalTeam = principal.Member.TeamID
			}
			if principalTeam != teamID {
				if principal.Kind == "host" {
					return nil, Fail(CodeHostMismatch, "This Host token belongs to another team.")
				}
				return nil, Fail(CodeForbidden, "This member does not belong to the team in the path.")
			}
		}
	}
	if err := h.applyQuota(principal, r, now); err != nil {
		return nil, err
	}
	return principal, nil
}

// enforceAuthPolicy is the section 11 role matrix over the principal kinds each
// route allows.
func enforceAuthPolicy(policy authPolicy, principal *Principal) error {
	switch policy {
	case authPublic:
		return nil
	case authMember:
		if principal == nil {
			return Fail(CodeUnauthorized, "Authentication is required.")
		}
		_, err := requireMember(principal)
		return err
	case authAdmin:
		if principal == nil {
			return Fail(CodeUnauthorized, "Authentication is required.")
		}
		_, err := requireAdmin(principal)
		return err
	case authHost:
		if principal == nil {
			return Fail(CodeUnauthorized, "Authentication is required.")
		}
		_, err := requireHost(principal)
		return err
	case authMemberOrHost:
		if principal == nil {
			return Fail(CodeUnauthorized, "Authentication is required.")
		}
		return nil
	case authAdminOrHost:
		if principal == nil {
			return Fail(CodeUnauthorized, "Authentication is required.")
		}
		if principal.Kind == "host" {
			return nil
		}
		_, err := requireAdmin(principal)
		return err
	}
	return nil
}

func (h *Hub) applyQuota(principal *Principal, r *http.Request, now int64) error {
	if principal == nil {
		return h.consumeQuota("auth", clientIP(r), rateLimitAuthPerIP, now)
	}
	if principal.Kind == "host" {
		return h.consumeQuota("host", principal.Host.ID, rateLimitHost, now)
	}
	return h.consumeQuota("member", principal.Member.ID, rateLimitMember, now)
}

// clientIP is the address the per-IP quota keys on behind the proxy.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("x-forwarded-for"); forwarded != "" {
		first := forwarded
		if index := strings.Index(first, ","); index >= 0 {
			first = first[:index]
		}
		if trimmed := strings.TrimSpace(first); trimmed != "" {
			return trimmed
		}
	}
	if connecting := strings.TrimSpace(r.Header.Get("cf-connecting-ip")); connecting != "" {
		return connecting
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil && host != "" {
		return host
	}
	return "unknown"
}

// requestScheme honours the proxy header the deployment forwards.
func requestScheme(r *http.Request) string {
	if forwarded := r.Header.Get("x-forwarded-proto"); forwarded != "" {
		first := forwarded
		if index := strings.Index(first, ","); index >= 0 {
			first = first[:index]
		}
		if trimmed := strings.TrimSpace(first); trimmed != "" {
			return trimmed
		}
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

func requestOrigin(r *http.Request) string { return requestScheme(r) + "://" + r.Host }

// handleHealthz is liveness: the process answers, nothing else is claimed.
func (h *Hub) handleHealthz(w http.ResponseWriter, r *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"status":           "ok",
		"service":          "dsh-team-hub-go",
		"protocol_version": ProtocolVersion,
		"uptime_ms":        h.now() - h.startedAt,
	})
}

// handleReadyz is readiness: the database answers and no migration is pending.
func (h *Hub) handleReadyz(w http.ResponseWriter, r *http.Request) {
	databaseOK := h.db.Ping() == nil
	applied, pending, err := MigrationStatus(h.db, h.config.MigrationsDir)
	if err != nil {
		databaseOK = false
		applied = []string{}
		pending = []string{}
	}
	ready := databaseOK && len(pending) == 0
	body := map[string]any{
		"status":   "not_ready",
		"database": "unavailable",
		"migrations": map[string]any{
			"applied": len(applied),
			"pending": pending,
		},
		"features": map[string]any{
			"github_login":    h.config.GitHub != nil,
			"account_sign_in": h.config.Account != nil,
			"push":            h.config.APNS != nil,
			"bootstrap":       h.config.BootstrapToken != "",
		},
	}
	if databaseOK {
		body["database"] = "ok"
	}
	if ready {
		body["status"] = "ready"
	}
	status := http.StatusOK
	if !ready {
		status = http.StatusServiceUnavailable
	}
	WriteJSON(w, status, body)
}
