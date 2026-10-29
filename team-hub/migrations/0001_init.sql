-- team-hub initial schema: PROTOCOL.md section 3, verbatim.
-- Timestamps are UTC milliseconds, identifiers are typed prefix strings.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  github_username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK(status IN ('invited', 'active', 'suspended')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, github_user_id),
  UNIQUE(team_id, github_username)
);
CREATE INDEX idx_members_team_status ON members(team_id, status);

CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  client_version TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('online', 'offline', 'revoked')),
  last_heartbeat_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_hosts_team_status ON hosts(team_id, status);
CREATE INDEX idx_hosts_token_hash ON hosts(token_hash);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  preset_id TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK(status IN ('idle', 'busy', 'offline')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, name)
);
CREATE INDEX idx_agents_team_host ON agents(team_id, host_id);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('todo', 'assigned', 'waiting_host', 'running', 'in_review', 'done', 'canceled', 'failed')),
  creator_member_id TEXT NOT NULL REFERENCES members(id),
  assignee_type TEXT CHECK(assignee_type IN ('member', 'agent')),
  assignee_member_id TEXT REFERENCES members(id),
  assignee_agent_id TEXT REFERENCES agents(id),
  reviewer_member_id TEXT REFERENCES members(id),
  executing_host_id TEXT REFERENCES hosts(id),
  lease_token TEXT,
  lease_expires_at INTEGER,
  execution_attempt_id TEXT,
  execution_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, issue_number)
);
CREATE INDEX idx_issues_team_status ON issues(team_id, status);
CREATE INDEX idx_issues_assignee_agent ON issues(assignee_agent_id, status);
CREATE INDEX idx_issues_executing_host ON issues(executing_host_id, status);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK(author_type IN ('human', 'agent')),
  author_member_id TEXT REFERENCES members(id),
  author_agent_id TEXT REFERENCES agents(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_comments_issue_created ON comments(issue_id, created_at);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('member', 'agent', 'host', 'system')),
  actor_member_id TEXT REFERENCES members(id),
  actor_agent_id TEXT REFERENCES agents(id),
  actor_host_id TEXT REFERENCES hosts(id),
  activity_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_issue_created ON activity(issue_id, created_at);
CREATE INDEX idx_activity_team_created ON activity(team_id, created_at);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  options_json TEXT,
  multi_select INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending', 'answered', 'dismissed', 'expired')),
  first_responder_member_id TEXT REFERENCES members(id),
  answer_json TEXT,
  answered_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_questions_issue_status ON questions(issue_id, status);
CREATE INDEX idx_questions_team_status ON questions(team_id, status);

CREATE TABLE push_tokens (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK(platform IN ('ios', 'macos')),
  device_token TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('production', 'sandbox')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(member_id, device_token)
);
CREATE INDEX idx_push_tokens_member ON push_tokens(member_id);
