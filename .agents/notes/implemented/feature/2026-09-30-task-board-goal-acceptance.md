# Agent Note: Task-board goal acceptance

Status: implemented

## Problem

A task-board execution runs an autonomous goal: the runner arms `/goal`, the
goal-round driver keeps starting continuation rounds, and the card settles when
the goal leaves its active phase. Nothing in that loop certifies the WORK. The
only party that decided the objective was achieved was the agent itself, and the
board's own settlement read that self-report: a session that narrated success and
called `update_goal(action: complete)` settled the card as done.

The requested control is an evaluator-backed gate with a narrow, explicit
budget: before `update_goal(action: complete)` may take effect, the board
judges the run's real evidence; the first failure returns findings to the fixing
agent, the second failure ends that execution. The rule to judge with is the
default final acceptance of the installed `dsh-llm-verifier` (0.8.4, MIT), and
the configuration must be frozen per execution so a later settings edit cannot
change the verdict rule of a run already in flight.

## Decision

The board owns the acceptance mechanism end to end, and it reuses the
verifier's default acceptance ALGORITHM rather than the verifier.

- **Gate.** The listener sits on the official tool pre-execution lifecycle
  (`ctx.on('tools/pre-execute')`) and acts on exactly `update_goal` with
  `action: 'complete'`. The session the call arrives from is resolved to the
  board's open execution through `HostExecutionLedger.findOpenExecutionBySession`;
  a pass record for that execution allows the call, a refusal returns the
  feedback and the call never reaches the goal service. The agent is never asked
  to verify itself, and no prompt wording can route around the gate.
- **Algorithm.** `src/core/verification.ts` mirrors the verifier's default
  final acceptance byte-for-byte where the judge prompt depends on it: the three
  coding criteria of `DEFAULT_CRITERIA` (Specification Adherence, Output
  Match, Error Signal Detection), the 20-letter A-T scale and its
  `<score_A>`/`<score_B>` tag contract, the untrusted-evidence framing,
  `EMPTY_WORK_BASELINE` as candidate B, two rounds per criterion with the A/B
  slots swapped on the odd round, per-round scores mapped back to the
  comparison's slots and averaged per criterion, and the pass rule
  `score > baseline && score >= 0.65 && every criterion >= 0.65`
  (`sessionAccepted`). Scoring uses the explicit-tag channel because the
  official DSH adapters expose no token logprobs: the logprob channel the
  verifier prefers needs a capability the public SDK does not carry, so this
  deployment's supported channel is the tag fallback and the recorded channel
  says so.
- **Dispatch.** Every one-shot judge request goes through
  `src/host/llm-dispatch.ts`, which opens the stream with
  `prepareCall(config).stream(request)` — the registration-bound entry point
  the official agent loop itself uses — and falls back to the public
  `llm.stream(options)` only when the runtime exposes no `prepareCall`. The
  public method is an ordinary mutable instance property: a third-party provider
  plugin that replaced it with its `llm/stream` listener signature
  `(options, next)` made every acceptance raise
  `TypeError: next(...) is not a function or its return value is not async
  iterable`, which the runner recorded as a request anomaly after its two
  retries. A plugin registering on `llm/stream` is still invoked through the
  prepared dispatch; the board simply no longer depends on a property a plugin
  may legitimately replace.
- **Evidence.** The judge sees the execution's composed objective and the
  session's own event log windowed from the execution's `startedAt` — tool
  calls with their arguments, tool results (including their error flags),
  assistant prose, goal round markers and team messages — redacted with the
  verifier's patterns, capped per entry and in total, with the newest text kept
  and the truncation reported. Nothing reads the board's own bookkeeping as
  proof of work, and a reused session contributes only events after its own
  execution started. When the deployment records workspace changes, the HOST's
  own record of what the run changed on disk — the file list with its
  added/deleted counts and a bounded per-file comparison — is rendered as the
  prompt's reference-context block and folded into its delimiter token, so a
  patch the agent only described, or a file edited again afterwards, cannot pass
  as an applied edit; a deployment that serves no change service, or a failed
  read of one, degrades to the trajectory alone instead of failing the
  acceptance.
- **Budget.** Two quality acceptances plus two anomalies per EXECUTION, recorded
  on the execution record (`ExecutionRecord.verification`, ledger schema v5).
  The key is the execution, not the goal id: an agent cannot mint a new goal to
  reset the budget, and a repeated completion call, a new goal round, a plugin
  reload and a Host restart all reuse the same cycle. A rerun or a scheduled
  occurrence is a new execution with its own budget.
- **Anomalies.** A timeout, an authentication failure, an unparseable judge
  answer and an unresolvable judge route are recorded as `exception` attempts
  separately from quality verdicts, never consume the quality budget, are
  bounded, and never pass silently.
- **Freeze.** `HostExecutionRunner.launch` reports when `/goal` was armed, and
  the service freezes the contract BEFORE the prompt is queued: the judge route
  resolved from the live settings against the host model catalog default
  (`session/modelCatalog`; "inherit host" never means the card's pinned
  execution model), the applicability of this run (`enforced`,
  `goal-unavailable`, `disabled`, `team-member`), and the threshold. An
  explicitly configured reasoning level is sent only when the resolved model's
  adapter declares it; otherwise the incompatible value is dropped, the model's
  own default level is used, and the fallback is recorded and shown.
- **Settlement.** A settled `succeeded` requires a matching pass record
  whenever applicability is `enforced`. The old fallback paths therefore stop
  being able to pass a goal execution: a completed turn, a paused goal, an
  unreadable projection and a manual settle all fail without a pass record, a
  cycle the gate already closed settles from its recorded reason without waiting
  for another inspection, and a run that never became a goal run or is a team
  member is explicitly NOT enforced rather than implied to be verified.
- **Team runs.** Acceptance applies to the Lead execution, whose session
  evidence is the team summary; a teammate execution is recorded as a
  `team-member` and is not independently accepted.
- **Interface.** The settings card gains a task-acceptance section (switch on by
  default, judge model, reasoning level, and the resolved configuration), the
  running column shows executing / verifying / fixing, and each execution row
  carries its own report bound to that execution. `GET
  /api/task-board/verification` serves the resolved options and the host model
  catalog behind the board's usual loopback / authenticated-proxy guard.

## Alternatives considered

- **Import `dsh-llm-verifier/core` and call its exported primitives.** The
  plugin's exports carry `VerifierEngine`, `DEFAULT_CRITERIA`,
  `EMPTY_WORK_BASELINE` and `sessionAccepted`, but not its session
  acceptance (that is a closure inside `apply`) and not its evidence
  extractor, so a host half would still write the gate, the evidence and the
  budget. Against it: this repository's package rule keeps host halves on the
  official `@deepseek-ai/*` SDK, the plugin is not a dependency of this
  repository, and an installed third-party cell path may differ per profile. The
  algorithm is therefore mirrored, and the note records the basis (0.8.4, MIT,
  identical constants) instead of a runtime coupling.
- **Gate at `agent/turn-stopping`.** That is where the third-party verifier
  runs, but it observes a turn that already happened and can only steer
  afterwards; it cannot refuse `update_goal` before the goal service commits.
  The requirement is a gate on the completion call, so the tool lifecycle is the
  only correct seam.
- **Steer feedback instead of denying the call.** Rejected: the agent would still
  be able to mark the goal complete, and the requirement is that a completion
  claim cannot take effect without a pass record.
- **Block the goal as the only stop.** `ctx.goals.block` is used best-effort to
  stop a spent cycle from burning more rounds, but it is not the authority: a
  deployment that serves no goal service (or whose block is refused) would leave
  the execution pending forever. The recorded `failedReason`, consumed by the
  settlement guard, is what actually ends the execution.
- **Key the budget on the goal id.** An agent that creates a new goal would
  receive a fresh allowance, which is exactly the bypass the requirement names.
- **Ask the judge whether the task is "complete".** Rejected by the requirement:
  the verdict uses the A-T scale and the per-criterion threshold rule, not a
  yes/no question.
- **Automatic rubric selection.** Deferred: the first version judges with the
  coding criteria only, and the settings copy says the section is aimed at
  engineering tasks.
- **A new `data-dsh-part` value for the report.** The part enum is owned by
  the cross-repository semantic-attribute contract, so the report reuses the
  execution row's existing markup instead of extending that enum.

## Consequences

- Forced acceptance is a cost decision as much as a quality one: one acceptance
  is three criteria times two rounds (six judge requests) and one execution may
  accept twice, so a goal cycle that needs its one repair spends up to twelve
  extra requests. The switch is on by default, and the settings copy and the
  README say so.
- A deployment that serves no model catalog cannot resolve a judge route: with
  acceptance on, a completion claim is refused and recorded as an anomaly rather
  than passing silently. This is the fail-closed choice, and the anomaly is
  bounded so it cannot loop.
- The installed third-party verifier keeps its own automatic acceptance (its
  `autoVerifyMode` default is `smart`). Both judges then score the same
  session independently: this board's acceptance gates completion and the other
  only steers, and no public SDK interface lets the two share a verdict. The
  only reliable way to avoid paying twice is to disable the other plugin's
  automatic mode; the README states this as a known limitation instead of
  pretending the two are mutually exclusive.
- The ledger schema moves to v5. The migration is additive and deliberately does
  NOT stamp a contract onto an execution that was already open, so no in-flight
  run is retroactively judged. A malformed block is dropped (fail closed), and
  the import path strips it so a fabricated pass record cannot make imported work
  look accepted.
- Acceptance is not a session-level property: it belongs to one execution, so
  history, reruns and scheduled occurrences each carry their own report, and the
  per-execution contract is the reason a settings edit mid-run changes nothing
  for the run already going.
- The gate deliberately does not touch plain chat, a task pinned to
  `goalRun: false`, or a run whose `/goal` was refused: those are not goal
  executions, and their records say which case applies.

## Testing

- `tests/goal-verification-gate.spec.ts` (27 scenarios): pass on the first
  acceptance, fail-then-repair, second-failure closure with a frozen budget, a
  concurrent completion pair sharing one acceptance, a fresh budget on a rerun,
  the budget surviving a Host restart, an unparseable answer and a thrown judge
  route as anomalies with separate bounds, goal-unavailable and team-member runs
  left ungated, a frozen contract judging a run whose live settings changed,
  the two swapped rounds and their averaged criterion, session-reuse evidence
  isolation, effort fallback, an unresolvable route, a cancelled call, a settled
  execution, a malformed stored block, the host's workspace-change evidence
  reaching the judge, that evidence degrading when a comparison read fails, a
  trajectory-only prompt when the deployment records no changes, the
  reference-context block appearing only when there is host evidence, an
  acceptance that still reaches a verdict when a third-party plugin replaced the
  public `llm.stream` with its waterfall-listener signature, and the public
  method kept as the fallback for a runtime that exposes no `prepareCall`.
- `tests/goal-verification-service.spec.ts` (17 scenarios): the contract
  frozen and bound before the prompt, the switch off, `goalRun: false`, a
  refused `/goal`, an explicit route with an unsupported level, a scheduled
  run, the resolved options route, and the settlement rules (completed goal
  without a pass fails, paused goal fails, unreadable projection fails, a pass
  record settles done, a closed cycle settles without another inspection, a
  plain-turn run settles historically, a pre-feature execution is not
  retroactively enforced, the switch only affects later executions, and session
  reuse carries a new execution's own contract).
