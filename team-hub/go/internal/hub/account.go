package hub

// Account-service sign-in.
//
// The account service signs a short-lived ES256 assertion whose sub is the
// account user id; this hub trusts nothing but that signature over the published
// JWKS. A verified assertion never creates a member: it only opens a session for
// a member that was already bound to that account. GitHub login stays as the
// transition entry point, so the binding is made from a GitHub session through
// POST /auth/account/link.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/json"
	"math/big"
	"strconv"
	"strings"
	"sync"
)

const jwksCacheTTLMS = 300_000

// jwksCache remembers the account service keys by kid, so a burst of sign-ins
// costs one fetch, not one fetch each.
type jwksCache struct {
	mu   sync.Mutex
	url  string
	at   int64
	keys map[string]*ecdsa.PublicKey
}

func (h *Hub) accountSettings() *AccountSettings { return h.config.Account }

func decodeSegment(segment string) (map[string]any, error) {
	decoded, err := fromBase64URL(segment)
	if err != nil {
		return nil, Fail(CodeUnauthorized, "The account assertion carries a segment that is not a JSON object.")
	}
	var parsed any
	if err := json.Unmarshal(decoded, &parsed); err != nil {
		return nil, Fail(CodeUnauthorized, "The account assertion carries a segment that is not a JSON object.")
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return nil, Fail(CodeUnauthorized, "The account assertion carries a segment that is not a JSON object.")
	}
	return record, nil
}

// fetchJWKS reads the published key set through the outbound seam.
func (h *Hub) fetchJWKS(url string) (map[string]*ecdsa.PublicKey, error) {
	response, err := h.callOutbound("GET", url, map[string]string{"accept": "application/json"}, "")
	if err != nil {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service JWKS could not be reached.", map[string]any{"jwks_url": url})
	}
	if response.Status != 200 {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service answered the JWKS request with "+strconv.Itoa(response.Status)+".",
			map[string]any{"jwks_status": response.Status})
	}
	document, ok := response.Body.(map[string]any)
	if !ok {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service JWKS publishes no key.", map[string]any{"jwks_url": url})
	}
	declared, ok := document["keys"].([]any)
	if !ok {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service JWKS publishes no key.", map[string]any{"jwks_url": url})
	}
	keys := make(map[string]*ecdsa.PublicKey)
	for _, entry := range declared {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		kid, _ := record["kid"].(string)
		kty, _ := record["kty"].(string)
		curve, _ := record["crv"].(string)
		x, _ := record["x"].(string)
		y, _ := record["y"].(string)
		if kid == "" || kty != "EC" || curve != "P-256" || x == "" || y == "" {
			continue
		}
		xb, xerr := fromBase64URL(x)
		yb, yerr := fromBase64URL(y)
		if xerr != nil || yerr != nil {
			continue
		}
		publicKey := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xb), Y: new(big.Int).SetBytes(yb)}
		if !publicKey.Curve.IsOnCurve(publicKey.X, publicKey.Y) {
			continue
		}
		keys[kid] = publicKey
	}
	if len(keys) == 0 {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service JWKS publishes no key.", map[string]any{"jwks_url": url})
	}
	return keys, nil
}

// verificationKey picks the published P-256 key the assertion names by kid.
func (h *Hub) verificationKey(config *AccountSettings, kid string, now int64) (*ecdsa.PublicKey, error) {
	h.jwks.mu.Lock()
	defer h.jwks.mu.Unlock()
	if h.jwks.keys != nil && h.jwks.url == config.JWKSURL && now-h.jwks.at < jwksCacheTTLMS {
		if key, ok := h.jwks.keys[kid]; ok {
			return key, nil
		}
	}
	keys, err := h.fetchJWKS(config.JWKSURL)
	if err != nil {
		return nil, err
	}
	h.jwks.url = config.JWKSURL
	h.jwks.at = now
	h.jwks.keys = keys
	key, ok := keys[kid]
	if !ok {
		return nil, FailWith(CodeUnauthorized,
			"The account assertion names a key id the account service does not publish.",
			map[string]any{"kid": kid})
	}
	return key, nil
}

// verifyAssertion checks the signature first, then iss, aud and exp.
func (h *Hub) verifyAssertion(config *AccountSettings, assertion string, now int64) (string, error) {
	parts := strings.Split(assertion, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", Fail(CodeUnauthorized, "The account assertion is not a three-part JWS.")
	}
	header, err := decodeSegment(parts[0])
	if err != nil {
		return "", err
	}
	if alg, _ := header["alg"].(string); alg != "ES256" {
		return "", Fail(CodeUnauthorized, "The account assertion is not signed with ES256.")
	}
	kid, _ := header["kid"].(string)
	if kid == "" {
		return "", Fail(CodeUnauthorized, "The account assertion names no key id.")
	}
	key, err := h.verificationKey(config, kid, now)
	if err != nil {
		return "", err
	}
	signature, err := fromBase64URL(parts[2])
	if err != nil || len(signature) != 64 {
		return "", FailWith(CodeUnauthorized,
			"The account assertion signature does not match the account service key.", map[string]any{"kid": kid})
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(key, digest[:], r, s) {
		return "", FailWith(CodeUnauthorized,
			"The account assertion signature does not match the account service key.", map[string]any{"kid": kid})
	}

	claims, err := decodeSegment(parts[1])
	if err != nil {
		return "", err
	}
	issuer, _ := claims["iss"].(string)
	if issuer != config.Issuer {
		return "", FailWith(CodeUnauthorized, "The account assertion was issued by another service.",
			map[string]any{"issuer": claims["iss"]})
	}
	audienceOK := false
	switch audience := claims["aud"].(type) {
	case string:
		audienceOK = audience == config.Audience
	case []any:
		for _, candidate := range audience {
			if text, ok := candidate.(string); ok && text == config.Audience {
				audienceOK = true
				break
			}
		}
	}
	if !audienceOK {
		return "", FailWith(CodeUnauthorized, "The account assertion is addressed to another audience.",
			map[string]any{"audience": claims["aud"]})
	}
	expires, ok := claims["exp"].(float64)
	if !ok || int64(expires*1000) <= now {
		return "", Fail(CodeUnauthorized, "The account assertion has expired.")
	}
	sub, _ := claims["sub"].(string)
	sub = strings.TrimSpace(sub)
	if sub == "" {
		return "", Fail(CodeUnauthorized, "The account assertion names no account user id.")
	}
	return sub, nil
}

// signInWithAccountAssertion opens a session for the member already bound to
// the asserted account. An unbound account is refused with NOT_LINKED instead of
// being turned into a member: membership is an admin decision.
func (h *Hub) signInWithAccountAssertion(assertion string, now int64) (*SessionTokens, *Member, error) {
	config := h.accountSettings()
	if config == nil {
		return nil, nil, Fail(CodeNotConfigured,
			"The account service settings (ACCOUNT_JWKS_URL, ACCOUNT_ISSUER, ACCOUNT_AUDIENCE) "+
				"are not configured on this hub.")
	}
	sub, err := h.verifyAssertion(config, assertion, now)
	if err != nil {
		return nil, nil, err
	}
	member, err := queryMember(h.db, "SELECT "+memberColumns+" FROM members WHERE account_user_id = ?", sub)
	if err != nil {
		return nil, nil, err
	}
	if member == nil {
		return nil, nil, FailWith(CodeNotLinked,
			"No member of this hub is bound to this account yet.", map[string]any{"sub": sub})
	}
	if member.Status != "active" {
		return nil, nil, Fail(CodeForbidden, "The membership bound to this account is not active.")
	}
	tokens, _, err := h.issueSession(member, now)
	if err != nil {
		return nil, nil, err
	}
	if _, err := h.db.Exec("UPDATE members SET updated_at = ? WHERE id = ?", now, member.ID); err != nil {
		return nil, nil, err
	}
	member.UpdatedAt = now
	return tokens, member, nil
}

// linkAccountIdentity binds the account to the member whose session carried the
// call. An account another member holds is IDENTITY_TAKEN, a member that already
// carries a different account is CONFLICT, and repeating the same binding is a
// no-op.
func (h *Hub) linkAccountIdentity(member *Member, assertion string, now int64) (*Member, error) {
	config := h.accountSettings()
	if config == nil {
		return nil, Fail(CodeNotConfigured,
			"The account service settings (ACCOUNT_JWKS_URL, ACCOUNT_ISSUER, ACCOUNT_AUDIENCE) "+
				"are not configured on this hub.")
	}
	sub, err := h.verifyAssertion(config, assertion, now)
	if err != nil {
		return nil, err
	}
	if member.AccountUserID != nil && *member.AccountUserID == sub {
		return member, nil
	}
	if member.AccountUserID != nil {
		return nil, FailWith(CodeConflict, "This member is already bound to another account.",
			map[string]any{"field": "account_user_id"})
	}
	var holderID string
	err = h.db.QueryRow("SELECT id FROM members WHERE account_user_id = ? AND id <> ?", sub, member.ID).Scan(&holderID)
	if err == nil {
		return nil, FailWith(CodeIdentityTaken, "This account is already bound to another member.",
			map[string]any{"member_id": holderID})
	}
	if err != nil && err != errNoRows {
		return nil, err
	}
	_, err = h.db.Exec("UPDATE members SET account_user_id = ?, updated_at = ? WHERE id = ?", sub, now, member.ID)
	if err != nil {
		// The partial unique index is the last word: two members racing for one
		// account end with the same answer the pre-check gives.
		return nil, Fail(CodeIdentityTaken, "This account is already bound to another member.")
	}
	updated := *member
	updated.AccountUserID = strPointer(sub)
	updated.UpdatedAt = now
	return &updated, nil
}
