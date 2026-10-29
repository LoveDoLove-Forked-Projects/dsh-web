-- Additions required by behaviour PROTOCOL.md mandates but declares no storage
-- for. Each block names the section or supplement that forces it; README.md
-- lists all of them as deviations for review.

-- Section 2: refresh tokens are stored in D1 and rotate on every refresh, and
-- POST /auth/revoke must invalidate the submitted token and its session.
CREATE TABLE refresh_tokens (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX idx_refresh_tokens_member ON refresh_tokens(member_id);
CREATE INDEX idx_refresh_tokens_session ON refresh_tokens(session_id);

-- Supplement A1.6: the client supplies state, redirect_uri and the PKCE
-- challenge on GET /auth/github/authorize, but GitHub only echoes state back,
-- so the pending authorization is held here until the callback arrives.
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  client TEXT NOT NULL CHECK(client IN ('web', 'ios')),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Section 11: per-IP, per-member and per-host request quotas need a counter
-- that survives Worker isolates, so it lives in D1 next to the rest of state.
CREATE TABLE rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

-- Supplement A1.5: mention resolution is materialised at comment-write time so
-- the inbox can answer "mentions I have not read yet" without re-parsing every
-- comment body. SQLite cannot put COALESCE in a table constraint, so the same
-- uniqueness the supplement specifies is enforced by an expression index.
CREATE TABLE comment_mentions (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('member', 'agent')),
  target_member_id TEXT REFERENCES members(id),
  target_agent_id TEXT REFERENCES agents(id),
  read_at INTEGER
);
CREATE UNIQUE INDEX idx_comment_mentions_unique
  ON comment_mentions(comment_id, target_type, COALESCE(target_member_id, target_agent_id));
CREATE INDEX idx_comment_mentions_member ON comment_mentions(target_member_id, read_at);

-- Section 8.2: rejection stores rework instructions on the issue, and section
-- 5 settlement-failure path stores the failure text; the section 3 DDL has a
-- column for neither.
ALTER TABLE issues ADD COLUMN rework_instructions TEXT;
ALTER TABLE issues ADD COLUMN failure_error TEXT;
