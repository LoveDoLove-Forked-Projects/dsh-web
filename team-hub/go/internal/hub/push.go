package hub

// APNs delivery (section 10) and the alert texts the protocol names.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strconv"
	"strings"
)

// APNSJWTTTLMS is section 13's provider token cache lifetime.
const APNSJWTTTLMS = 3_000_000

// PushNotification is one alert the hub wants delivered.
type PushNotification struct {
	TeamID     string
	IssueID    string
	EventType  string
	Body       string
	QuestionID string
}

func assignedAlert(issueNumber int64, title string) string {
	return "You were assigned to issue #" + strconv.FormatInt(issueNumber, 10) + ": " + title
}

func questionAskedAlert(agentName string, issueNumber int64, questionText string) string {
	return "Agent " + agentName + " asked a question on #" + strconv.FormatInt(issueNumber, 10) + ": " + questionText
}

func reviewRequestedAlert(issueNumber int64, title string) string {
	return "Issue #" + strconv.FormatInt(issueNumber, 10) + " is ready for review: " + title
}

func mentionedAlert(authorName string, issueNumber int64) string {
	return authorName + " mentioned you on #" + strconv.FormatInt(issueNumber, 10)
}

// pemToDER reads the p8 key material in every shape a deployment produces: a
// PEM document with real newlines, the same document with literal backslash-n
// (systemd's EnvironmentFile does not expand them), and the bare base64 body of
// the DER key. The account service reads its copy the same way.
func pemToDER(pemText string) ([]byte, error) {
	normalized := strings.ReplaceAll(pemText, "\\n", "\n")
	if block, _ := pem.Decode([]byte(normalized)); block != nil {
		if len(block.Bytes) == 0 {
			return nil, Fail(CodeNotConfigured, "APNS_PRIVATE_KEY_P8 is empty.")
		}
		return block.Bytes, nil
	}
	stripped := strings.NewReplacer(
		"-----BEGIN PRIVATE KEY-----", "",
		"-----END PRIVATE KEY-----", "",
	).Replace(normalized)
	stripped = strings.Join(strings.Fields(stripped), "")
	der, err := base64.StdEncoding.DecodeString(stripped)
	if err != nil {
		return nil, Fail(CodeNotConfigured, "APNS_PRIVATE_KEY_P8 is not a PEM document.")
	}
	if len(der) == 0 {
		return nil, Fail(CodeNotConfigured, "APNS_PRIVATE_KEY_P8 is empty.")
	}
	return der, nil
}

func base64URLBytes(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

// signProviderToken signs a fresh ES256 provider token (section 10).
func (h *Hub) signProviderToken(now int64) (string, error) {
	settings := h.config.APNS
	if settings == nil {
		return "", Fail(CodeNotConfigured, "APNs is not configured on this hub.")
	}
	der, err := pemToDER(settings.PrivateKeyP8)
	if err != nil {
		return "", err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return "", Fail(CodeNotConfigured, "APNS_PRIVATE_KEY_P8 is not a PKCS8 private key.")
	}
	privateKey, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || privateKey.Curve != elliptic.P256() {
		return "", Fail(CodeNotConfigured, "APNS_PRIVATE_KEY_P8 is not a P-256 private key.")
	}
	header, err := json.Marshal(map[string]any{"alg": "ES256", "kid": settings.KeyID, "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{"iss": settings.TeamID, "iat": now / 1000})
	if err != nil {
		return "", err
	}
	signingInput := base64URLBytes(header) + "." + base64URLBytes(claims)
	digest := sha256.Sum256([]byte(signingInput))
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, digest[:])
	if err != nil {
		return "", err
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	return signingInput + "." + base64URLBytes(signature), nil
}

// providerToken is the cached provider JWT, re-signed once the window elapses.
func (h *Hub) providerToken(now int64) (string, error) {
	settings := h.config.APNS
	if settings == nil {
		return "", Fail(CodeNotConfigured, "APNs is not configured on this hub.")
	}
	h.apnsMu.Lock()
	defer h.apnsMu.Unlock()
	if h.apnsJWT != "" && h.apnsKeyID == settings.KeyID && h.apnsTeamID == settings.TeamID &&
		now-h.apnsIssuedAt < APNSJWTTTLMS {
		return h.apnsJWT, nil
	}
	jwt, err := h.signProviderToken(now)
	if err != nil {
		return "", err
	}
	h.apnsJWT = jwt
	h.apnsIssuedAt = now
	h.apnsKeyID = settings.KeyID
	h.apnsTeamID = settings.TeamID
	return jwt, nil
}

func apnsBody(notification PushNotification) map[string]any {
	body := map[string]any{
		"aps": map[string]any{
			"alert":    map[string]any{"title": "Team Collaboration", "body": notification.Body},
			"sound":    "default",
			"badge":    1,
			"category": "TEAM_COLLAB",
		},
		"team_id":    notification.TeamID,
		"issue_id":   notification.IssueID,
		"event_type": notification.EventType,
	}
	if notification.QuestionID != "" {
		body["question_id"] = notification.QuestionID
	}
	return body
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// sendPush delivers to every device of the given members. A device APNs reports
// as 410 Unregistered is deleted, as section 10 requires. A hub with no APNs
// credential skips delivery and says so in the log; the API call it belongs to
// still succeeds, because the notification is not the reason for the call.
func (h *Hub) sendPush(recipients []string, notification PushNotification, now int64) error {
	unique := uniqueStrings(recipients)
	if len(unique) == 0 {
		return nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?, ", len(unique)), ", ")
	args := make([]any, 0, len(unique))
	for _, memberID := range unique {
		args = append(args, memberID)
	}
	tokens, err := Collect(h.db, "SELECT "+pushTokenColumns+" FROM push_tokens WHERE member_id IN ("+marks+")",
		scanPushToken, args...)
	if err != nil {
		return err
	}
	if len(tokens) == 0 {
		return nil
	}
	if h.config.APNS == nil {
		h.logf("[push] APNs is not configured; skipped %d notification(s)", len(tokens))
		return nil
	}
	jwt, err := h.providerToken(now)
	if err != nil {
		return err
	}
	body, err := json.Marshal(apnsBody(notification))
	if err != nil {
		return err
	}
	stale := make([]string, 0)
	for _, token := range tokens {
		base := apnsProductionBase
		if token.Environment != "production" {
			base = apnsSandboxBase
		}
		response, err := h.callOutbound("POST", base+"/3/device/"+token.DeviceToken, map[string]string{
			"authorization":  "bearer " + jwt,
			"apns-topic":     token.BundleID,
			"apns-push-type": "alert",
			"apns-priority":  "10",
			"content-type":   "application/json",
		}, string(body))
		if err != nil {
			continue
		}
		if response.Status == 410 {
			stale = append(stale, token.ID)
		}
	}
	if len(stale) > 0 {
		marks := strings.TrimSuffix(strings.Repeat("?, ", len(stale)), ", ")
		args := make([]any, 0, len(stale))
		for _, id := range stale {
			args = append(args, id)
		}
		if _, err := h.db.Exec("DELETE FROM push_tokens WHERE id IN ("+marks+")", args...); err != nil {
			return err
		}
	}
	return nil
}

// RegisterPushToken stores one device token; registering the same device twice
// updates the one row.
func (h *Hub) RegisterPushToken(memberID, platform, deviceToken, bundleID, environment string, now int64) error {
	if h.config.APNS == nil {
		return Fail(CodeNotConfigured,
			"APNs is not configured on this hub (APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_PRIVATE_KEY_P8).")
	}
	_, err := h.db.Exec(
		`INSERT INTO push_tokens (id, member_id, platform, device_token, bundle_id, environment,
		 created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(member_id, device_token) DO UPDATE SET platform = excluded.platform,
		 bundle_id = excluded.bundle_id, environment = excluded.environment,
		 updated_at = excluded.updated_at`,
		NewID("ptok", now), memberID, platform, deviceToken, bundleID, environment, now, now)
	return err
}

// DeletePushToken removes the device token of one member.
func (h *Hub) DeletePushToken(memberID, deviceToken string) error {
	_, err := h.db.Exec("DELETE FROM push_tokens WHERE member_id = ? AND device_token = ?", memberID, deviceToken)
	return err
}
