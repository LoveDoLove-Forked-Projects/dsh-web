package hub

// The in-process team channel: the per-team event sequence, the replay buffer
// and the connected sockets. The Worker kept the same state in a Durable Object;
// a single Go process serialises its writes anyway, so what is left is the
// channel half - sequence assignment, the section 13 bounds, the resumption
// rules, host-targeted delivery and the frame limits.
//
// Nothing is persisted. A restart starts the sequence at zero, and a client
// reconnecting with an old since_seq receives resync_required and re-fetches the
// snapshot, which is the section 9 recovery path.

import (
	"encoding/json"
	"errors"
	"sync"

	"github.com/gorilla/websocket"
)

const (
	// WsFrameLimitBytes is section 11's text frame cap.
	WsFrameLimitBytes = 65_536
	// EventBufferMaxEvents is section 13's replay buffer event cap.
	EventBufferMaxEvents = 1_000
	// EventBufferWindowMS is section 13's replay buffer time window.
	EventBufferWindowMS = 3_600_000
	// rateLimitWsFrames is section 11's frames per connection per window.
	rateLimitWsFrames = 60
)

// ChannelEvent is one mutation a caller asks the channel to publish.
type ChannelEvent struct {
	Event        string
	Payload      any
	TargetHostID *string
}

type channelFrame struct {
	Seq          int64
	Event        string
	TS           int64
	TargetHostID *string
	wire         []byte
}

type teamChannelState struct {
	seq         int64
	buffer      []*channelFrame
	connections map[*wsConnection]struct{}
}

// wsConnection is one attached socket. Every write goes through writeMu, and
// ordering between a resume and a live broadcast is kept by the hub mutex.
type wsConnection struct {
	hostID     string
	conn       *websocket.Conn
	writeMu    sync.Mutex
	frameTimes []int64
}

func (c *wsConnection) sendText(payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteMessage(websocket.TextMessage, payload)
}

func (c *wsConnection) closeWith(code int, reason string) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_ = c.conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason))
	_ = c.conn.Close()
}

// ChannelHub owns every team channel of this process.
type ChannelHub struct {
	mu    sync.Mutex
	teams map[string]*teamChannelState
}

// NewChannelHub builds an empty channel hub.
func NewChannelHub() *ChannelHub {
	return &ChannelHub{teams: make(map[string]*teamChannelState)}
}

func (hub *ChannelHub) team(teamID string) *teamChannelState {
	state, ok := hub.teams[teamID]
	if !ok {
		state = &teamChannelState{connections: make(map[*wsConnection]struct{})}
		hub.teams[teamID] = state
	}
	return state
}

// State reports the latest sequence and the oldest one the buffer still holds.
func (hub *ChannelHub) State(teamID string) (latest int64, oldest *int64) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	state := hub.team(teamID)
	latest = state.seq
	if len(state.buffer) > 0 {
		value := state.buffer[0].Seq
		oldest = &value
	}
	return latest, oldest
}

func encodeEventFrame(seq int64, event string, payload json.RawMessage, ts int64) []byte {
	encoded, err := json.Marshal(map[string]any{
		"t": "event", "seq": seq, "event": event, "payload": payload, "ts": ts,
	})
	if err != nil {
		return []byte("{}")
	}
	return encoded
}

// publish is the hub-side entry point the domain modules call.
func (h *Hub) publish(teamID string, events []ChannelEvent) error {
	_, err := h.channel.Publish(teamID, events)
	return err
}

// Publish appends events, assigns their sequence numbers and fans them out.
func (hub *ChannelHub) Publish(teamID string, events []ChannelEvent) (int64, error) {
	if len(events) == 0 {
		return 0, nil
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	state := hub.team(teamID)
	now := nowMS()
	published := make([]*channelFrame, 0, len(events))
	for _, event := range events {
		if event.Event == "" {
			return 0, errors.New("team-hub: every channel event needs a name")
		}
		payloadValue := event.Payload
		if payloadValue == nil {
			payloadValue = map[string]any{}
		}
		raw, err := json.Marshal(payloadValue)
		if err != nil {
			return 0, err
		}
		state.seq++
		frame := &channelFrame{
			Seq: state.seq, Event: event.Event, TS: now, TargetHostID: event.TargetHostID,
			wire: encodeEventFrame(state.seq, event.Event, raw, now),
		}
		state.buffer = append(state.buffer, frame)
		published = append(published, frame)
	}
	trimBuffer(state, now)
	for _, frame := range published {
		fanOut(state, frame)
	}
	return state.seq, nil
}

// trimBuffer applies both bounds of section 13: newest 1,000 events, nothing
// older than one hour.
func trimBuffer(state *teamChannelState, now int64) {
	for len(state.buffer) > EventBufferMaxEvents {
		state.buffer = state.buffer[1:]
	}
	cutoff := now - EventBufferWindowMS
	for len(state.buffer) > 0 && state.buffer[0].TS < cutoff {
		state.buffer = state.buffer[1:]
	}
}

func fanOut(state *teamChannelState, frame *channelFrame) {
	for connection := range state.connections {
		if frame.TargetHostID != nil && connection.hostID != *frame.TargetHostID {
			continue
		}
		_ = connection.sendText(frame.wire)
	}
}

// Attach registers a socket and replays what section 9 says it must receive.
func (hub *ChannelHub) Attach(teamID, hostID string, sinceSeq *int64, conn *websocket.Conn) *wsConnection {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	state := hub.team(teamID)
	connection := &wsConnection{hostID: hostID, conn: conn}
	state.connections[connection] = struct{}{}
	hub.resume(state, connection, sinceSeq)
	return connection
}

// Detach removes a socket from its team.
func (hub *ChannelHub) Detach(teamID string, connection *wsConnection) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if state, ok := hub.teams[teamID]; ok {
		delete(state.connections, connection)
	}
}

func (hub *ChannelHub) resume(state *teamChannelState, connection *wsConnection, since *int64) {
	if since == nil || *since == 0 {
		hub.sendResync(state, connection, "no_sequence")
		return
	}
	if *since > state.seq {
		hub.sendResync(state, connection, "sequence_ahead")
		return
	}
	oldest := state.seq + 1
	if len(state.buffer) > 0 {
		oldest = state.buffer[0].Seq
	}
	if *since < oldest-1 {
		hub.sendResync(state, connection, "sequence_too_old")
		return
	}
	for _, frame := range state.buffer {
		if frame.Seq > *since {
			_ = connection.sendText(frame.wire)
		}
	}
}

func (hub *ChannelHub) sendResync(state *teamChannelState, connection *wsConnection, reason string) {
	encoded, err := json.Marshal(map[string]any{
		"t": "resync_required", "reason": reason, "latest_seq": state.seq,
	})
	if err != nil {
		return
	}
	_ = connection.sendText(encoded)
}

// FrameResult reports what the caller must do after one client frame.
type FrameResult int

const (
	// FrameKept means the connection stays open.
	FrameKept FrameResult = iota
	// FrameClosed means the frame violated a limit and the socket is closed.
	FrameClosed
)

// HandleFrame applies the section 9 client frame table to one message.
func (hub *ChannelHub) HandleFrame(teamID string, connection *wsConnection, binary bool, data []byte) FrameResult {
	if binary {
		hub.closeConnection(teamID, connection, 1003, "text_frames_only")
		return FrameClosed
	}
	if len(data) > WsFrameLimitBytes {
		hub.closeConnection(teamID, connection, 1009, "PAYLOAD_TOO_LARGE")
		return FrameClosed
	}
	now := nowMS()
	kept := connection.frameTimes[:0]
	for _, at := range connection.frameTimes {
		if now-at < rateLimitWindowMS {
			kept = append(kept, at)
		}
	}
	connection.frameTimes = append(kept, now)
	if len(connection.frameTimes) > rateLimitWsFrames {
		hub.closeConnection(teamID, connection, 1008, "RATE_LIMITED")
		return FrameClosed
	}
	var parsed any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return FrameKept
	}
	frame, ok := parsed.(map[string]any)
	if !ok {
		return FrameKept
	}
	switch frame["t"] {
	case "ping":
		ts := now
		if value, ok := frame["ts"].(float64); ok {
			ts = int64(value)
		}
		pong, err := json.Marshal(map[string]any{"t": "pong", "ts": ts})
		if err == nil {
			_ = connection.sendText(pong)
		}
	case "resume":
		var since *int64
		if value, ok := frame["since_seq"].(float64); ok {
			sequence := int64(value)
			since = &sequence
		}
		hub.mu.Lock()
		if state, ok := hub.teams[teamID]; ok {
			hub.resume(state, connection, since)
		}
		hub.mu.Unlock()
	}
	return FrameKept
}

func (hub *ChannelHub) closeConnection(teamID string, connection *wsConnection, code int, reason string) {
	hub.mu.Lock()
	if state, ok := hub.teams[teamID]; ok {
		delete(state.connections, connection)
	}
	hub.mu.Unlock()
	connection.closeWith(code, reason)
}

// CloseAll tells every socket why it is going away, then drops the state.
func (hub *ChannelHub) CloseAll(reason string) {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for _, state := range hub.teams {
		for connection := range state.connections {
			connection.closeWith(websocket.CloseGoingAway, reason)
		}
		state.connections = make(map[*wsConnection]struct{})
	}
}
