# Agent Note: Team collaboration extension for the task board

Status: proposed

## Problem

The DSH task board is a single-machine, single-writer Host ledger without the concept of humans or persons. In remote-bridge ([remote bridge protocol v1](../../implemented/architecture/2026-10-16-remote-bridge-protocol-v1.md)), each paired device corresponds to a single public key record, and all calls are emitted under the identity of the same owner peer. The task board only tracks `initiatedBy` on execution records, with no concept of an assignee or owner. In small teams of 2 to 5 people, each member runs their own DSH and Agents, but there is no shared collaboration surface where human teams and Agent teams can assign tasks to one another, ask for help, and review work. The design reference is Linear.

## Proposal

1. **Topology**: Multi-host topology with a cloud hub `team-hub`. `team-hub` is an independent Cloudflare Worker (separated from `market/worker`), using D1 for data persistence and one Durable Object per team for real-time WebSocket push and serialized writes. The schema supports multi-tenant teams, while Phase 1 deploys a single team.
2. **Division of authority**: `team-hub` is authoritative over collaboration fields (issues, assignees, collaboration status including `in_review`, comments, activity stream, pending questions); the Host executing the card is authoritative over execution (sessions, execution, automated acceptance). A new plugin `@linxin666/dsh-task-board-team` (`packages/dsh-task-board-team`) serves as the second external provider under the [task board extension contract](../../implemented/architecture/2026-09-30-task-board-extension-contract.md), leaving the core board columns and ledger unchanged. Local cards mirror hub issues via opaque `integrations` payloads, and execution results write back to the hub.
3. **Identity**: Human members log in via GitHub OAuth (Web and iOS), and administrators invite members by GitHub username. Each Host registers as an execution node using a Host Token minted by an administrator.
4. **Assignees**: Assignees can be either humans or Agents. Each Agent member (sourced from `dsh-agents` member definitions) binds to a specific human member's Host, and is claimed and executed under lease by that Host. When the Host is offline, the card remains in "waiting for execution node" and never migrates to other Hosts.
5. **Help-seeking routing**: Decision questions like `ask_user_question` and "stuck / requires input" signals are routed via the hub to the card's human assignee or reviewer; tool permission approvals are routed strictly to the owner of the Host executing the card. When answered across multiple surfaces, the first response wins. Host-side mechanism: joins the in-process approval waterfall like remote-bridge's approvals/questions ([remote bridge protocol v1](../../implemented/architecture/2026-10-16-remote-bridge-protocol-v1.md)), claiming only "questions" from sessions associated with team cards while never claiming permission approvals.
6. **Human review**: After task board automated acceptance passes, hub status transitions to `in_review`; only when the reviewer approves does it enter Done. Upon rejection, the review comment acts as rework instructions, re-running in the same session (`reuseSession`). Local board columns maintain their existing closed set, with `in_review` existing solely on the hub.
7. **Comments**: Comments that `@` an Agent are delivered as follow-up messages into its execution session; Agents post comments via a new tool `team_comment` (registered using the extension contract's `registerTool`). All activities are recorded in the hub's activity stream.
8. **iOS**: Whale App (the Remote project in repository `~/code/iphone_remote_use_dsh`) is the primary entrance for human members, responsible for the inbox, assignment, comments, reviews, and answering questions. It connects directly to `team-hub` (HTTPS + WebSocket with GitHub login), with push notifications dispatched by the Worker calling APNs directly. The original channel directly connecting to the user's own Host via Tailscale and bridge remains in place for inspecting sessions and approving tool permissions.
9. **Explicit non-goals for Phase 1**: Planning layers such as Projects, Cycles, Triage, and story point estimation are excluded from the initial release.

## Context & Efficiency Impact

The design adds one tool `team_comment` with a brief schema. Questions and comments enter sessions as follow-up messages, incrementally expanding context per message. Board snapshots gain only an opaque `integrations` entry per card (bounded at 64 KiB each).

## Contract gaps

The existing task board extension contract (`packages/dsh-task-board/src/core/extension.ts`, `TASK_BOARD_API_VERSION = 1`, [task board extension contract](../../implemented/architecture/2026-09-30-task-board-extension-contract.md)) provides `tasks.{list, get, create, patchContent, setStatus, linked}`, `integration.{read, write}`, `events.{onStatusChanged, onExecutionSettled, onTaskDeleted}`, `publish`, `registerTool`, and `handleAction`, but lacks two capabilities: (a) delivering follow-up messages into a card's current or most recent execution session; (b) re-running an already-executed card with rework instructions while reusing its session (`reuseSession`). Because executed card content is frozen by `canEditTaskContent`, `patchContent` cannot be used as a substitute. We propose extending the contract in an optional, additive manner, keeping `apiVersion` at 1 so existing providers built against v1 remain unaffected. This design requires review and sign-off by the task board owner in M0.

## Milestones

- **M0 Contract additions**: Add optional `followUp` and `rework` capabilities to `dsh-task-board`, accompanied by contract tests.
- **M1 team-hub**: First produce hub protocol specifications (REST, WS events, D1 schema: `teams`, `members`, `hosts`, `agents` bound to host, `issues`, `comments`, `activity`, `questions`, `push_tokens`), then implement GitHub OAuth, Host Token, Durable Object push, leases, and APNs. Code directory is `team-hub/`, positioned alongside `market/`.
- **M2 dsh-task-board-team plugin**: The host half handles hub client, issue-to-card mirroring (mirroring only cards for Agents bound to this machine), lease renewal, execution settlement write-back, `team_comment`, question routing, `@` comment delivery, and rework; the client half handles settings section (hub URL, Host Token, Agent binding), detail section (assignee, comments, activity stream), and card decorations. Depends on M0 and M1 protocol specifications.
- **M3 Whale iOS**: GitHub login, inbox, issue list and detail views, assignment, comments, review approve/reject, answering questions, and APNs registration. Depends on M1.
- **M4 Acceptance & release prep**: End-to-end acceptance across two Hosts, plus release preparations including README triplets, aggregate registration, and publish-prep updates.

M0 and M1 can run in parallel; M2 and M3 can run in parallel once M1's protocol specifications freeze.

## Alternatives considered

**Share a single Host**: Rejected because team members need to run Agents on their own machines using their respective repositories, local configurations, and API keys. A shared single host cannot accommodate distinct local developer environments.

**Replicate the full ledger across every Host via CRDTs**: Rejected because it requires altering the task board ledger data structures, writing complex conflict resolution merge logic, and breaking the single-writer invariant that guarantees local deterministic consistency.

**Pooled online Host task claiming**: Rejected because execution environments vary widely across machines (dependencies, tooling, working directories), and API expense attribution becomes ambiguous when arbitrary nodes pick up tasks.

**Allow teammates to approve tool permissions**: Rejected because tool execution runs directly on the local machine with its sandbox and host access; allowing remote team members to approve tool permissions violates the security boundary of local host execution.

**Custom identity with invite codes and device keys**: Rejected because building proprietary auth forces implementing bespoke account recovery, device revocation, and multi-device identity synchronization from scratch, adding maintenance burden with no security advantage over GitHub OAuth.

**Self-hostable Node.js service**: Rejected because maintaining both a Node.js server stack and a serverless edge deployment doubles the runtime surface and operational maintenance overhead; standardizing on Cloudflare Worker, D1, and Durable Objects keeps the operational footprint unified.

**Replace automated acceptance with human review**: Rejected because human reviewers would be forced to review every raw intermediate run and trivial output, losing the efficiency benefits of automated contract and goal verification gates.

**Comments circulated solely among humans**: Rejected because it eliminates the collaboration interface between humans and Agents; delivering `@` comments into agent sessions and letting agents reply via comments are essential for human-agent team interaction.

## Acceptance criteria

- End-to-end flow verified across 2 members and 2 Hosts: Member A creates a card in Whale iOS App and assigns it to an Agent bound to Member B's machine.
- Member B's Host claims the card and executes it under lease.
- The Agent asks a question using `team_comment`; Member A receives a lock-screen push notification and answers from the App.
- After task board automated acceptance passes, status enters `in_review`.
- Member A rejects the review with rework comments; the task re-runs in the same session (`reuseSession`).
- Upon passing automated acceptance again, Member A approves and status transitions to Done.
- All lifecycle events, questions, comments, and status transitions are recorded in the hub activity stream.
- Tool permission approvals never appear on Member A's device (strictly routed to Member B's host owner).
- When Member B's Host is offline, the card displays "waiting for execution node" rather than migrating.
- Core task board code contains no team-specific vocabulary (`grep` verification in `packages/dsh-task-board`).
- All repository merge gates pass (`CI checks`, `plugin-mount`, `Validate PR contribution evidence`, `guard-agent-notes`).

## Risks

- APNs integration requires an Apple Developer account and custody of a `.p8` private key configured as a Worker secret.
- Potential duplicate execution during lease expiration and Host reconnection.
- GitHub OAuth callback handling on iOS (custom URL scheme or Universal Links).
- Degradation during hub downtime: local Host task execution remains unaffected, while team collaboration features pause gracefully.
- Token consumption incurred by follow-up messages injecting questions and comments into active sessions.
- Contract additions (`followUp` and `rework`) require review and approval by the task board owner in M0.
