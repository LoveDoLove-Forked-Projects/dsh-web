package hub

// A member row on the wire names the account it is bound to, so a client can
// verify "this row is me" instead of assuming the account it signed in with owns
// the row it was handed.

import (
	"net/http"
	"testing"
)

// memberWireKeys is the complete member object. Anything else on the wire would
// be an account-service attribute (email, display name, token) that must never
// travel with the binding.
var memberWireKeys = map[string]bool{
	"id": true, "team_id": true, "github_user_id": true, "github_username": true,
	"display_name": true, "avatar_url": true, "account_user_id": true, "role": true,
	"status": true, "created_at": true, "updated_at": true,
}

func assertExposedKeys(t *testing.T, surface string, row map[string]any) {
	t.Helper()
	for name := range row {
		if !memberWireKeys[name] {
			t.Fatalf("%s carries an undocumented member field %q", surface, name)
		}
	}
}

// rosterRows indexes a member list response by member id.
func rosterRows(t *testing.T, result apiResult) map[string]map[string]any {
	t.Helper()
	if result.status != http.StatusOK {
		t.Fatalf("member list: %d %s", result.status, result.text)
	}
	entries, _ := result.body["members"].([]any)
	rows := make(map[string]map[string]any, len(entries))
	for _, entry := range entries {
		row, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("a member row is not an object: %s", result.text)
		}
		assertExposedKeys(t, "the member list", row)
		rows[stringField(row, "id")] = row
	}
	return rows
}

func TestMemberRowsExposeTheAccountBinding(t *testing.T) {
	key := newAccountKey(t)
	server := startTestHub(t, startOptions{jwks: accountJWKS(key)})
	// The bootstrap admin is named by an email, so its row is bound from the first
	// write: the address resolves to the account whose assertion signs in.
	team := server.seedTeam()
	adminID := stringField(team.admin.member, "id")

	roster := rosterRows(t, server.api("GET", "/api/v1/teams/"+team.teamID+"/members",
		apiOptions{token: team.admin.accessToken}))
	if value := stringField(roster[adminID], "account_user_id"); value != accountSubject {
		t.Fatalf("the bootstrap admin reports %q, want %q", value, accountSubject)
	}

	// A member carried by a GitHub identity alone carries no binding, and the wire
	// says so with an explicit null rather than an absent field.
	late := server.unboundMemberAndLogin(team.teamID, "hubot")
	lateID := stringField(late.member, "id")
	unbound := rosterRows(t, server.api("GET", "/api/v1/teams/"+team.teamID+"/members",
		apiOptions{token: team.admin.accessToken}))
	if raw, present := unbound[lateID]["account_user_id"]; !present || raw != nil {
		t.Fatalf("an unbound member is not an explicit null: %v (present %t)", raw, present)
	}
	lateSub := "acct_late_joiner"
	linked := server.api("POST", "/auth/account/link", apiOptions{
		token: late.accessToken,
		body:  map[string]any{"assertion": key.assertion(t, assertionOptions{sub: lateSub})},
	})
	if linked.status != http.StatusOK {
		t.Fatalf("account link: %d %s", linked.status, linked.text)
	}

	// An invite names an email; the account service resolves it and the row lands
	// bound, which is what lets the invitee sign in at all.
	inviteeEmail := "hubot@example.test"
	inviteeSub := "acct_invitee_hubot"
	server.fake.addAccountUser(inviteeEmail, inviteeSub)
	invited := server.api("POST", "/api/v1/teams/"+team.teamID+"/members/invite", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"email": inviteeEmail, "role": "member"},
	})
	if invited.status != http.StatusCreated {
		t.Fatalf("invite: %d %s", invited.status, invited.text)
	}
	invitedRow, _ := invited.body["member"].(map[string]any)
	assertExposedKeys(t, "the invite response", invitedRow)
	if value := stringField(invitedRow, "account_user_id"); value != inviteeSub {
		t.Fatalf("the invited row reports %q, want %q", value, inviteeSub)
	}
	if stringField(invitedRow, "display_name") != "hubot" {
		t.Fatalf("the invited row is not named after the address: %s", invited.text)
	}
	if stringField(invitedRow, "status") != "active" {
		t.Fatalf("an invited row is not active: %s", invited.text)
	}

	roster = rosterRows(t, server.api("GET", "/api/v1/teams/"+team.teamID+"/members",
		apiOptions{token: team.admin.accessToken}))
	if len(roster) != 3 {
		t.Fatalf("roster size %d", len(roster))
	}
	if value := stringField(roster[lateID], "account_user_id"); value != lateSub {
		t.Fatalf("the linked row reports %q, want %q", value, lateSub)
	}
	invitedID := stringField(invitedRow, "id")
	if value := stringField(roster[invitedID], "account_user_id"); value != inviteeSub {
		t.Fatalf("the invited row reports %q, want %q", value, inviteeSub)
	}

	me := server.api("GET", "/api/v1/me", apiOptions{token: team.admin.accessToken})
	if me.status != http.StatusOK {
		t.Fatalf("me: %d %s", me.status, me.text)
	}
	meRow, _ := me.body["member"].(map[string]any)
	if stringField(meRow, "account_user_id") != accountSubject {
		t.Fatalf("me reports %v: %s", meRow["account_user_id"], me.text)
	}
	assertExposedKeys(t, "me", meRow)

	// Signing in with an assertion answers the member the assertion resolved to,
	// and the invited account reaches its own row.
	signedIn := server.signInAssertion(t, key.assertion(t, assertionOptions{sub: inviteeSub}))
	if signedIn.status != http.StatusOK {
		t.Fatalf("account sign-in: %d %s", signedIn.status, signedIn.text)
	}
	signInRow, _ := signedIn.body["member"].(map[string]any)
	if stringField(signInRow, "id") != invitedID {
		t.Fatalf("the invited account signed in as %v: %s", signInRow["id"], signedIn.text)
	}
	if stringField(signInRow, "account_user_id") != inviteeSub {
		t.Fatalf("the sign-in member reports %v: %s", signInRow["account_user_id"], signedIn.text)
	}
	assertExposedKeys(t, "the account sign-in", signInRow)

	lateSignIn := server.signInAssertion(t, key.assertion(t, assertionOptions{sub: lateSub}))
	if lateSignIn.status != http.StatusOK {
		t.Fatalf("the linked account signs in: %d %s", lateSignIn.status, lateSignIn.text)
	}
	lateRow, _ := lateSignIn.body["member"].(map[string]any)
	if stringField(lateRow, "id") != lateID {
		t.Fatalf("the linked account signed in as %v: %s", lateRow["id"], lateSignIn.text)
	}

	adminSignIn := server.signInAssertion(t, key.assertion(t, assertionOptions{}))
	if adminSignIn.status != http.StatusOK {
		t.Fatalf("admin sign-in: %d %s", adminSignIn.status, adminSignIn.text)
	}
	adminRow, _ := adminSignIn.body["member"].(map[string]any)
	if stringField(adminRow, "id") != adminID {
		t.Fatalf("the admin signed in as %v: %s", adminRow["id"], adminSignIn.text)
	}
	if stringField(adminRow, "role") != "admin" {
		t.Fatalf("the admin signed in as %v: %s", adminRow["role"], adminSignIn.text)
	}
}
