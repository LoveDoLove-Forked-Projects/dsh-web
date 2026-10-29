# Team Hub Protocol Specification v1

Status: draft contract for M1 (team-hub), M2 (dsh-task-board-team), and M3 (Whale iOS App).

## 1. Overview and Division of Authority

The team collaboration system connects multiple DeepSeek Harness (DSH) Host nodes, native iOS mobile clients (Whale App), and Web GUI instances through a centralized Cloudflare Worker hub named `team-hub`. The protocol establishes a strict division of authority between collaboration management and task execution.

| Domain | Authority | Responsibilities |
| --- | --- | --- |
| Collaboration Domain | `team-hub` Worker | Issue tracking, assignment, collaboration lifecycle status, human review gates, comment threads, user decision questions, activity stream, and push notifications. |
| Execution Domain | Local DSH Host | Execution sessions, local workspace filesystem, sandbox policy enforcement, tool execution, model routing, and automated acceptance verification. |

### Invariant: Division of Authority
`team-hub` is authoritative over collaboration fields (issues, assignees, collaboration status including `in_review`, comments, activity stream, pending questions). The Host executing the card is authoritative over execution (sessions, local workspace execution, automated acceptance, process execution sandbox). Neither domain may override or bypass the authority of the other.

### Protocol Version and Version Negotiation
The protocol version string follows Semantic Versioning (`MAJOR.MINOR.PATCH`). The current protocol version defined by this document is `1.0.0`. All HTTP REST requests MUST include the header `X-Team-Hub-Protocol-Version: 1.0.0`. All WebSocket connection handshakes MUST supply `protocol_version=1.0.0` as a query parameter or include the `X-Team-Hub-Protocol-Version` header.

| Condition | Server Response | Behavior |
| --- | --- | --- |
| Major version matches, minor/patch equal or lower | `200 OK` / WebSocket accepted | Full compatibility; server serves the requested protocol. |
| Major version matches, minor higher on client | `200 OK` / WebSocket accepted | Backward-compatible; server ignores unrecognized additive fields. |
| Major version differs or version header missing | `400 Bad Request` (`UNSUPPORTED_PROTOCOL_VERSION`) | Connection rejected; client must update or negotiate compatible version. |

## 2. Identity and Authentication

The system identifies three classes of actors: human team members, execution nodes (Hosts), and autonomous Agents bound to Hosts.

### Human Authentication via GitHub OAuth
Human team members authenticate exclusively through GitHub OAuth. No custom password or credentials database is maintained on the Hub.

| Platform | OAuth Flow | Mechanics |
| --- | --- | --- |
| Web GUI | Authorization Code Flow | Browser navigates to `GET /auth/github/authorize`. GitHub redirects to `GET /auth/github/callback`. Hub issues session cookie or token pair. |
| iOS Whale App | Authorization Code with PKCE (RFC 7636) | App initiates `ASWebAuthenticationSession` with SHA-256 `code_challenge`. Callback scheme is `whale://auth/callback`. App exchanges `code` + `code_verifier` via `POST /auth/token`. |

### Hub Session Tokens
Upon successful GitHub authentication, the Hub issues a dual-token pair.

| Token Type | Storage | Lifetime | Usage |
| --- | --- | --- | --- |
| Access Token | In-memory / Secure storage | 7,200,000 ms (2 hours) | Bearer token in `Authorization: Bearer <token>` for all REST and WebSocket calls. |
| Refresh Token | D1 / Secure Keychain | 2,592,000,000 ms (30 days) | Submitted to `POST /auth/refresh` to obtain a new token pair with automatic refresh token rotation. |

Calling `POST /auth/revoke` invalidates the submitted refresh token and terminates the associated session immediately.

### Host Token
Execution nodes (Hosts) authenticate using a dedicated Host Token minted by a team administrator.

| Property | Specification |
| --- | --- |
| Format | `th_host_<64_hex_characters>` (high-entropy cryptographically secure random string). |
| Storage | Plaintext token is returned exactly once at issuance. D1 stores SHA-256 hash (`token_hash`). |
| Scope | Restricted strictly to Host execution endpoints: host registration, heartbeats, task claiming, lease renewal, question submission, settlement write-back, and agent comments. |
| Restrictions | A Host Token cannot access administrative endpoints, invite members, modify team settings, create issues, or approve human reviews. |
| Revocation | Team administrators can revoke any Host Token immediately via `POST /api/v1/teams/:teamId/hosts/:hostId/revoke-token`. Revoked tokens return `401 Unauthorized`. |

### Member Invitation and Management
Team administrators invite members by their GitHub username.

| Step | Actor | Action | Result |
| --- | --- | --- | --- |
| 1 | Admin | Calls `POST /api/v1/teams/:teamId/members/invite` with `github_username` and `role`. | Member record created with status `invited`. |
| 2 | Invitee | Authenticates via GitHub OAuth on Web or iOS Whale App. | Hub matches GitHub username, marks status `active`, and binds `github_user_id`. |
| 3 | Admin | Calls `DELETE /api/v1/teams/:teamId/members/:memberId` to remove a member. | Member status set to `suspended`; active sessions revoked immediately. |

## 3. D1 Database Schema

Data persistence uses Cloudflare D1 (SQLite-compatible relational database). All timestamps are stored as UTC milliseconds (`INTEGER NOT NULL`). All identifiers use typed prefix strings (`<prefix>_<id>`).

| Entity | ID Prefix | Example |
| --- | --- | --- |
| Team | `team_` | `team_01j7b5w8m4f9q2e3r6t1y8u4i5` |
| Member | `mem_` | `mem_01j7b5w8m4f9q2e3r6t1y8u4i6` |
| Host | `host_` | `host_01j7b5w8m4f9q2e3r6t1y8u4i7` |
| Agent | `agent_` | `agent_01j7b5w8m4f9q2e3r6t1y8u4i8` |
| Issue | `issue_` | `issue_01j7b5w8m4f9q2e3r6t1y8u4i9` |
| Comment | `comm_` | `comm_01j7b5w8m4f9q2e3r6t1y8u4ia` |
| Activity | `act_` | `act_01j7b5w8m4f9q2e3r6t1y8u4ib` |
| Question | `ques_` | `ques_01j7b5w8m4f9q2e3r6t1y8u4ic` |
| Push Token | `ptok_` | `ptok_01j7b5w8m4f9q2e3r6t1y8u4id` |

### DDL Schema Definitions

```sql
-- Teams table
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Team members table
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

-- Execution Hosts table
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

-- Agents table (bound to specific Host and owner member)
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

-- Issues table
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

-- Comments table
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

-- Activity stream table
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

-- Decision questions table
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

-- APNs push notification device tokens
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
```

## 4. Issue State Machine

The issue state machine coordinates human assignments, Host node execution leases, and human reviews.

### Invariant: Offline Execution Node Does Not Migrate
When a Host node is offline, any issue assigned to an Agent bound to that Host remains in `waiting_host` status and NEVER migrates to another Host. Task execution environments are bound to the specific developer machine, local repository state, and local credentials of the agent owner; tasks cannot be claimed by arbitrary nodes.

### State Transition Matrix

| From | To | Trigger | Actor | Preconditions | Activity Logged |
| --- | --- | --- | --- | --- | --- |
| `todo` | `assigned` | Assign task | Human | Target member or agent specified. | `issue.assigned` |
| `assigned` | `waiting_host` | Host offline check | Hub system | `assignee_type='agent'`; agent bound host status is `offline`. | `issue.waiting_host` |
| `assigned` | `running` | Claim lease | Bound Host | `assignee_type='agent'`; Host online; holds valid Host Token; claims active lease. | `issue.claimed` |
| `waiting_host` | `running` | Claim lease | Bound Host | `assignee_type='agent'`; Host returns online; claims active lease for its agent. | `issue.claimed` |
| `running` | `waiting_host` | Lease expired / Host offline | Hub system | `assignee_type='agent'`; lease timeout (60 s) expired without renewal or host missed 3 heartbeats. | `issue.host_offline` |
| `running` | `in_review` | Settle success | Executing Host | `assignee_type='agent'`; execution finished; automated acceptance tests passed locally. | `issue.settled_in_review` |
| `running` | `failed` | Settle failure | Executing Host | `assignee_type='agent'`; execution failed or unrecoverable error encountered. | `issue.failed` |
| `assigned` | `in_review` | Submit for review | Human | `assignee_type='member'`; `reviewer_member_id` is set; human assignee finishes work and requests review. | `issue.submitted_for_review` |
| `assigned` | `done` | Complete task directly | Human | `assignee_type='member'`; no `reviewer_member_id` set; human assignee marks task complete. | `issue.completed` |
| `in_review` | `done` | Approve review | Human | Human reviewer accepts the work. | `issue.approved` |
| `in_review` | `assigned` | Reject review (rework) | Human | Reviewer provides rework instructions; instructions stored on issue. | `issue.rework_requested` |
| `failed` | `assigned` | Retry execution | Human | Issue in `failed` status; human triggers retry; clears failure error. | `issue.retried` |
| Any active state | `canceled` | Cancel task | Human | User cancels issue before completion. | `issue.canceled` |

## 5. Host Execution Protocol

The DSH Host plugin `@linxin666/dsh-task-board-team` coordinates local card execution with the Hub.

### Registration and Heartbeat
1. At Host startup, the plugin reads configured Hub URL and Host Token.
2. Host calls `POST /api/v1/teams/:teamId/hosts/register` with hostname, client version, and local agent definitions.
3. Hub marks the host `online` and ensures agent records are synchronized.
4. Host sends periodic heartbeats via `POST /api/v1/teams/:teamId/hosts/:hostId/heartbeat` every 15,000 ms.
5. If Hub receives no heartbeat for 45,000 ms (3 consecutive misses), Hub marks host `offline` and marks running tasks `waiting_host`.

### Claiming Agent Cards and Lease Management
1. Host queries `GET /api/v1/teams/:teamId/issues?assignee_host_id=:hostId&status=assigned,waiting_host`.
2. Host issues an atomic claim call: `POST /api/v1/teams/:teamId/issues/:issueId/claim`.
3. Hub verifies the issue is assigned to an agent bound to this Host, issues a unique `lease_token` (UUIDv4), sets `lease_expires_at = now + 60000` ms, generates `execution_attempt_id`, transitions status to `running`, and returns the lease.
4. While execution is active, Host renews the lease every 20,000 ms via `POST /api/v1/teams/:teamId/issues/:issueId/renew-lease`, passing `lease_token`.
5. Hub extends `lease_expires_at` by 60,000 ms upon each successful renewal.

### Reconnect Idempotency and Duplicate Execution Prevention
If network connectivity drops temporarily or the Host process restarts:
1. The issue transitions to `waiting_host` upon lease expiry, but is NEVER reassigned to another node (Invariant: Offline Execution Node Does Not Migrate).
2. Upon reconnecting, Host calls `POST /api/v1/teams/:teamId/issues/:issueId/claim` providing its previous `execution_attempt_id` and `lease_token`.
3. Hub detects matching attempt credentials, re-establishes the active lease, and returns the existing state without creating duplicate execution sessions.
4. If local execution already finished before reconnection, Host immediately submits `POST /api/v1/teams/:teamId/issues/:issueId/settle` with the existing `execution_attempt_id`.

### Settlement Write-Back
When local execution completes:
1. Success path: Automated acceptance passes on the Host. Host calls `POST /api/v1/teams/:teamId/issues/:issueId/settle` with `outcome: "succeeded"`, `summary`, and verification evidence. Hub transitions status to `in_review`.
2. Failure path: Agent fails or automated acceptance is blocked. Host calls settle endpoint with `outcome: "failed"` and failure text. Hub transitions status to `failed`.

## 6. Help-seeking and Questions

When an agent needs human guidance or user confirmation during execution, it routes the question to the Hub.

### Workflow
1. Host intercepts an agent's question event (such as `ask_user_question` or stuck input signal) in-process from the execution session.
2. Host sends `POST /api/v1/teams/:teamId/issues/:issueId/questions` with the question text, options, and multi-select flag.
3. Hub saves the question with status `pending`, emits WebSocket event `question.created`, and sends APNs push notifications to the issue reviewer, plus the human assignee (if `assignee_type='member'`). By the default reviewer rule (Section 13), every agent-executed issue always has an active human reviewer (defaulting to the issue creator).
4. An authorized team member responds via Whale iOS App or Web GUI by calling `POST /api/v1/teams/:teamId/questions/:questionId/answer`.
5. Resolution rule: First response wins.
- The first answer sets status to `answered`, recording `first_responder_member_id` and timestamp. - Any competing responses submitted after the first receive `409 Conflict` (`QUESTION_ALREADY_ANSWERED`).
6. Hub broadcasts WebSocket event `question.answered` containing the selected answer.
7. Host receives the WebSocket event, identifies the waiting agent session, injects the user answer, and resumes agent execution.

### Question Termination Lifecycle
A question terminates in one of three ways: answered, expired, or withdrawn.
1. Answered: A human responds first, transitioning the question to `answered` and broadcasting `question.answered` (Step 5 above).
2. Expired: If a pending question reaches its 24-hour TTL (86,400,000 ms) without an answer, the Hub marks question status `expired`, records `question.expired` activity, and broadcasts WebSocket event `question.expired` with `{ question_id, issue_id }`. The executing Host receives the event and resolves the waiting session question as unanswered / timed out, allowing the agent to proceed with default assumptions or pause.
3. Withdrawn: If the agent cancels or aborts execution locally before an answer arrives, the Host calls `POST /api/v1/teams/:teamId/questions/:questionId/withdraw`. The Hub verifies the question is pending, marks status `dismissed`, records `question.withdrawn` activity, and broadcasts WebSocket event `question.withdrawn` with `{ question_id, issue_id }` so mobile and web clients dismiss the prompt.

### Invariant: Tool Permission Approvals Never Enter Hub
Tool execution permission approvals (such as `approval/request`, terminal command execution, filesystem write grants outside sandbox, or `danger-full-access` permissions) belong exclusively to the local Host machine security domain. Tool permission approvals MUST NEVER enter `team-hub`. The Hub exposes NO endpoints, NO database schema, and NO WebSocket events for tool permissions. Tool permission requests are resolved strictly on the local machine by the Host owner (via local Web GUI or direct peer-to-peer bridge connection over Tailscale/LAN).

## 7. Comments and Mentions

The comment stream supports collaboration between human members and autonomous agents.

### Mention Syntax and Resolution
Comments are formatted in Markdown. Mentions are parsed using the regular expression `/(?:^|\s)@([a-zA-Z0-9_-]+)/`.

| Target Type | Identifier | Delivery Mechanism |
| --- | --- | --- |
| Human Member | GitHub username | Hub emits WebSocket event `comment.created` and APNs notification with category `mentioned`. |
| Agent | Agent name | Hub resolves the agent's bound Host, emits WebSocket event `comment.mentioned` to that Host. |

### Delivering `@Agent` Comments to Session
When an agent is mentioned in a comment:
1. Hub pushes WebSocket event `comment.mentioned` to the Host owning the agent.
2. Host receives the event and invokes the DSH task board extension capability `followUp` (M0).
3. The comment text is injected as a new user message into the card's active or most recent execution session.

### Agent Comment Submission
Agents post comments to the Hub using the registered tool `team_comment`:
1. Agent invokes tool: `team_comment({ issue_id: "issue_...", text: "..." })`.
2. Host receives tool call and sends `POST /api/v1/teams/:teamId/issues/:issueId/comments` with Host Token.
3. Payload specifies `author_type: "agent"` and `author_agent_id`.
4. Hub stores comment, records `comment.created` activity, and broadcasts to team members.

## 8. Human Review

Automated acceptance verifies mechanical contracts; human review verifies satisfaction.

### In-Review Lifecycle
When automated acceptance passes on the Host, the issue transitions to `in_review` on the Hub. The card remains in the Host ledger's Done column locally while awaiting human review on the Hub.

### Approval
1. Reviewer inspects execution output, diffs, and verification summary.
2. Reviewer calls `POST /api/v1/teams/:teamId/issues/:issueId/review/approve`.
3. Hub transitions issue status to `done` and records `issue.approved` activity.

### Rejection and Rework
1. Reviewer calls `POST /api/v1/teams/:teamId/issues/:issueId/review/reject` with `instructions`.
2. Hub stores rework instructions on the issue, clears any active lease, transitions issue status to `assigned` (or `waiting_host` if the bound Host is offline), and records `issue.rework_requested` activity.
3. Hub delivers WebSocket event `issue.rework` with rework instructions to the bound Host as a notification signal to claim the card.
4. Bound Host receives `issue.rework`, generates a new `execution_attempt_id`, and calls `POST /api/v1/teams/:teamId/issues/:issueId/claim` to acquire an active lease; only after the claim succeeds does it invoke the DSH task board extension capability `rework` (M0) to re-run the task in the same session (`reuseSession`) feeding rework instructions into the session context; if the claim fails, the Host aborts execution and records a local error without starting the rework session.

## 9. Wire Protocol and Transport

All HTTP requests and responses use JSON format with UTF-8 encoding.

### REST Endpoints Table

| Method | Path | Auth | Request Body | Response Body | Status Codes | Error Codes |
| --- | --- | --- | --- | --- | --- | --- |
| `GET` | `/auth/github/authorize` | Public | None | Redirects to GitHub OAuth | 302 | None |
| `GET` | `/auth/github/callback` | Public | None (query params `code`, `state`) | HTML / App Redirect | 302 | `INVALID_OAUTH_CODE` |
| `POST` | `/auth/token` | Public | `{ code, code_verifier, redirect_uri }` | `{ access_token, refresh_token, token_type, expires_in }` | 200, 400 | `INVALID_PKCE`, `INVALID_OAUTH_CODE` |
| `POST` | `/auth/refresh` | Public | `{ refresh_token }` | `{ access_token, refresh_token, token_type, expires_in }` | 200, 401 | `INVALID_REFRESH_TOKEN` |
| `POST` | `/auth/revoke` | Member | `{ refresh_token }` | `{ ok: true }` | 200, 401 | `UNAUTHORIZED` |
| `GET` | `/api/v1/teams/:teamId/members` | Member | None | `{ members: Member[] }` | 200, 401, 403 | `UNAUTHORIZED`, `FORBIDDEN` |
| `POST` | `/api/v1/teams/:teamId/members/invite` | Admin | `{ github_username, role }` | `{ member: Member }` | 201, 400, 403 | `USER_NOT_FOUND`, `ALREADY_MEMBER` |
| `DELETE` | `/api/v1/teams/:teamId/members/:memberId` | Admin | None | `{ ok: true }` | 200, 403, 404 | `MEMBER_NOT_FOUND` |
| `POST` | `/api/v1/teams/:teamId/hosts/tokens` | Admin | `{ hostname }` | `{ host_id, host_token }` | 201, 403 | `FORBIDDEN` |
| `POST` | `/api/v1/teams/:teamId/hosts/:hostId/revoke-token` | Admin | None | `{ ok: true }` | 200, 403, 404 | `HOST_NOT_FOUND` |
| `POST` | `/api/v1/teams/:teamId/hosts/register` | Host | `{ hostname, client_version, agents: AgentDef[] }` | `{ host_id, status }` | 200, 401 | `UNAUTHORIZED` |
| `POST` | `/api/v1/teams/:teamId/hosts/:hostId/heartbeat` | Host | None | `{ ok: true, server_time }` | 200, 401, 404 | `HOST_NOT_FOUND` |
| `GET` | `/api/v1/teams/:teamId/issues` | Member/Host | None (query filters `status`, `assignee`) | `{ issues: Issue[] }` | 200, 401 | `UNAUTHORIZED` |
| `POST` | `/api/v1/teams/:teamId/issues` | Member | `{ title, description?, assignee_type?, assignee_id?, reviewer_member_id? }` | `{ issue: Issue }` | 201, 400, 401 | `VALIDATION_FAILED` |
| `GET` | `/api/v1/teams/:teamId/issues/:issueId` | Member/Host | None | `{ issue: Issue }` | 200, 401, 404 | `ISSUE_NOT_FOUND` |
| `PATCH` | `/api/v1/teams/:teamId/issues/:issueId` | Member | `{ title?, description?, assignee_type?, assignee_id?, reviewer_member_id?, status? }` | `{ issue: Issue }` | 200, 400, 401 | `INVALID_STATE_TRANSITION` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/claim` | Host | `{ execution_attempt_id?, lease_token? }` | `{ lease_token, lease_expires_at, execution_attempt_id }` | 200, 401, 409 | `LEASE_HELD_BY_OTHER`, `HOST_MISMATCH` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/renew-lease` | Host | `{ lease_token }` | `{ lease_expires_at }` | 200, 401, 412 | `LEASE_EXPIRED` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/settle` | Host | `{ outcome, summary?, error?, verification_evidence? }` | `{ ok: true, status }` | 200, 401, 412 | `LEASE_EXPIRED` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/review/approve` | Member | None | `{ ok: true, status: "done" }` | 200, 401, 422 | `INVALID_STATE_TRANSITION` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/review/reject` | Member | `{ instructions }` | `{ ok: true, status: "assigned" }` | 200, 400, 422 | `INVALID_STATE_TRANSITION` |
| `GET` | `/api/v1/teams/:teamId/issues/:issueId/comments` | Member/Host | None | `{ comments: Comment[] }` | 200, 401, 404 | `ISSUE_NOT_FOUND` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/comments` | Member/Host | `{ content, author_type?, author_agent_id? }` | `{ comment: Comment }` | 201, 400, 401 | `VALIDATION_FAILED` |
| `POST` | `/api/v1/teams/:teamId/issues/:issueId/questions` | Host | `{ question_text, options?, multi_select? }` | `{ question: Question }` | 201, 400, 401 | `VALIDATION_FAILED` |
| `POST` | `/api/v1/teams/:teamId/questions/:questionId/answer` | Member | `{ selected_options?, custom_text? }` | `{ ok: true }` | 200, 401, 409 | `QUESTION_ALREADY_ANSWERED` |
| `POST` | `/api/v1/teams/:teamId/questions/:questionId/withdraw` | Host | None | `{ ok: true, status: "dismissed" }` | 200, 401, 404, 409 | `QUESTION_NOT_PENDING`, `HOST_MISMATCH` |
| `POST` | `/api/v1/push-tokens` | Member | `{ platform, device_token, bundle_id, environment }` | `{ ok: true }` | 200, 400, 401 | `VALIDATION_FAILED` |
| `DELETE` | `/api/v1/push-tokens/:token` | Member | None | `{ ok: true }` | 200, 401 | `UNAUTHORIZED` |

### Durable Object WebSocket Protocol
Each team is backed by one Durable Object (`TeamChannelDO`). Clients connect to: `wss://<hub-domain>/api/v1/teams/:teamId/ws?token=<token>&since_seq=<seq>`.

| Frame | Direction | Schema | Purpose |
| --- | --- | --- | --- |
| `ping` | Client -> DO | `{ "t": "ping", "ts": <number> }` | Connection keepalive probe. |
| `pong` | DO -> Client | `{ "t": "pong", "ts": <number> }` | Response to ping probe. |
| `resume` | Client -> DO | `{ "t": "resume", "since_seq": <number> }` | Requests replaying missed events from `since_seq`. |
| `event` | DO -> Client | `{ "t": "event", "seq": <number>, "event": "<name>", "payload": {...}, "ts": <number> }` | Broadcasts real-time team mutations. |
| `resync_required` | DO -> Client | `{ "t": "resync_required", "reason": "<reason>", "latest_seq": <number> }` | Sent when `since_seq` is too old; client must re-fetch full state via REST. |

### WebSocket Event Types

| Event Name | Recipient | Payload Shape |
| --- | --- | --- |
| `issue.created` | All connected | `{ issue: Issue }` |
| `issue.updated` | All connected | `{ issue: Issue, changed_fields: string[] }` |
| `issue.status_changed` | All connected | `{ issue_id: string, old_status: string, new_status: string }` |
| `issue.claimed` | All connected | `{ issue_id: string, executing_host_id: string }` |
| `issue.rework` | Bound Host | `{ issue_id: string, instructions: string, reviewer_member_id: string }` |
| `comment.created` | All connected | `{ comment: Comment }` |
| `comment.mentioned` | Bound Host | `{ issue_id: string, comment_id: string, author: string, content: string }` |
| `question.created` | All connected | `{ question: Question }` |
| `question.answered` | All connected | `{ question_id: string, answer: any, responder_member_id: string }` |
| `question.expired` | All connected | `{ question_id: string, issue_id: string }` |
| `question.withdrawn` | All connected | `{ question_id: string, issue_id: string }` |
| `host.status_changed` | All connected | `{ host_id: string, status: "online" | "offline" }` |

### Monotonic Event Sequence and Resumption Rules
1. `seq` is a strictly monotonically increasing 64-bit integer maintained by the team's Durable Object.
2. The Durable Object holds a ring buffer of the last 1,000 events or events from the last 3,600,000 ms (1 hour).
3. Upon reconnecting, client provides `since_seq` in query parameter or `resume` frame.
4. If `since_seq` is within the buffer window, the Durable Object immediately streams all missed events in monotonic order before streaming live events.
5. If `since_seq` is absent, 0, or older than the buffer boundary, the Durable Object emits `resync_required`. The client MUST clear its local delta cache and re-fetch the complete team snapshot via REST API.

### Unified Error Response Schema
All error responses adhere to a single unified JSON schema:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable explanation of failure.",
    "details": {}
  }
}
```

### Unified Error Codes Table

| Code | HTTP Status | Description |
| --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing, malformed, or invalid authentication token. |
| `FORBIDDEN` | 403 | Caller lacks required role or permission for this operation. |
| `NOT_FOUND` | 404 | Target resource (team, member, host, issue, question) does not exist. |
| `CONFLICT` | 409 | Resource state conflict (e.g. duplicate slug, question already answered). |
| `VALIDATION_FAILED` | 400 | Request body failed structural validation or schema constraints. |
| `UNSUPPORTED_PROTOCOL_VERSION` | 400 | Requested protocol version major number is unsupported. |
| `INVALID_STATE_TRANSITION` | 422 | Attempted lifecycle transition disallowed by state machine. |
| `LEASE_EXPIRED` | 412 | Lease renewal or settlement failed because lease expired. |
| `LEASE_HELD_BY_OTHER` | 409 | Task claim rejected because active lease is held by another execution attempt. |
| `HOST_OFFLINE` | 400 | Operation requires target Host to be online. |
| `QUESTION_ALREADY_ANSWERED` | 409 | Answering failed because another member already answered first. |
| `QUESTION_NOT_PENDING` | 409 | Question cannot be answered or withdrawn because it is no longer pending. |
| `HOST_MISMATCH` | 403 | Host is not authorized to claim, settle, or withdraw questions for this issue or host binding. |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds configured byte limit. |
| `RATE_LIMITED` | 429 | Request rate exceeded allowed quota. |
| `INTERNAL_ERROR` | 500 | Unhandled internal server or database error. |

## 10. Push Notifications (APNs)

The Hub communicates directly with Apple Push Notification service (APNs) over HTTP/2 using JWT provider authentication.

### Event Categories and Triggers

| APNs Category | Trigger Event | Target Recipient | Alert Format |
| --- | --- | --- | --- |
| `assigned` | Issue assigned | Assigned human member | "You were assigned to issue #<number>: <title>" |
| `question_asked` | Agent asks question | Issue reviewer, plus human assignee (if `assignee_type='member'`) | "Agent <agent_name> asked a question on #<number>: <question_text>" |
| `review_requested` | Issue enters `in_review` | Issue reviewer | "Issue #<number> is ready for review: <title>" |
| `mentioned` | Comment mentions human | Mentioned human member | "<author_name> mentioned you on #<number>" |

### APNs Payload Format

```json
{
  "aps": {
    "alert": {
      "title": "Team Collaboration",
      "body": "Agent qa-bot asked a question on #14: Confirm API endpoint"
    },
    "sound": "default",
    "badge": 1,
    "category": "TEAM_COLLAB"
  },
  "team_id": "team_01j7b5w8m4f9q2e3r6t1y8u4i5",
  "issue_id": "issue_01j7b5w8m4f9q2e3r6t1y8u4i9",
  "event_type": "question_asked",
  "question_id": "ques_01j7b5w8m4f9q2e3r6t1y8u4ic"
}
```

### Token Registration and Secret Custody
1. Client registers device token upon login via `POST /api/v1/push-tokens`.
2. Stale or invalid tokens returning HTTP `410 Unregistered` from APNs are automatically purged from D1.
3. Client unregisters device token upon logout via `DELETE /api/v1/push-tokens/:token`.
4. APNs `.p8` private key and credentials are encrypted as Cloudflare Worker secrets:
- `APNS_KEY_ID`: 10-character Apple Developer Key ID. - `APNS_TEAM_ID`: 10-character Apple Developer Team ID. - `APNS_BUNDLE_ID`: Mobile application bundle identifier. - `APNS_PRIVATE_KEY_P8`: PEM-encoded EC private key.
5. The Worker signs ES256 authentication tokens on demand with a 3,000,000 ms (50 minutes) cache.

## 11. Security, Quotas, and Governance

### Role-Based Access Control Matrix

| Endpoint Group | Admin | Member | Host Token | Anonymous |
| --- | --- | --- | --- | --- |
| OAuth endpoints (`/auth/*`) | Yes | Yes | No | Yes |
| Team and Member management | Yes | Read-only | No | No |
| Host Token minting and revocation | Yes | No | No | No |
| Host registration and heartbeats | No | No | Yes | No |
| Issue creation and editing | Yes | Yes | No | No |
| Issue claiming and lease renewal | No | No | Yes | No |
| Issue settlement write-back | No | No | Yes | No |
| Human review approve / reject | Yes | Yes | No | No |
| Comment submission | Yes | Yes | Yes (Agent comments only) | No |
| Question submission | No | No | Yes | No |
| Question answering | Yes | Yes | No | No |
| Question withdrawal | Yes | No | Yes | No |
| Push token registration | Yes | Yes | No | No |

### Rate Limiting

| Target | Window | Maximum Requests |
| --- | --- | --- |
| Authentication routes (`/auth/*`) | 60,000 ms (1 minute) | 20 requests per client IP |
| Member API routes | 60,000 ms (1 minute) | 120 requests per member ID |
| Host execution routes | 60,000 ms (1 minute) | 30 requests per host ID |
| WebSocket frame transmissions | 60,000 ms (1 minute) | 60 frames per connection |

### Payload Size Limits

| Field / Target | Cap |
| --- | --- |
| Issue title | 256 characters |
| Issue description | 65,536 bytes (64 KiB) |
| Comment text | 32,768 bytes (32 KiB) |
| Execution summary | 4,000 characters (aligned with DSH `EXECUTION_SUMMARY_LIMIT`) |
| Total HTTP request body | 131,072 bytes (128 KiB) |
| WebSocket text frame | 65,536 bytes (64 KiB) |

### Audit Logging
All state-modifying actions record an immutable record in the `activity` table. Activity stream entries are append-only. No API endpoint exists to update or delete activity records.

## 12. Non-Goals for Phase 1

To preserve delivery velocity for M1 through M4, the following capabilities are explicitly excluded from Phase 1:
1. Planning hierarchy layers: Projects, Milestones, Cycles, Epics, and Roadmaps.
2. Automated issue triage, sentiment scoring, and automated routing rule engines.
3. Story point estimation, developer velocity calculations, and burndown analytics.
4. Multi-team billing, payment plans, and subscription tier metering (Phase 1 schema is multi-tenant capable, deployed for a single team).
5. Custom role definitions and fine-grained ACLs beyond `admin` and `member`.
6. Outbound webhook integrations to third-party issue trackers (e.g. Linear, Jira) or chat systems (e.g. Slack, Discord).

## 13. Open Defaults

The following defaults are defined by this specification for operational parameters not fixed by the proposal note.

| Parameter | Value | Rationale |
| --- | --- | --- |
| Lease duration | 60,000 ms (60 seconds) | Provides sufficient buffer for network latency and edge Worker cold starts during execution, while bounding recovery time if an agent host terminates abnormally. |
| Heartbeat interval | 15,000 ms (15 seconds) | Balances real-time liveness detection against Cloudflare Worker D1 and invocation cost. |
| Host offline detection threshold | 45,000 ms (45 seconds) | Corresponds to exactly 3 missed heartbeat intervals, preventing false positives caused by transient network jitter. |
| Lease renewal cadence | 20,000 ms (20 seconds) | Guarantees that at least two lease renewal attempts occur before a 60,000 ms lease expires. |
| Session access token TTL | 7,200,000 ms (2 hours) | Industry-standard duration for mobile and web session tokens, limiting the exposure window of compromised bearer tokens. |
| Session refresh token TTL | 2,592,000,000 ms (30 days) | Provides seamless mobile login persistence without requiring daily re-authentication on iOS. |
| Host Token TTL | Indefinite until revoked | Execution Hosts run as background daemon services and must not fail intermittently due to calendar-based credential expiration. |
| Question expiration TTL | 86,400,000 ms (24 hours) | Gives team members a full business day to answer agent queries before the question automatically expires. |
| Durable Object event replay buffer | 1,000 events or 3,600,000 ms (1 hour) | Accommodates typical mobile tunnel reconnection gaps while preventing unbounded memory consumption in Durable Objects. |
| APNs JWT signing token cache TTL | 3,000,000 ms (50 minutes) | Apple permits JWT tokens up to 60 minutes; a 50-minute cache maximizes reuse while eliminating expiration edge cases. |
| Execution summary character limit | 4,000 characters | Directly mirrors DSH task board `EXECUTION_SUMMARY_LIMIT` (`packages/dsh-task-board/src/core/tasks.ts`), preventing ledger truncation drift. |
| Issue description byte limit | 65,536 bytes (64 KiB) | Directly mirrors the DSH task board opaque `integrations` payload cap (64 KiB) defined in the extension contract. |
| Comment text byte limit | 32,768 bytes (32 KiB) | Permits detailed markdown explanations, logs, and code snippets while guarding against database bloat. |
| Member API rate limit | 120 requests per minute | Accommodates rapid navigation in Web and iOS clients without triggering false rate limit rejections. |
| Host API rate limit | 30 requests per minute | Provides headroom for simultaneous heartbeats, lease renewals, and occasional comment/question traffic. |
| Auth route rate limit | 20 requests per minute per IP | Protects edge Worker authentication endpoints against brute-force attacks and abuse. |
| Default reviewer for Agent issues | creator_member_id | When an issue is assigned to an Agent (`assignee_type='agent'`) and no explicit `reviewer_member_id` is provided, the issue creator automatically defaults to the reviewer. This guarantees that every agent-executed card has a designated human reviewer for questions, push notifications, and the `in_review` approval gate. |
