package hub

// The p8 key arrives in the shape the deployment hands it over, and the hub has
// to sign a provider token from all of them. These tests go through the signing
// path rather than pemToDER alone, so a wrongly decoded key cannot pass as long
// as it still yields bytes.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"math/big"
	"strings"
	"testing"
)

// mintAPNsKey returns one throwaway P-256 key in the two shapes a deployment
// produces: the PEM document and the bare base64 body of the same PKCS#8 DER.
func mintAPNsKey(t *testing.T) (pemText, bareBase64 string, public *ecdsa.PublicKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate APNs key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal APNs key: %v", err)
	}
	document := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	return string(document), base64.StdEncoding.EncodeToString(der), &key.PublicKey
}

// signAndVerify signs a provider token with the key text and checks the ES256
// signature against the public half, so the test proves a usable signer.
func signAndVerify(t *testing.T, keyText string, public *ecdsa.PublicKey) {
	t.Helper()
	provider := &Hub{config: Config{APNS: &APNSSettings{
		KeyID: "key-id", TeamID: "team-id", BundleID: "com.example.hub", PrivateKeyP8: keyText,
	}}}
	token, err := provider.signProviderToken(1_700_000_000_000)
	if err != nil {
		t.Fatalf("sign provider token: %v", err)
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("provider token is not a JWS: %q", token)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode provider token signature: %v", err)
	}
	if len(signature) != 64 {
		t.Fatalf("provider token signature is %d bytes, want 64", len(signature))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	rValue := new(big.Int).SetBytes(signature[:32])
	sValue := new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(public, digest[:], rValue, sValue) {
		t.Fatalf("provider token signature does not verify")
	}
}

func TestPEMToDERNormalizesEscapedNewlines(t *testing.T) {
	pemText, _, public := mintAPNsKey(t)
	escaped := strings.ReplaceAll(pemText, "\n", "\\n")
	if strings.Contains(escaped, "\n") {
		t.Fatalf("the escaped key still holds a real newline")
	}
	signAndVerify(t, escaped, public)
}

func TestPEMToDERAcceptsRealNewlines(t *testing.T) {
	pemText, _, public := mintAPNsKey(t)
	signAndVerify(t, pemText, public)
}

func TestPEMToDERAcceptsBareBase64Body(t *testing.T) {
	_, bareBase64, public := mintAPNsKey(t)
	signAndVerify(t, bareBase64, public)
}

func TestPEMToDERRejectsBrokenMaterial(t *testing.T) {
	_, _, _ = mintAPNsKey(t)
	broken := map[string]string{
		"empty":        "",
		"plain text":   "not a key",
		"base64 junk":  "AAAA",
		"truncated":    "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
		"other record": "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
	}
	for name, keyText := range broken {
		provider := &Hub{config: Config{APNS: &APNSSettings{
			KeyID: "key-id", TeamID: "team-id", BundleID: "com.example.hub", PrivateKeyP8: keyText,
		}}}
		token, err := provider.signProviderToken(1_700_000_000_000)
		if err == nil {
			t.Fatalf("%s: a broken key signed %q", name, token)
		}
		var failure *Error
		if !errors.As(err, &failure) || failure.Code != CodeNotConfigured {
			t.Fatalf("%s: error is %v, want a NOT_CONFIGURED failure", name, err)
		}
		if failure.Message == "" {
			t.Fatalf("%s: the failure carries no message", name)
		}
	}
}
