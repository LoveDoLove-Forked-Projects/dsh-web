package hub

// The WebSocket surface against real sockets: header-only authentication, version
// negotiation, the resync directives, since_seq replay, host-targeted events,
// ping/pong and the frame limits.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func handshakeRefusal(t *testing.T, server *testHub, teamID, token string, query map[string]string,
	omitProtocol bool) (int, map[string]any) {
	t.Helper()
	conn, response, err := server.dial(teamID, token, query, omitProtocol)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("expected the handshake to be refused")
	}
	if response == nil {
		t.Fatalf("no HTTP response on the refused handshake: %v", err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	body := map[string]any{}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("decode refusal %q: %v", string(raw), err)
	}
	return response.StatusCode, body
}

func TestWebSocketHandshakeRefusals(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	status, body := handshakeRefusal(t, server, team.teamID, "", map[string]string{
		"protocol_version": ProtocolVersion,
	}, true)
	if status != http.StatusUnauthorized || errorCode(body) != string(CodeUnauthorized) {
		t.Fatalf("no credentials: %d %v", status, body)
	}

	status, body = handshakeRefusal(t, server, team.teamID, "", map[string]string{
		"protocol_version": ProtocolVersion, "token": team.admin.accessToken,
	}, true)
	if status != http.StatusUnauthorized || errorCode(body) != string(CodeUnauthorized) {
		t.Fatalf("token in the query string: %d %v", status, body)
	}

	status, body = handshakeRefusal(t, server, team.teamID, team.admin.accessToken, map[string]string{
		"since_seq": "0",
	}, true)
	if status != http.StatusBadRequest || errorCode(body) != string(CodeUnsupportedProtocol) {
		t.Fatalf("no protocol version: %d %v", status, body)
	}

	status, body = handshakeRefusal(t, server, team.teamID, team.admin.accessToken, map[string]string{
		"protocol_version": "2.0.0",
	}, true)
	if status != http.StatusBadRequest || errorCode(body) != string(CodeUnsupportedProtocol) {
		t.Fatalf("wrong major version: %d %v", status, body)
	}

	// A member of one team cannot open another team's channel.
	otherTeamID := "team_01j7b5w8m4f9q2e3r6t1y8u4i0"
	if _, err := server.hub.DB().Exec(
		"INSERT INTO teams (id, name, slug, created_at, updated_at) VALUES (?, 'Other', 'other', 1, 1)",
		otherTeamID); err != nil {
		t.Fatalf("insert second team: %v", err)
	}
	status, body = handshakeRefusal(t, server, otherTeamID, team.admin.accessToken, map[string]string{
		"protocol_version": ProtocolVersion,
	}, false)
	if status != http.StatusForbidden || errorCode(body) != string(CodeForbidden) {
		t.Fatalf("another team's channel: %d %v", status, body)
	}
}

func TestWebSocketWithoutUpgradeIsAValidationFailure(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	result := server.api("GET", "/api/v1/teams/"+team.teamID+"/ws", apiOptions{
		token: team.admin.accessToken, query: map[string]string{"protocol_version": ProtocolVersion},
	})
	if result.status != http.StatusBadRequest || errorCode(result.body) != string(CodeValidationFailed) {
		t.Fatalf("plain GET on the socket route: %d %s", result.status, result.text)
	}
}

func TestResyncDirectives(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	fresh := server.connect(team.teamID, team.admin.accessToken, map[string]string{
		"protocol_version": ProtocolVersion, "since_seq": "0",
	})
	frame := fresh.read()
	if frame.t != "resync_required" || frame.reason != "no_sequence" || frame.latestSeq != 0 {
		t.Fatalf("fresh channel: %+v", frame)
	}
	fresh.close()

	server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "first"})
	ahead := server.connect(team.teamID, team.admin.accessToken, map[string]string{
		"protocol_version": ProtocolVersion, "since_seq": "999",
	})
	directive := ahead.read()
	if directive.t != "resync_required" || directive.reason != "sequence_ahead" || directive.latestSeq == 0 {
		t.Fatalf("sequence ahead: %+v", directive)
	}
	ahead.close()

	// Filling the buffer past its event cap trims the head, which is what makes an
	// old checkpoint unrecoverable.
	for index := 0; index < EventBufferMaxEvents+5; index++ {
		if _, err := server.hub.Channel().Publish(team.teamID, []ChannelEvent{{
			Event: "issue.updated", Payload: map[string]any{"n": index},
		}}); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	tooOld := server.connect(team.teamID, team.admin.accessToken, map[string]string{
		"protocol_version": ProtocolVersion, "since_seq": "2",
	})
	old := tooOld.read()
	if old.t != "resync_required" || old.reason != "sequence_too_old" {
		t.Fatalf("sequence too old: %+v", old)
	}
	tooOld.close()
}

func TestSinceSeqReplaysEveryEventInOrder(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()

	server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "baseline"})
	checkpoint, _ := server.hub.Channel().State(team.teamID)
	created := make([]string, 0, 3)
	for _, title := range []string{"one", "two", "three"} {
		issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": title})
		created = append(created, stringField(issue, "id"))
	}

	client := server.connect(team.teamID, team.admin.accessToken, map[string]string{
		"protocol_version": ProtocolVersion, "since_seq": fmt.Sprintf("%d", checkpoint),
	})
	for index := 0; index < 3; index++ {
		frame := client.read()
		if frame.t != "event" || frame.event != "issue.created" || frame.seq != checkpoint+int64(index)+1 {
			t.Fatalf("replayed frame %d: %+v", index, frame)
		}
		issue, _ := frame.payload["issue"].(map[string]any)
		if stringField(issue, "id") != created[index] {
			t.Fatalf("replayed issue %d: %v", index, issue)
		}
		if issue["has_lease"] != false || issue["lease_expires_at"] != nil {
			t.Fatalf("replayed issue view: %v", issue)
		}
	}
}

func TestLiveDeliveryPingAndResumeFrame(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "baseline"})
	client := server.connectCaughtUp(team.teamID, team.admin.accessToken)

	live := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "live"})
	frame := client.read()
	if frame.t != "event" || frame.event != "issue.created" {
		t.Fatalf("live frame: %+v", frame)
	}
	issue, _ := frame.payload["issue"].(map[string]any)
	if stringField(issue, "id") != stringField(live, "id") {
		t.Fatalf("live issue: %v", frame.payload)
	}

	client.send(`{"t":"ping","ts":1700000000123}`)
	pong := client.read()
	if pong.t != "pong" || pong.ts != 1_700_000_000_123 {
		t.Fatalf("pong: %+v", pong)
	}

	// A resume frame replays from the checkpoint the client names.
	checkpoint := frame.seq
	client.send(fmt.Sprintf(`{"t":"resume","since_seq":%d}`, checkpoint-1))
	resumed := client.read()
	if resumed.t != "event" || resumed.seq != checkpoint {
		t.Fatalf("resumed frame: %+v", resumed)
	}
	server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "after resume"})
	next := client.read()
	if next.t != "event" || next.seq != checkpoint+1 {
		t.Fatalf("frame after resume: %+v", next)
	}
}

func TestHostTargetedEventsReachOnlyTheirHost(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	hostA := server.seedHost(team.teamID, team.admin.accessToken, "host-a",
		[]map[string]any{{"name": "qa-bot", "preset_id": "liangshen"}})
	hostB := server.seedHost(team.teamID, team.admin.accessToken, "host-b",
		[]map[string]any{{"name": "dev-bot", "preset_id": "liangshen"}})
	member := server.connectCaughtUp(team.teamID, team.admin.accessToken)
	a := server.connectCaughtUp(team.teamID, hostA.hostToken)
	b := server.connectCaughtUp(team.teamID, hostB.hostToken)

	issue := server.createIssue(team.teamID, team.admin.accessToken, map[string]any{
		"title": "targeted", "assignee_type": "agent", "assignee_id": stringField(hostA.agents[0], "id"),
	})
	for name, client := range map[string]*socketClient{"member": member, "a": a, "b": b} {
		frame := client.read()
		if frame.event != "issue.created" {
			t.Fatalf("%s did not receive issue.created: %+v", name, frame)
		}
	}

	comment := server.api("POST", "/api/v1/teams/"+team.teamID+"/issues/"+stringField(issue, "id")+"/comments",
		apiOptions{token: team.admin.accessToken, body: map[string]any{"content": "@qa-bot please continue"}})
	if comment.status != http.StatusCreated {
		t.Fatalf("comment: %d %s", comment.status, comment.text)
	}
	first := a.read()
	if first.event != "comment.created" {
		t.Fatalf("the host did not receive the team-wide comment first: %+v", first)
	}
	mentioned := a.read()
	if mentioned.event != "comment.mentioned" {
		t.Fatalf("the bound host did not receive the mention: %+v", mentioned)
	}
	if stringField(mentioned.payload, "issue_id") != stringField(issue, "id") ||
		stringField(mentioned.payload, "author") != "Octo Cat" {
		t.Fatalf("mention payload: %v", mentioned.payload)
	}

	if other := b.read(); other.event != "comment.created" {
		t.Fatalf("the other host did not receive the comment: %+v", other)
	}
	b.send(`{"t":"ping","ts":7}`)
	if pong := b.read(); pong.t != "pong" {
		t.Fatalf("the other host's pong: %+v", pong)
	}

	if frame := member.read(); frame.event != "comment.created" {
		t.Fatalf("the member did not receive the team-wide comment: %+v", frame)
	}
	if extra, ok := member.read2(); ok {
		t.Fatalf("the member received a host-targeted event: %+v", extra)
	}
}

// read2 reads one frame if it arrives quickly, and reports nothing otherwise; it
// is how a test states "this socket must not receive anything".
func (c *socketClient) read2() (frame, bool) {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
	_, data, err := c.conn.ReadMessage()
	if err != nil {
		return frame{}, false
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return frame{}, false
	}
	return frame{t: stringField(parsed, "t"), event: stringField(parsed, "event")}, true
}

func readClose(t *testing.T, conn *websocket.Conn) (int, string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			var closeError *websocket.CloseError
			if errors.As(err, &closeError) {
				return closeError.Code, closeError.Text
			}
			t.Fatalf("expected a close frame, got %v", err)
		}
	}
}

func TestFrameLimits(t *testing.T) {
	server := startTestHub(t)
	team := server.seedTeam()
	server.createIssue(team.teamID, team.admin.accessToken, map[string]any{"title": "baseline"})

	binary := server.connectCaughtUp(team.teamID, team.admin.accessToken)
	if err := binary.conn.WriteMessage(websocket.BinaryMessage, []byte("frame")); err != nil {
		t.Fatalf("write binary frame: %v", err)
	}
	if code, reason := readClose(t, binary.conn); code != 1003 || reason != "text_frames_only" {
		t.Fatalf("binary frame close: %d %q", code, reason)
	}

	// One byte past the protocol cap still reaches the channel's own check, which
	// is what carries the protocol's reason string.
	edge := server.connectCaughtUp(team.teamID, team.admin.accessToken)
	if err := edge.conn.WriteMessage(websocket.TextMessage,
		[]byte(strings.Repeat("x", WsFrameLimitBytes+1))); err != nil {
		t.Fatalf("write edge frame: %v", err)
	}
	if code, reason := readClose(t, edge.conn); code != 1009 || reason != "PAYLOAD_TOO_LARGE" {
		t.Fatalf("edge close: %d %q", code, reason)
	}

	// A frame far past the cap is cut by the socket layer with the same code.
	oversize := server.connectCaughtUp(team.teamID, team.admin.accessToken)
	if err := oversize.conn.WriteMessage(websocket.TextMessage,
		[]byte(strings.Repeat("x", WsFrameLimitBytes+1024))); err != nil {
		t.Fatalf("write oversize frame: %v", err)
	}
	if code, _ := readClose(t, oversize.conn); code != 1009 {
		t.Fatalf("oversize close: %d", code)
	}

	chatty := server.connectCaughtUp(team.teamID, team.admin.accessToken)
	for index := 0; index < rateLimitWsFrames+1; index++ {
		chatty.send(fmt.Sprintf(`{"t":"ping","ts":%d}`, index))
	}
	if code, reason := readClose(t, chatty.conn); code != 1008 || reason != "RATE_LIMITED" {
		t.Fatalf("rate limited close: %d %q", code, reason)
	}
}
