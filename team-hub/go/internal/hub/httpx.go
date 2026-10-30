package hub

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"
)

const (
	// ProtocolVersion is the version this hub serves (section 1).
	ProtocolVersion = "1.0.0"
	// ProtocolMajor is the only component that must match.
	ProtocolMajor = 1
	// ProtocolHeader carries the version on every protocol request.
	ProtocolHeader = "X-Team-Hub-Protocol-Version"
	// RequestBodyLimitBytes is the section 11 total body cap.
	RequestBodyLimitBytes = 131_072
)

// MajorOf returns the major version of a candidate string, or false when the
// string is not a three-part semantic version.
func MajorOf(version string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(version), ".")
	if len(parts) != 3 {
		return 0, false
	}
	for _, part := range parts {
		if part == "" {
			return 0, false
		}
		for _, character := range part {
			if character < '0' || character > '9' {
				return 0, false
			}
		}
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, false
	}
	return major, true
}

// RequireProtocolVersion applies section 1 negotiation to a request header.
func RequireProtocolVersion(r *http.Request) error {
	declared := r.Header.Get(ProtocolHeader)
	if strings.TrimSpace(declared) == "" {
		return Fail(CodeUnsupportedProtocol, "Missing "+ProtocolHeader+" header; this hub serves "+ProtocolVersion+".")
	}
	major, ok := MajorOf(declared)
	if !ok || major != ProtocolMajor {
		return FailWith(CodeUnsupportedProtocol,
			"Protocol version "+declared+" is not compatible with "+ProtocolVersion+".",
			map[string]any{"supported": ProtocolVersion})
	}
	return nil
}

// RequireWebSocketProtocolVersion accepts the version as a query parameter or
// as the header, which is what the handshake contract allows.
func RequireWebSocketProtocolVersion(r *http.Request) error {
	declared := r.URL.Query().Get("protocol_version")
	if strings.TrimSpace(declared) == "" {
		declared = r.Header.Get(ProtocolHeader)
	}
	if strings.TrimSpace(declared) == "" {
		return Fail(CodeUnsupportedProtocol, "The WebSocket handshake needs protocol_version="+ProtocolVersion+".")
	}
	major, ok := MajorOf(declared)
	if !ok || major != ProtocolMajor {
		return FailWith(CodeUnsupportedProtocol, "Protocol version "+declared+" is not compatible.",
			map[string]any{"supported": ProtocolVersion})
	}
	return nil
}

// WriteJSON writes one JSON body and advertises the protocol version outbound.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set(ProtocolHeader, ProtocolVersion)
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}

// WriteError renders a protocol error envelope; anything that is not an *Error
// is an internal failure and never leaks its text to the client.
func WriteError(w http.ResponseWriter, err error) {
	protocol, ok := err.(*Error)
	if !ok {
		protocol = Fail(CodeInternal, "Unhandled internal error.")
	}
	WriteJSON(w, protocol.Status, errorEnvelope(protocol))
}

// UTF8Len is the byte length unit every section 11 cap is expressed in.
func UTF8Len(value string) int { return len([]byte(value)) }

// ReadJSONBody reads a JSON object body under the section 11 total body cap.
func ReadJSONBody(r *http.Request) (map[string]any, error) {
	if r.ContentLength > RequestBodyLimitBytes {
		return nil, Fail(CodePayloadTooLarge, "Request body exceeds "+
			strconv.Itoa(RequestBodyLimitBytes)+" bytes.")
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, RequestBodyLimitBytes+1))
	if err != nil {
		return nil, Fail(CodeValidationFailed, "Request body could not be read.")
	}
	if len(raw) > RequestBodyLimitBytes {
		return nil, Fail(CodePayloadTooLarge, "Request body exceeds "+
			strconv.Itoa(RequestBodyLimitBytes)+" bytes.")
	}
	if strings.TrimSpace(string(raw)) == "" {
		return map[string]any{}, nil
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, Fail(CodeValidationFailed, "Request body is not valid JSON.")
	}
	object, ok := parsed.(map[string]any)
	if !ok {
		return nil, Fail(CodeValidationFailed, "Request body must be a JSON object.")
	}
	return object, nil
}

// RequireString reads a required non-empty string field.
func RequireString(body map[string]any, name string) (string, error) {
	value, ok := body[name].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "", FailWith(CodeValidationFailed,
			name+" is required and must be a non-empty string.", map[string]any{"field": name})
	}
	return value, nil
}

// OptionalString reads an optional string field; ok is false when absent or of
// another type, which is exactly how the Worker's own helper behaves.
func OptionalString(body map[string]any, name string) (string, bool) {
	value, ok := body[name].(string)
	return value, ok
}

// OptionalBool reads an optional boolean field.
func OptionalBool(body map[string]any, name string) (bool, bool) {
	value, ok := body[name].(bool)
	return value, ok
}

// OptionalArray reads an optional array field, copied so handlers cannot alias
// the parsed body.
func OptionalArray(body map[string]any, name string) ([]any, bool) {
	value, ok := body[name].([]any)
	if !ok {
		return nil, false
	}
	out := make([]any, len(value))
	copy(out, value)
	return out, true
}

// AssertChars enforces a character cap and reports it in the error.
func AssertChars(value string, cap int, label string) error {
	if utf8.RuneCountInString(value) > cap {
		return FailWith(CodeValidationFailed,
			label+" exceeds "+strconv.Itoa(cap)+" characters.", map[string]any{"limit_chars": cap})
	}
	return nil
}

// AssertBytes enforces a byte cap and reports it in the error.
func AssertBytes(value string, cap int, label string) error {
	if UTF8Len(value) > cap {
		return FailWith(CodeValidationFailed,
			label+" exceeds "+strconv.Itoa(cap)+" bytes.", map[string]any{"limit_bytes": cap})
	}
	return nil
}

// IntParam reads a bounded integer query parameter with a default.
func IntParam(r *http.Request, name string, fallback, minimum, maximum int) (int, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, FailWith(CodeValidationFailed, name+" must be an integer.", map[string]any{"field": name})
	}
	if value < minimum || value > maximum {
		return 0, FailWith(CodeValidationFailed,
			name+" must be between "+strconv.Itoa(minimum)+" and "+strconv.Itoa(maximum)+".",
			map[string]any{"field": name, "min": minimum, "max": maximum})
	}
	return value, nil
}

// leadingInt64 reads the integer prefix of a string, which is how the Worker's
// parseInt treats a since_seq value such as "12abc".
func leadingInt64(raw string) (int64, bool) {
	trimmed := strings.TrimSpace(raw)
	end := 0
	if end < len(trimmed) && (trimmed[end] == '-' || trimmed[end] == '+') {
		end++
	}
	start := end
	for end < len(trimmed) && trimmed[end] >= '0' && trimmed[end] <= '9' {
		end++
	}
	if end == start {
		return 0, false
	}
	value, err := strconv.ParseInt(trimmed[:end], 10, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// OkBody is the { ok: true } envelope routes answer with, plus any extra keys.
func OkBody(extra map[string]any) map[string]any {
	body := map[string]any{"ok": true}
	for key, value := range extra {
		body[key] = value
	}
	return body
}
