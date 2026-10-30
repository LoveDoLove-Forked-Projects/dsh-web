package hub

// Typed prefixed identifiers (PROTOCOL.md section 3): every row id is
// <prefix>_<26 base32 characters>. The 26 characters are a ULID: a 48-bit
// millisecond timestamp followed by 80 random bits, so ids sort by creation
// time and never collide inside one millisecond.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
)

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func encodeTime(timestamp int64) string {
	out := make([]byte, 10)
	rest := timestamp
	for index := 9; index >= 0; index-- {
		out[index] = crockford[rest%32]
		rest /= 32
	}
	return string(out)
}

func randomCrockford(count int) string {
	buffer := make([]byte, count)
	if _, err := rand.Read(buffer); err != nil {
		panic("team-hub: crypto/rand unavailable: " + err.Error())
	}
	out := make([]byte, count)
	for index, value := range buffer {
		out[index] = crockford[int(value)%32]
	}
	return string(out)
}

// NewID mints one identifier for the given entity prefix.
func NewID(prefix string, now int64) string {
	return prefix + "_" + encodeTime(now) + randomCrockford(16)
}

// RandomHex returns a lowercase hex string of the requested byte length.
func RandomHex(bytes int) string {
	buffer := make([]byte, bytes)
	if _, err := rand.Read(buffer); err != nil {
		panic("team-hub: crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(buffer)
}

// SHA256Hex is the hash a token is stored under; only hashes ever land in rows.
func SHA256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

// NewUUID is the identifier the protocol uses for execution attempts and leases.
func NewUUID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic("team-hub: crypto/rand unavailable: " + err.Error())
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buffer[0:4], buffer[4:6], buffer[6:8], buffer[8:10], buffer[10:16])
}
