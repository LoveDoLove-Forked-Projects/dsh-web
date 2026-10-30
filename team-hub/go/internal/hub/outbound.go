package hub

// Outbound HTTP for the three external services the Hub calls: GitHub, the
// account service and APNs. The transport is an interface so the test suite can
// serve all three contracts with a fake that sees the exact requests the hub
// builds, which is the same seam the Worker suite injects.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// Doer is one outbound HTTP round trip.
type Doer interface {
	Do(req *http.Request) (*http.Response, error)
}

type defaultDoer struct{ client *http.Client }

func (d defaultDoer) Do(req *http.Request) (*http.Response, error) { return d.client.Do(req) }

// NewDefaultDoer is the production transport: one client with a bounded timeout.
func NewDefaultDoer() Doer {
	return defaultDoer{client: &http.Client{Timeout: 30 * time.Second}}
}

const (
	githubOAuthBase    = "https://github.com"
	githubAPIBase      = "https://api.github.com"
	githubCallbackPath = "/auth/github/callback"
	iosRedirectURI     = "whale://auth/callback"
	apnsProductionBase = "https://api.push.apple.com"
	apnsSandboxBase    = "https://api.sandbox.push.apple.com"
)

// outboundResponse is one reply reduced to what the callers need.
type outboundResponse struct {
	Status int
	Body   any
	Text   string
}

// callOutbound performs one request and parses a JSON body when there is one.
func (h *Hub) callOutbound(method, url string, headers map[string]string, body string) (*outboundResponse, error) {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		return nil, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := h.outbound.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	parsed := any(nil)
	if err := json.Unmarshal(raw, &parsed); err != nil {
		parsed = nil
	}
	return &outboundResponse{Status: response.StatusCode, Body: parsed, Text: string(raw)}, nil
}
