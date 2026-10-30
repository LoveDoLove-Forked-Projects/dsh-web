package hub

// The account-service admin API. A team admin invites by email; the hub resolves
// that email to the account-service user id the assertion will carry at sign-in,
// and writes it onto the member row. The invitee's first assertion sign-in then
// finds a member instead of the 409 NOT_LINKED an unbound row would produce.

import (
	"strconv"
	"strings"
)

// accountLookupPath is the account-service endpoint that resolves an email to
// the user id its assertions carry as sub.
const accountLookupPath = "/v1/admin/users/lookup"

// AccountAdminSettings is the account-service admin API this hub calls.
type AccountAdminSettings struct {
	BaseURL string
	Token   string
}

// accountAdminSettings reads the invite's settings and names every absent one,
// so a half-configured hub answers NOT_CONFIGURED with the setting to fix.
func (h *Hub) accountAdminSettings() (*AccountAdminSettings, error) {
	missing := missingInviteSettings(h.config.AccountServiceBase, h.config.AccountAdminToken)
	if len(missing) > 0 {
		return nil, Fail(CodeNotConfigured, "The account service admin API is not configured on this hub: "+
			strings.Join(missing, " and ")+" must be set.")
	}
	return &AccountAdminSettings{
		BaseURL: strings.TrimSuffix(h.config.AccountServiceBase, "/"),
		Token:   h.config.AccountAdminToken,
	}, nil
}

// accountUser is the account one email resolves to.
type accountUser struct {
	UserID string
}

// LookupAccountByEmail resolves an email through the account-service admin API.
// 404 is "no such account" (nil, nil); every other unexpected answer is
// ACCOUNT_UNAVAILABLE carrying only the upstream status, never its body.
func (h *Hub) LookupAccountByEmail(email string) (*accountUser, error) {
	settings, err := h.accountAdminSettings()
	if err != nil {
		return nil, err
	}
	payload, err := marshalJSON(map[string]any{"email": email})
	if err != nil {
		return nil, err
	}
	response, err := h.callOutbound("POST", settings.BaseURL+accountLookupPath, map[string]string{
		"accept":        "application/json",
		"content-type":  "application/json",
		"x-admin-token": settings.Token,
	}, payload)
	if err != nil {
		return nil, Fail(CodeAccountUnavailable,
			"The account service could not be reached to resolve this email.")
	}
	if response.Status == 404 {
		return nil, nil
	}
	if response.Status != 200 {
		return nil, FailWith(CodeAccountUnavailable,
			"The account service answered the email lookup with "+strconv.Itoa(response.Status)+".",
			map[string]any{"account_status": response.Status})
	}
	body, ok := response.Body.(map[string]any)
	if !ok {
		return nil, Fail(CodeAccountUnavailable,
			"The account service answered the email lookup with no JSON object.")
	}
	userID, _ := body["user_id"].(string)
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, Fail(CodeAccountUnavailable,
			"The account service answered the email lookup without a user id.")
	}
	return &accountUser{UserID: userID}, nil
}

// maskEmail keeps an audit line searchable without writing an address into a log
// that outlives the request: the local part collapses to its first character.
func maskEmail(email string) string {
	at := strings.LastIndex(email, "@")
	if at <= 0 {
		return "***"
	}
	local := []rune(email[:at])
	if len(local) == 0 {
		return "***" + email[at:]
	}
	return string(local[0]) + "***" + email[at:]
}
