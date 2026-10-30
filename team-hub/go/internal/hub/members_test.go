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

func TestMemberRowsExposeTheAccountBinding(t *testing.T) {
	server, key, team := boundAccountFixture(t)

	invited := server.api("POST", "/api/v1/teams/"+team.teamID+"/members/invite", apiOptions{
		token: team.admin.accessToken, body: map[string]any{"github_username": "hubot", "role": "member"},
	})
	if invited.status != http.StatusCreated {
		t.Fatalf("invite: %d %s", invited.status, invited.text)
	}
	invitedRow, _ := invited.body["member"].(map[string]any)
	if raw, present := invitedRow["account_user_id"]; !present || raw != nil {
		t.Fatalf("an invited member is not an explicit null: %v (present %t) %s", raw, present, invited.text)
	}
	unbound := server.login("hubot")
	if raw, present := unbound.member["account_user_id"]; !present || raw != nil {
		t.Fatalf("an unlinked session reports %v (present %t)", raw, present)
	}

	roster := server.api("GET", "/api/v1/teams/"+team.teamID+"/members", apiOptions{token: team.admin.accessToken})
	if roster.status != http.StatusOK {
		t.Fatalf("member list: %d %s", roster.status, roster.text)
	}
	entries, _ := roster.body["members"].([]any)
	if len(entries) != 2 {
		t.Fatalf("roster size %d: %s", len(entries), roster.text)
	}
	rows := map[string]map[string]any{}
	for _, entry := range entries {
		row, ok := entry.(map[string]any)
		if !ok {
			t.Fatalf("a member row is not an object: %s", roster.text)
		}
		assertExposedKeys(t, "the member list", row)
		rows[stringField(row, "id")] = row
	}
	boundRow := rows[stringField(team.admin.member, "id")]
	if boundRow == nil {
		t.Fatalf("the roster is missing the bound admin: %s", roster.text)
	}
	if value := stringField(boundRow, "account_user_id"); value != accountSubject {
		t.Fatalf("the bound row reports %q, want %q", value, accountSubject)
	}
	if raw, present := rows[stringField(unbound.member, "id")]["account_user_id"]; !present || raw != nil {
		t.Fatalf("the unbound row reports %v (present %t)", raw, present)
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

	// Signing in with an assertion answers the member the assertion resolved to.
	signedIn := server.signInAssertion(t, key.assertion(t, assertionOptions{}))
	if signedIn.status != http.StatusOK {
		t.Fatalf("account sign-in: %d %s", signedIn.status, signedIn.text)
	}
	signInRow, _ := signedIn.body["member"].(map[string]any)
	if stringField(signInRow, "account_user_id") != accountSubject {
		t.Fatalf("the sign-in member reports %v: %s", signInRow["account_user_id"], signedIn.text)
	}
	assertExposedKeys(t, "the account sign-in", signInRow)
}
