package hub

// The process entry point of the library: configuration, schema, listener,
// sweeper and the graceful shutdown the binary calls on a signal.

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Options configure one hub process.
type Options struct {
	// Outbound is the GitHub / account service / APNs transport; nil uses the
	// production client. The test suite injects its fake here.
	Outbound Doer
	// Logf receives one line per event worth reporting; nil discards them.
	Logf func(format string, args ...any)
	// Now is the clock in milliseconds; nil uses the wall clock.
	Now func() int64
}

// Hub is one running hub: configuration, database, channel, route table and
// process timer.
type Hub struct {
	config   Config
	db       *DB
	channel  *ChannelHub
	outbound Doer
	logf     func(format string, args ...any)
	now      func() int64

	jwks jwksCache

	apnsMu       sync.Mutex
	apnsJWT      string
	apnsIssuedAt int64
	apnsKeyID    string
	apnsTeamID   string

	mux       *http.ServeMux
	server    *http.Server
	listener  net.Listener
	origin    string
	startedAt int64

	sweepMu   sync.Mutex
	sweeping  bool
	sweepStop chan struct{}
	sweepDone chan struct{}
}

func nowMS() int64 { return time.Now().UnixMilli() }

// New opens the database, applies the schema and builds the route table. It does
// not listen yet: Start runs the startup sweep first, then opens the port.
func New(config Config, options Options) (*Hub, error) {
	database, err := OpenDB(config.DatabasePath)
	if err != nil {
		return nil, err
	}
	hub := &Hub{
		config:    config,
		db:        database,
		channel:   NewChannelHub(),
		outbound:  options.Outbound,
		logf:      options.Logf,
		now:       options.Now,
		mux:       http.NewServeMux(),
		startedAt: 0,
	}
	if hub.outbound == nil {
		hub.outbound = NewDefaultDoer()
	}
	if hub.logf == nil {
		hub.logf = func(string, ...any) {}
	}
	if hub.now == nil {
		hub.now = nowMS
	}
	hub.startedAt = hub.now()
	_, newly, err := ApplyMigrations(database, config.MigrationsDir)
	if err != nil {
		_ = database.Close()
		return nil, err
	}
	if len(newly) > 0 {
		hub.logf("[migrate] applied %s", joinComma(newly))
	}
	hub.registerRoutes()
	return hub, nil
}

func joinComma(values []string) string {
	out := ""
	for index, value := range values {
		if index > 0 {
			out += ", "
		}
		out += value
	}
	return out
}

// DB exposes the handle for tests and for the binary's shutdown report.
func (h *Hub) DB() *DB { return h.db }

// Config exposes the resolved settings.
func (h *Hub) Config() Config { return h.config }

// Channel exposes the in-process channel for tests that read its sequence.
func (h *Hub) Channel() *ChannelHub { return h.channel }

// Origin is the base URL the listener answers on, known after Start.
func (h *Hub) Origin() string { return h.origin }

// ServeHTTP dispatches one request. A path no route matches answers the
// protocol's NOT_FOUND envelope rather than net/http's plain-text page.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if _, pattern := h.mux.Handler(r); pattern == "" {
		WriteError(w, Fail(CodeNotFound, "No route matches "+r.Method+" "+r.URL.Path+"."))
		return
	}
	h.mux.ServeHTTP(w, r)
}

// Start listens, runs the startup sweep and then serves. The sweep runs before
// the port takes traffic, exactly as the Worker's cron did on a cold start.
func (h *Hub) Start() (string, error) {
	if h.listener != nil {
		return h.origin, nil
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(h.config.Host, strconv.Itoa(h.config.Port)))
	if err != nil {
		return "", err
	}
	h.listener = listener
	address, ok := listener.Addr().(*net.TCPAddr)
	port := h.config.Port
	if ok {
		port = address.Port
	}
	h.origin = "http://" + net.JoinHostPort(h.config.Host, strconv.Itoa(port))
	if _, err := h.Sweep(); err != nil {
		_ = listener.Close()
		h.listener = nil
		return "", err
	}
	h.server = &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 15 * time.Second,
	}
	h.startSweeper()
	go func() {
		if err := h.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			h.logf("[http] server stopped: %v", err)
		}
	}()
	return h.origin, nil
}

// Sweep runs one sweep now; a sweep already in flight reports no change, so a
// slow database cannot pile sweeps up.
func (h *Hub) Sweep() (SweepResult, error) {
	h.sweepMu.Lock()
	if h.sweeping {
		h.sweepMu.Unlock()
		return SweepResult{}, nil
	}
	h.sweeping = true
	h.sweepMu.Unlock()
	defer func() {
		h.sweepMu.Lock()
		h.sweeping = false
		h.sweepMu.Unlock()
	}()
	return h.SweepAll(h.now())
}

func (h *Hub) startSweeper() {
	if h.config.SweepIntervalMS <= 0 || h.sweepStop != nil {
		return
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	h.sweepStop = stop
	h.sweepDone = done
	interval := time.Duration(h.config.SweepIntervalMS) * time.Millisecond
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				result, err := h.Sweep()
				if err != nil {
					h.logf("[sweep] sweep failed: %v", err)
					continue
				}
				if result.HostsOffline+result.LeasesExpired+result.QuestionsExpired > 0 {
					h.logf("[sweep] hosts_offline=%d leases_expired=%d questions_expired=%d",
						result.HostsOffline, result.LeasesExpired, result.QuestionsExpired)
				}
			}
		}
	}()
}

func (h *Hub) stopSweeper() {
	if h.sweepStop == nil {
		return
	}
	close(h.sweepStop)
	<-h.sweepDone
	h.sweepStop = nil
}

// Close stops the timer, closes every socket and drains the HTTP server.
func (h *Hub) Close() error {
	h.stopSweeper()
	h.channel.CloseAll("server_shutdown")
	var shutdownErr error
	if h.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		shutdownErr = h.server.Shutdown(ctx)
		cancel()
		h.server = nil
	}
	if h.listener != nil {
		_ = h.listener.Close()
		h.listener = nil
	}
	if closeErr := h.db.Close(); closeErr != nil {
		return closeErr
	}
	return shutdownErr
}
