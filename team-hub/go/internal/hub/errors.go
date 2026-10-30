package hub

// The unified error envelope of PROTOCOL.md section 9: every non-2xx response is
// { error: { code, message, details } }. The code picks the status, so handlers
// never choose one by hand.

// Code is one UPPER_SNAKE error code from the protocol's section 9 table.
type Code string

const (
	CodeUnauthorized        Code = "UNAUTHORIZED"
	CodeForbidden           Code = "FORBIDDEN"
	CodeNotFound            Code = "NOT_FOUND"
	CodeConflict            Code = "CONFLICT"
	CodeValidationFailed    Code = "VALIDATION_FAILED"
	CodeUnsupportedProtocol Code = "UNSUPPORTED_PROTOCOL_VERSION"
	CodeInvalidState        Code = "INVALID_STATE_TRANSITION"
	CodeLeaseExpired        Code = "LEASE_EXPIRED"
	CodeLeaseHeldByOther    Code = "LEASE_HELD_BY_OTHER"
	CodeHostOffline         Code = "HOST_OFFLINE"
	CodeQuestionAnswered    Code = "QUESTION_ALREADY_ANSWERED"
	CodeQuestionNotPending  Code = "QUESTION_NOT_PENDING"
	CodeHostMismatch        Code = "HOST_MISMATCH"
	CodePayloadTooLarge     Code = "PAYLOAD_TOO_LARGE"
	CodeRateLimited         Code = "RATE_LIMITED"
	CodeInternal            Code = "INTERNAL_ERROR"
	CodeInvalidOAuthCode    Code = "INVALID_OAUTH_CODE"
	CodeInvalidPKCE         Code = "INVALID_PKCE"
	CodeInvalidRefreshToken Code = "INVALID_REFRESH_TOKEN"
	CodeUserNotFound        Code = "USER_NOT_FOUND"
	CodeAlreadyMember       Code = "ALREADY_MEMBER"
	CodeMemberNotFound      Code = "MEMBER_NOT_FOUND"
	CodeHostNotFound        Code = "HOST_NOT_FOUND"
	CodeIssueNotFound       Code = "ISSUE_NOT_FOUND"
	CodeNotConfigured       Code = "NOT_CONFIGURED"
	CodeNotLinked           Code = "NOT_LINKED"
	CodeIdentityTaken       Code = "IDENTITY_TAKEN"
	CodeAccountUnavailable  Code = "ACCOUNT_UNAVAILABLE"
)

var statusByCode = map[Code]int{
	CodeUnauthorized:        401,
	CodeForbidden:           403,
	CodeNotFound:            404,
	CodeConflict:            409,
	CodeValidationFailed:    400,
	CodeUnsupportedProtocol: 400,
	CodeInvalidState:        422,
	CodeLeaseExpired:        412,
	CodeLeaseHeldByOther:    409,
	CodeHostOffline:         400,
	CodeQuestionAnswered:    409,
	CodeQuestionNotPending:  409,
	CodeHostMismatch:        403,
	CodePayloadTooLarge:     413,
	CodeRateLimited:         429,
	CodeInternal:            500,
	CodeInvalidOAuthCode:    400,
	CodeInvalidPKCE:         400,
	CodeInvalidRefreshToken: 401,
	CodeUserNotFound:        404,
	CodeAlreadyMember:       409,
	CodeMemberNotFound:      404,
	CodeHostNotFound:        404,
	CodeIssueNotFound:       404,
	CodeNotConfigured:       503,
	CodeNotLinked:           409,
	CodeIdentityTaken:       409,
	CodeAccountUnavailable:  502,
}

// Error is a protocol error carrying the HTTP status its code row assigns.
type Error struct {
	Code    Code
	Status  int
	Message string
	Details map[string]any
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// Fail builds an Error with no details.
func Fail(code Code, message string) *Error {
	return &Error{Code: code, Status: statusByCode[code], Message: message, Details: map[string]any{}}
}

// FailWith builds an Error carrying the protocol's details object.
func FailWith(code Code, message string, details map[string]any) *Error {
	if details == nil {
		details = map[string]any{}
	}
	return &Error{Code: code, Status: statusByCode[code], Message: message, Details: details}
}

func errorEnvelope(err *Error) map[string]any {
	details := err.Details
	if details == nil {
		details = map[string]any{}
	}
	return map[string]any{
		"error": map[string]any{
			"code":    string(err.Code),
			"message": err.Message,
			"details": details,
		},
	}
}
