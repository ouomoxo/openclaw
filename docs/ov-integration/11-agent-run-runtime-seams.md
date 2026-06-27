# AgentRun — OpenClaw Runtime Seams

Read-only investigation of the seams an OV-facing AgentRun adapter would consume
inside `@openclaw/agent-runtime` (merged via PR #2, on `main`). **Design only — no
code, no contract changes, no core patch.** Every claim is `path:line` in this repo.
Companion: [`12-agent-run-adapter-boundary.md`](./12-agent-run-adapter-boundary.md)
(the OV↔runtime translation layer) and OV's
`docs/control-plane/agent-run/` design set.

> **Headline.** The runtime is fully built and tested but exposes **no callable
> seam today**: the plugin `register()` is a no-op and the package has no
> `main`/`exports`. Everything below is reachable only as internal `src/*.ts`
> modules. Making the runtime drivable from an OV adapter is _additive_ (a bridge +
> a real receiver), and per the runtime's own ADR lands with **zero core patches**.

> **Consistency note.** These runtime facts are reconciled with the accepted OV
> design (OV `feat/windows-port` @ `172e9a0`, consistency PR #13). In particular the
> real `RuntimeSecurityPosture` here (§S7) is the source of truth for the OV wire
> posture: 5 derived boundary booleans + derived `productionEligible`, **no
> `credentialsIsolated`** — see the field mapping in
> [`12-agent-run-adapter-boundary.md`](./12-agent-run-adapter-boundary.md) §result.

## S0. Plugin shell — inert by design

- `index.ts:7-14` — `definePluginEntry({ id:"agent-runtime", register(){} })`; the
  body is an explicit no-op comment: _"No runtime registration yet."_
- `openclaw.plugin.json:3-6` — `"enabledByDefault": false`, `"activation": {
"onStartup": false }`; only a `runtimeRoot` config field (`:12-17`).
- `api.ts:2-3` — exports **only** SDK helpers (`definePluginEntry`,
  `OpenClawPluginApi`); **no runtime type or function is exported**.
- `package.json` — `"private": true`, _"Experimental … fixture/temp repos only, not
  production"_; no `main`/`exports` (it is a plugin, not an npm lib).

→ The adapter cannot `import` runtime functions across the package boundary today.
A future **public seam** is required: either a top-level `runtime-api.ts` barrel
(the SDK pattern) or an `ov_agent_run` bridge plugin that imports the local `src/*`
and is itself the actor. **No such seam exists yet** — this is the single biggest
"missing seam".

## S1. `runWorker` — the one execution entry point

`src/worker.ts:74-77`:

```ts
export async function runWorker(input: RuntimeRunInput, deps: WorkerDeps): Promise<WorkerRunResult>;
```

- **Input** `RuntimeRunInput` (`src/types.ts:15-36`): `version "0.1", taskId, runId,
correlationId, role "worker", repository{path, baseBranch, baseRevision?},
objective, acceptanceCriteria[], constraints[], permissions, verificationCommands[],
limits{timeoutMs, maxOutputBytes, maxProcesses?}`. **Carries `repository.path`** —
  a local path, which the wire contract must **not**; the adapter resolves
  `repositoryKey → path` (`12 §resolution`). Header is explicit: _"NOT the OV wire
  contract — an adapter will translate OV AgentRunInput into this internal shape"_
  (`types.ts:1-2`).
- **Permissions** hard-cap `gitPush:false, deployment:false` at the type level
  (`types.ts:6-13`); `validateRuntimeRunInput` rejects `network !== false`,
  `gitPush:true`, `deployment:true` (`src/input.ts`).
- **Output** `WorkerRunResult` (`src/worker.ts:63-72`): `{ runId, status:
WorkerRunStatus, changedFiles, forbiddenChanges, artifacts: RuntimeArtifact[],
verification?: VerificationReport, securityPosture: RuntimeSecurityPosture, events:
RuntimeEvent[] }`. **This is the natural source for the OV terminal result** —
  status + verification + artifacts + posture + the full event list in one return.

## S2. `WorkerDeps` — the full injection surface (what the adapter must supply)

`src/worker.ts:29-47` — `runWorker` is dependency-injected; the adapter/bridge wires
all of:

```
executor: Executor                       (S3)
worktree: { prepare, cleanup }           (per-run worktree lifecycle)
verificationRunner: VerificationRunner
makeArtifactCollector: (taskId,runId) => ArtifactCollector
outbox: OutboxStore                      (S5 — durable delivery boundary)
receiver: RuntimeEventReceiver           (S6 — only MockReceiver exists)
profile: RepositoryExecutionProfile      (S7 — trust gate)
buildEnv: (runId) => Record<string,string>
runtimeRoot, projectKey, allowedRepositoryRoots
now, uuid                                (deterministic injection for tests)
abortSignal?: AbortSignal                (S4 — cancellation)
```

→ Every external concern (executor choice, trust profile, env, outbox backend,
receiver target) is an **injection point**, not hard-wired. The adapter selects
`FakeExecutor` first and a real OV-targeting receiver instead of `MockReceiver`.

## S3. `Executor` — injection seam; deterministic fake exists, ACP unbuilt

`src/executor.ts:26-31`:

```ts
interface Executor {
  start(input: ExecutorInput): Promise<ExecutorHandle>;
  cancel(handle: ExecutorHandle): Promise<void>;
  inspect(handle: ExecutorHandle): Promise<ExecutorSnapshot>;
  collectResult(handle: ExecutorHandle): Promise<ExecutorResult>;
}
```

- `ExecutorInput` (`:4-14`): `runId, workingDirectory (the isolated worktree → ACP
cwd), objective, acceptanceCriteria, constraints, verificationCommands,
permissions, abortSignal?`.
- A deterministic **FakeExecutor** is used by tests
  (`test/runtime-harness.ts:30-57`) — the first vertical slice runs entirely on it.
- A real **ACP adapter** exists (`src/acp-executor-adapter.ts`) but its
  `getAcpSessionManager` wiring is **not built** (`index.ts:3-4` says ACP binding
  "lands with the Single Worker phase (OC-R7)"). The slice must **not** require a
  real ACP credential smoke as a CI gate.

## S4. Cancellation — `AbortSignal` → deterministic terminal

- `WorkerDeps.abortSignal` (`worker.ts:46`) threaded into the executor and
  verification; on abort the worker finalizes `status:"cancelled"` →
  `RUN_CANCELLED` (`worker.ts:107-110`) and **never auto-completes**.
- The OV cancel intent (`CANCEL_REQUESTED`) maps onto this signal; the bridge must
  observe the OV cancel flag (on claim/heartbeat/control poll) and trip the
  `AbortController`. Forced timeout (`termination:"timeout"` →
  `RUN_FAILED`/`timed-out`) is distinct from user cancel (see `12 §cancellation`).

## S5. Durable outbox — the claim/report engine (decisive for Pull)

`src/outbox.ts:19-33` — `OutboxStore` = `append / listPending / markDelivered /
markFailed / countPending`. Invariant: an event is _"durably appended BEFORE any
delivery"_ (`:5`, enforced at `worker.ts:92`). Two backings: in-memory
(`:60`) and **SQLite/WAL** (`createSqliteOutboxStore`, `:111`). Delivery is pushed by
`flushOutbox` (`:194-229`) with bounded retry + dead-letter
(`isRetryableDelivery`, `:47`).

→ This is a **claim/complete queue**, which is exactly what a Pull/report transport
needs (OV's ADR-004). The bridge reports outbox-pending events/results to OV and
marks them delivered; after an OpenClaw restart, `listPending`/`countPending` drive
re-send with idempotent ingestion on OV's side.

## S6. Receiver — only a mock exists (must add an OV-targeting one)

`src/receiver.ts:11-14` — `RuntimeEventReceiver { deliver(event): Promise<DeliveryResult> }`.
Only `createMockReceiver` (`:43`) exists; it is **idempotent** and records repeats
(`:29-31`). → The OV integration supplies a **real receiver** that POSTs the mapped
event/terminal-result to OV's report endpoint (contract-pinned, redacted), replacing
`MockReceiver`. No core change — it is just another `RuntimeEventReceiver`.

## S7. Repository trust profile + security posture — runtime-side gate

- `src/repository-profile.ts:16-39` — `gateRepositoryTrust(profile)`:
  `fixture → ok`; `trusted-local → ok only with explicit opt-in`; `untrusted →
rejected` (_"untrusted repositories are not executable in this phase"_).
  `FIXTURE_PROFILE` (`:5-11`) = no network, no dependency install, narrow
  executables, empty verification allowlist by default.
- `src/security-posture.ts:27-54` — `RuntimeSecurityPosture` is **derived**;
  `productionEligible` = AND of all five boundaries and is **always false** in the
  experimental default (`defaultExperimentalPosture`, `:46-54`); it is _"never
  settable by the model/worker"_ (`src/types.ts:52-60`). `EXPERIMENTAL_LIMITATIONS`
  (`:9-15`) enumerates the open production blockers.

→ OV records **requested permissions vs applied posture**; a mismatch ⇒ not
`SUCCEEDED`. OV's dispatch-side trust gate and OpenClaw's runtime-side gate are
**two independent guards** — both must pass.

## S8. RuntimeEvent vocabulary + monotonic sequence

`src/events.ts:5-39` — `RuntimeEventFactory` stamps a per-run monotonic `sequence`
and a unique `eventId`; envelope `{ version "0.1", taskId, runId, correlationId,
sequence, eventId, type, severity, payload, createdAt }`. Terminal kinds:
`RUN_COMPLETED|RUN_FAILED|RUN_BLOCKED|RUN_CANCELLED`; evidence/telemetry kinds:
`EXECUTOR_*, VERIFICATION_*, ARTIFACT_CREATED, COMMAND_*, WORKTREE_*, CLEANUP_*,
RUNTIME_SECURITY_POSTURE_RECORDED`. → The adapter maps a **minimized** subset to OV
canonical events (`12 §mapping`); high-frequency `COMMAND_*`/telemetry is **not**
forwarded as canonical state.

## S9. Recovery — diagnose only, never auto-complete

`src/worker.ts:266-281` — `inspectRecovery({ runId, worktreeDir, outbox,
executorState })` → `running | orphaned | unknown` from `executorAlive` +
`worktreeExists` + `outbox.countPending()`. Doc: _"Never auto-completes; unknown is
reported as such."_ → Maps to OV's `LOST`/recovery-grace handling; the bridge never
re-executes the same attempt silently.

## S10. Artifact descriptors — already OV-ready, descriptor-only

`src/types.ts:78-89` — `RuntimeArtifact { artifactId, taskId, runId, type,
relativePath, sha256, sizeBytes, mimeType?, createdAt }`; _"never an absolute host
path"_ (`:83`). SHA-256 over the stored (redacted, capped) bytes
(`src/artifact-collector.ts:82`). → Supplies every field OV's
`RuntimeArtifactDescriptor` needs; the adapter maps `relativePath` → an opaque
`storage.reference` (never a host path).

## Reusable seams (build the adapter onto these)

`runWorker` single entry · `Executor` injection + deterministic `FakeExecutor` ·
durable **claim-style outbox** · `RuntimeEventReceiver` injection · trust profile +
derived posture (always non-production) · RuntimeEvent vocab + monotonic sequence ·
`RuntimeArtifact` descriptor · `inspectRecovery` · `AbortSignal` cancellation ·
ov-bridge's `ov_create_task` tool pattern as the bridge template.

## Missing seams (must be built — additive, no core patch)

A **public/exported runtime seam** (barrel or `ov_agent_run` bridge) · a **real
OV-targeting `RuntimeEventReceiver`** (only `MockReceiver` exists) · the
`AgentRunDispatch → RuntimeRunInput` **adapter** incl. `repositoryKey → path`
resolution · **ACP wiring** (`getAcpSessionManager`, deferred) · a fixed wire
contract pinned by exact SHA.

## Core-patch assessment

Per the runtime's own ADR (`docs/ov-integration/ADR-runtime-executor.md`), backing
the outbox/report path and adding an `ov_agent_run` bridge + real receiver lands
with **zero core (`src/**`) patches\*\* — it is all new plugin/extension surface plus
the injected receiver. ACP binding is additive and currently unbuilt.
