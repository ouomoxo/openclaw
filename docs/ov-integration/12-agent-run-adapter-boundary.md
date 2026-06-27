# AgentRun — Adapter Boundary (OV ↔ OpenClaw Runtime)

The translation layer between OV's canonical AgentRun wire contract and OpenClaw's
internal runtime. **Design only — no code, no contract changes, no core patch.**
Companion: [`11-agent-run-runtime-seams.md`](./11-agent-run-runtime-seams.md) (the
runtime seams) and OV's `docs/control-plane/agent-run/04-contract-shape.md` (wire
shapes). `path:line` references are to this repo unless prefixed `OV:`.

> **Principle.** The OV wire DTO and the OpenClaw `RuntimeRunInput` are deliberately
> **different shapes** (`src/types.ts:1-2`). The adapter is the _only_ place the two
> meet. It is the security choke point: it resolves `repositoryKey → path`, refuses
> anything non-fixture, and never lets a host path or a host secret cross either way.

## Where the adapter lives

The recommended realization (OV ADR-004 = Pull/Claim via an `ov_agent_run` bridge,
mirroring `extensions/ov-bridge`): the **bridge plugin is the adapter**. It:

1. claims a runnable AgentRun from OV (`OV: POST /runs/claim`);
2. translates the claim's `AgentRunDispatch` → `RuntimeRunInput`;
3. drives `runWorker(input, deps)` (`src/worker.ts:74`) with `FakeExecutor` first;
4. maps the `WorkerRunResult` + emitted `RuntimeEvent`s → OV report calls;
5. reports through a real `RuntimeEventReceiver` (replacing `MockReceiver`).

No runtime `src/*` is modified; the bridge imports the runtime's internal modules
(or a future `runtime-api.ts` barrel — the missing public seam, `11 §S0`).

## §dispatch translation — `AgentRunDispatch` → `RuntimeRunInput`

| OV wire (`OV: 04 §dispatch`)                                    | OpenClaw internal (`src/types.ts:15-36`)             | Rule                                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository.repositoryKey`                                      | `repository.path`                                    | **resolved** via the bridge's allowlist (`WorkerDeps.allowedRepositoryRoots`, `worker.ts:43`); unknown key → refuse, never execute                               |
| `repository.baseRevision`                                       | `repository.baseRevision` (+ `baseBranch`)           | required; leading-dash rejected by worktree prep                                                                                                                 |
| `agentRunId / attemptId / taskId / correlationId`               | `runId` (= per-attempt) `/ taskId / correlationId`   | `runId` is OpenClaw's per-attempt execution id; `agentRunId/attemptId` are echoed back on every report, never invented here                                      |
| `objective / acceptanceCriteria / verificationCommands`         | same                                                 | pass-through                                                                                                                                                     |
| `permissions{ network:false, gitPush:false, deployment:false }` | `permissions` (same caps, type-enforced)             | `validateRuntimeRunInput` re-rejects `network/gitPush/deployment = true` (`src/input.ts`) — **defense in depth**, even though the wire type already forbids them |
| `limits{ timeoutMs, maxOutputBytes }`                           | `limits{ timeoutMs, maxOutputBytes, maxProcesses? }` | pass-through                                                                                                                                                     |

**Never** does a host path travel on the wire: OV sends `repositoryKey`; the adapter
is the sole resolver. **Never** does the model/worker influence `securityPosture`
(`11 §S7`).

## §profile selection — trust gate (two independent guards)

The adapter chooses a `RepositoryExecutionProfile` (`src/repository-profile.ts`) for
the resolved repo. First slice = `FIXTURE_PROFILE` (`:5-11`) only. `runWorker` calls
`gateRepositoryTrust` (`:16-39`) internally and the adapter **also** refuses a
non-fixture dispatch before calling `runWorker`. OV refuses dispatch-side too
(`OV: 04 §repository-resolution`). Three guards, all must pass: OV dispatch gate →
adapter pre-check → runtime `gateRepositoryTrust`.

## §result translation — `WorkerRunResult` → OV terminal result

`WorkerRunResult` (`src/worker.ts:63-72`) is the single source:

| OpenClaw                              | OV `RuntimeTerminalResult` (`OV: 04 §result`)    | Rule                                                                                                                          |
| ------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `status` (`WorkerRunStatus`)          | `status: succeeded\|failed\|blocked\|cancelled`  | `completed → succeeded` **only if** verification evidence consistent (else `failed`); `blocked/cancelled/failed` map directly |
| `verification` (`VerificationReport`) | `verification: VerificationEvidenceDescriptor[]` | required-and-passed is the **success gate** (OV invariant 5)                                                                  |
| `artifacts: RuntimeArtifact[]`        | `artifacts: RuntimeArtifactDescriptor[]`         | `relativePath` → opaque `storage.reference`; **no host path**                                                                 |
| `securityPosture`                     | `securityPosture`                                | verbatim derived posture; OV compares requested vs applied                                                                    |
| `forbiddenChanges`                    | (→ `failed` + `blockers[]`)                      | a forbidden change present ⇒ never `succeeded`                                                                                |
| `events: RuntimeEvent[]`              | mapped per `§event-mapping`                      | source for incremental `ReportAgentRunEvent`s                                                                                 |

The adapter **must not** self-declare success: it forwards evidence; OV's decider
applies the 11-point success invariant (`OV: 04 §success`). `Worker completed ≠ Task
completed` and `≠ AgentRun SUCCEEDED` until OV validates.

## §event-mapping — runtime event → OV reported event (minimized)

Forward only the canonical-relevant subset (`11 §S8`); drop high-frequency
telemetry:

| RuntimeEvent (`src/events.ts`)                            | OV reported type (`OV: 04 §event`)                |
| --------------------------------------------------------- | ------------------------------------------------- |
| `RUN_RECEIVED` / claim taken                              | `run.accepted`                                    |
| `EXECUTOR_STARTED`                                        | `run.started`                                     |
| `VERIFICATION_PASSED/FAILED`                              | `run.verification_completed`                      |
| `ARTIFACT_CREATED`                                        | `run.artifact_available`                          |
| `RUN_BLOCKED`                                             | `run.blocked`                                     |
| `RUN_FAILED`                                              | `run.failed`                                      |
| `RUN_CANCELLED`                                           | `run.cancelled`                                   |
| `RUN_COMPLETED`                                           | (terminal → `ReportAgentRunResult`, not an event) |
| `COMMAND_* / WORKTREE_* / CLEANUP_* / EXECUTOR_COMPLETED` | **not forwarded** (operational telemetry)         |

The per-run monotonic `sequence` + `eventId` (`events.ts:5-39`) become the OV
ingestion idempotency key `(agentRunId, attemptId, eventId/sequence)`.

## §idempotency — adapter responsibilities

The adapter relies on the durable outbox (`11 §S5`) for at-least-once delivery and on
OV for dedup. It must: (1) send each event/result with its stable `eventId`/
`resultId` so OV dedups (`OV: 04 §idempotency`); (2) on OpenClaw restart, re-send
`listPending` items — OV treats redelivery as a no-op; (3) re-claim of the same
dispatch returns the same lease and **does not** start a second `runWorker` (one
attempt = one `runWorker` invocation, keyed by `dispatchId`/`runId`).

## §cancellation — OV intent → AbortSignal

OV `CANCEL_REQUESTED` is observed by the bridge on claim/heartbeat/control poll
(transport leg, OV ADR-004); the bridge trips an `AbortController` whose signal is
`WorkerDeps.abortSignal` (`worker.ts:46`). The worker finalizes `RUN_CANCELLED`
(`worker.ts:107-110`); the adapter maps it to `run.cancelled` → OV `CANCELLED`.
Distinct from forced timeout (`termination:"timeout"` → `RUN_FAILED`). The first
slice may leave actual cancel execution stubbed but the mapping is fixed.

## §recovery — restart handling

On bridge/runtime restart the adapter calls `inspectRecovery` (`11 §S9`) →
`running|orphaned|unknown` and reports it to OV, which decides
`LOST`/recovery-grace/reclaim (`OV: 03 §loss`). The adapter **never** auto-re-executes
an attempt; a reclaim is a new `attemptId` driven by an explicit OV command.

## §secrets & redaction — the choke point

The bridge reuses ov-bridge's redaction discipline (`extensions/ov-bridge`): no
secret value or host path in any reported event/artifact/result; artifact bytes stay
local (descriptor-only). `buildEnv` (`worker.ts:40`) supplies a sanitized, host-env
**replacing** environment to child commands (never merges `process.env`). The
contract is pinned by exact SHA in both repos (`OV: 04 §release`).

## What this boundary deliberately excludes (first slice)

ACP real executor as a required gate · planner/reviewer · `git push` / deploy ·
network · artifact byte upload · automatic retry/reclaim · automatic Task
completion · any OV DB access from OpenClaw (and vice-versa). The adapter is the
_only_ cross-system seam; neither side reads the other's database.
