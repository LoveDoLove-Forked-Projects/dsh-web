# Contract samples

One JSON document per Host-facing interface, plus the WebSocket handshake and
the event catalogue. They are the interface the hub and the Host share, so both
sides read these files instead of restating the shapes:

- the hub asserts its own responses against them (`team-hub/test/contract.test.ts`);
- the plugin's fake hub and its tests read the same files, so a change on either
  side that is not reflected here fails a test.

| File | Interface |
| --- | --- |
| `bootstrap.json` | `POST /api/v1/bootstrap` |
| `register.json` | `POST /api/v1/teams/:teamId/hosts/register` |
| `heartbeat.json` | `POST /api/v1/teams/:teamId/hosts/:hostId/heartbeat` |
| `issues-list.json` | `GET /api/v1/teams/:teamId/issues` |
| `claim.json` | `POST /api/v1/teams/:teamId/issues/:issueId/claim` |
| `renew-lease.json` | `POST /api/v1/teams/:teamId/issues/:issueId/renew-lease` |
| `settle.json` | `POST /api/v1/teams/:teamId/issues/:issueId/settle` |
| `questions.json` | `POST /api/v1/teams/:teamId/issues/:issueId/questions` |
| `withdraw.json` | `POST /api/v1/teams/:teamId/questions/:questionId/withdraw` |
| `comments.json` | `POST /api/v1/teams/:teamId/issues/:issueId/comments` |
| `comments-list.json` | `GET /api/v1/teams/:teamId/issues/:issueId/comments` |
| `ws-handshake.json` | WebSocket handshake headers, the rejected variants (token in the query string, missing protocol version) and the frames |
| `ws-events.json` | Every WebSocket event with its payload, including the `question.answered` answer relay |

## Shape

Every REST document is `{ interface, description, method, path, auth, request, response, notes }`.
`request` carries the headers a client must send, an optional `query` and an
optional `body`; `response` carries the HTTP status and the body. Identifiers in
the samples are examples: any string starting with `team_`, `mem_`, `host_`,
`agent_`, `issue_`, `comm_` or `ques_` stands for the live value.

`ws-handshake.json` and `ws-events.json` use their own keys (`url`, `headers`,
`rejected`, `frames`, `events`) because a WebSocket has no HTTP body to show.