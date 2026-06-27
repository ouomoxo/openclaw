# 10 · Agent Execution Runtime 설계 (조사 + 설계)

> 병렬 트랙 "안전한 Agent Execution Runtime". 브랜치 `feat/agent-execution-runtime`(origin/main 기반, ov-bridge와 분리).
> 2026-06-28 읽기 전용 조사 결과 종합. 모든 인용은 repo-root 기준 `path:line`. **코드 작성 전 설계 문서.**
> 결정 요약은 [ADR-runtime-executor.md](./ADR-runtime-executor.md). (ov-bridge 측 문서 00–09는 `feat/ov-bridge-create-task` 브랜치.)

## 0. 범위와 원칙

OpenClaw는 OV를 대체하는 Orchestrator가 아니다. 이번 트랙은 **단일 실행 경로**만 선행 구현한다:

```
Mock RuntimeRunInput → Worker → Worktree → ACP Executor → Verification → Artifact → Runtime Event → Outbox → Mock Receiver
```

OpenClaw는 Run 결과만 보고하고 **Task 완료를 확정하지 않는다**. `taskId`/`runId`/`correlationId`는 외부 입력.
**core(`src/**`) 수정 0** — 조사 결과 OV 연동 MVP와 마찬가지로 이번 런타임도 **플러그인 seam만으로 구현 가능**하다(아래 §1).

## 1. 핵심 발견 — core 패치 없이 플러그인으로 가능

| 능력 | 플러그인 도달 seam | core 패치 |
|------|---------------------|-----------|
| ACP 코딩 에이전트(Codex) 실행 | `openclaw/plugin-sdk/acp-runtime` → `getAcpSessionManager` | **불필요** |
| 명령 실행(verification) | `openclaw/plugin-sdk/run-command` → `runPluginCommandWithTimeout` | **불필요** |
| Sandbox 격리(docker) | `openclaw/plugin-sdk/sandbox` → `requireSandboxBackendFactory` 등 | **불필요**(한계는 §5) |
| 영속 outbox | `api.runtime.state.openChannelIngressQueue` 또는 전용 SQLite | **불필요** |
| 영속 KV | `api.runtime.state.openKeyedStore` | **불필요** |
| 백그라운드 루프 | `api.registerService({start,stop})` | **불필요** |

→ 런타임 코어는 **순수 TS 라이브러리 모듈**로 `extensions/agent-runtime/src/**`에 두고, gateway 없이 vitest로 테스트
(workboard 패턴, §8). ACP/명령 실행 등 런타임 의존부는 좁은 인터페이스로 **주입**하고 wiring 레이어에서만 실제 seam에 바인딩.

## 2. ACP Executor 매핑 (재사용, 신규 harness 금지)

ACP 하네스가 Executor 역할. **`getAcpSessionManager`**(`src/plugin-sdk/acp-runtime.ts:6`, 이미 discord/telegram 플러그인이 사용)로 도달.

| Executor 메서드 | ACP 호출 (`path:line`) |
|------------------|------------------------|
| `start(input)` | `getAcpSessionManager()` → `initializeSession({ sessionKey:=runId, agent:"codex", mode, cwd:=workingDirectory, backendId:"acpx", runtimeOptions:{ timeoutSeconds } })` (`src/acp/control-plane/manager.core.ts:148`; cwd plumb `manager.initialize-session.ts:43-67`) → `runTurn({ sessionKey, text:=프롬프트, mode:"prompt", requestId, signal, onEvent })` (`manager.core.ts:289`, stream `manager.turn-runner.ts:228`) |
| `cancel(handle)` | `cancelSession({ sessionKey, reason })`(`manager.core.ts:319` → abort + `runtime.cancel`, `manager.cancel-session.ts:75`) **+ `closeSession`**(`manager.core.ts:341`)로 프로세스 트리 종료 |
| `inspect(handle)` | `getSessionStatus({ sessionKey })`(`manager.core.ts:173`) / `getObservabilitySnapshot`(`:115`) |
| `collectResult(handle)` | 권장: raw runtime `initializeSession().runtime.startTurn(input).result` → 타입드 `AcpRuntimeTurnResult`(`packages/acp-core/src/runtime/types.ts:137,154`). 또는 `onEvent` `done`/`error` 누적 후 `buildAgentRunTerminalOutcome`(`src/agents/agent-run-terminal-outcome.ts:98`)로 정규화 |

**cwd**: 세션 단위(`AcpRuntimeEnsureInput.cwd` `packages/acp-core/src/runtime/types.ts:47`). **per-turn cwd 없음** → 1 Run = 1 세션 = 1 worktree. acpx가 cwd로 세션 재사용 키잉(`extensions/acpx/src/runtime.ts:907`).
**Codex**: agent id `"codex"`, `@zed-industries/codex-acp`(`extensions/acpx/src/runtime.ts:336,467`). 신규 provider adapter 만들지 않음.
**timeout**: acpx는 자체 timeout 0으로 두고(`withOpenClawManagedTurnTimeout` `extensions/acpx/src/runtime.ts:75`), manager가 `runtimeOptions.timeoutSeconds`로 강제(`manager.turn-timeout.ts:15,34`).

### ACP가 주지 않는 것 (adapter가 메워야 함) — 중요
1. **구조화 입력 없음.** turn 입력은 `text`(+이미지)뿐(`manager.types.ts:61`). `objective`/`acceptanceCriteria`/`constraints`/`verificationCommands`를 **프롬프트 brief로 직렬화**. `permissions`는 acpx config + `setSessionRuntimeMode`(`manager.core.ts:201`)로.
2. **artifact/파일 이벤트 없음.** 스트림은 text/tool/status만. 변경 파일은 turn 후 **worktree를 직접 스캔**(§7).
3. **verification 미실행.** harness는 검증 명령을 돌리지 않음 → adapter가 `collectResult` 후 직접 실행(§4·§6).
4. **manager.runTurn은 void** — 구조화 결과는 raw runtime `startTurn().result`로.
5. **cancel vs kill 비대칭**: persistent 세션의 `cancelSession`은 graceful cancel일 뿐, codex 자식 트리 종료는 `closeSession` 필요(§9).

## 3. Runtime Input (내부 모델, OV 계약 아님)

지시서 §6의 `RuntimeRunInput`(`version:"0.1"`, `role:"worker"`, repository{path,baseBranch,baseRevision?}, objective, acceptanceCriteria[], constraints[], permissions{filesystem:"workspace-write", shell, network, gitCommit, gitPush:false, deployment:false}, verificationCommands[], limits{timeoutMs, maxOutputBytes, maxProcesses?})를 그대로 내부 타입으로 구현.
- OV wire contract로 간주하지 않음. 이후 adapter가 OV AgentRunInput → RuntimeRunInput 변환.
- repository.path는 **allowlist 검증**(§9). `gitPush`/`deployment`는 항상 false. taskId/runId/correlationId 필수.

## 4. Command / Verification Runner (재사용)

**`runPluginCommandWithTimeout`**(`openclaw/plugin-sdk/run-command`, core `src/process/exec.ts:341` `runCommandWithTimeout` 래핑)를 재사용. **신규 CommandRunner 만들지 않음.**
- `spawn(executable, args)` — **shell 비사용**(`src/process/exec.ts:370`, injection-safe). `exec("string interpolation")` 금지 자동 충족.
- timeout(124), no-output-timeout, `maxOutputBytes`(기본 16MB ring-buffer), AbortSignal, cwd, env, exit-code↔signal 구분(`src/process/exec.ts:210-221,564-617`).

**VerificationRunner**(지시서 §13)는 이 runner 위의 얇은 래퍼: 입력 순서 유지, `skipped≠passed`, 필수 검증 1개 실패 시 Run completed 불가, timeout→failed/blocked 명시, 모델 요약과 실제 exitCode 불일치 시 **exitCode 우선**. 결과는 `VerificationEvidence`(stdout/stderr는 Artifact로).

**Command Allowlist**(§12): RepositoryExecutionProfile의 `allowedExecutables` ∩ RuntimeRunInput의 verificationCommands만 실행. 모델이 임의 executable 추가 불가. 초기 후보: git/npm/pnpm/node/npx/cargo/rustc/tsc/vitest/eslint/oxlint.

## 5. Sandbox — 실제 한계 (정직하게 명시)

Sandbox는 `openclaw/plugin-sdk/sandbox`(`src/plugin-sdk/sandbox.ts:4-61`)로 도달: `requireSandboxBackendFactory("docker")`, `buildExecSpec`, `runShellCommand`, `sanitizeEnvVars`, `resolveSandboxRuntimeStatus`. **새 컨테이너 시스템 만들지 않음.**

**⚠️ 핵심 한계 — ACP 워커는 오늘 기준 컨테이너 밖에서 돈다:**
- Codex/ACP **app-server는 호스트에서 full host env로 spawn**됨(`extensions/codex/src/app-server/transport-stdio.ts:52-114` — `process.env` 통째 복사, `sanitizeEnvVars` 미적용). docker sandbox는 **OpenClaw 자체 exec 도구**만 감싼다(`bash-tools.exec-runtime.ts:748-772`).
- 세션이 sandboxed면 Codex **native exec는 차단**(sandbox 아님)됨(`sandbox-guard.ts:49-157`). 컨테이너로 라우팅하려면 실험적·버전게이트 `appServer.experimental.sandboxExecServer`(`config.ts:438`, 기본 off).
- docker 기본값: `mode:off`(`config.ts:255`), `workspaceAccess:none`(`:258`), `--user` 없음→컨테이너 내 root 가능(`config.ts:121`), pids/mem/cpu 제한 없음(`:125-130`). `--read-only`+`--network none`+`cap drop ALL`+`no-new-privileges`는 기본 적용(`docker.ts:441-470`).

**대응(§10 정책 — core 패치 없이 adapter 레벨):**
1. **호스트 env 누출이 가장 큰 위험.** 우리 런타임은 ACP 세션을 띄우기 전/명령 실행 시 `sanitizeEnvVars`(`openclaw/plugin-sdk/sandbox`)로 정제한 **명시적 env allowlist**만 전달. SSH/GitHub/OV/Telegram/모델 토큰 전달 금지.
2. verification 명령은 `runPluginCommandWithTimeout`로 **network 기본 deny**, 명시 env, cwd=worktree로 실행.
3. docker sandbox를 verification 실행에 적용할지는 옵션(현 한계상 ACP 모델 프로세스 자체는 격리 못 함을 문서화). 부족분은 이 문서에 한계로 남기고 **core patch 하지 않음**.
4. 금지(지시서 §10): 전체 host env/SSH key/토큰/shell history/home mount 전달. `validate-sandbox-security.ts`가 민감 경로 bind를 차단.

## 6. Runtime Event + Durable Outbox

이벤트 envelope = 지시서 §15 `RuntimeEvent`(`version:"0.1"`, eventId, taskId, runId, correlationId, **sequence**(Run 내부 단조 증가), type, severity, payload, createdAt). 초기 이벤트 18종(RUN_RECEIVED … WORKTREE_CLEANUP_COMPLETED). ULID/timestamp 순서에 의존하지 않음.

**Outbox 후보 비교:**
| 옵션 | seam | durable | sequence | 결합도 | 평가 |
|------|------|---------|----------|--------|------|
| **`openChannelIngressQueue`** | `src/plugins/runtime/types-core.ts:381`, 구현 `src/channels/message/ingress-queue.ts:339` | ✅ 공유 SQLite WAL | ✅ FIFO+claim+dedupe+prune | 중(plugin-scoped 테이블) | **권장** — enqueue/claimNext/complete/fail/dedupe가 이미 outbox 형태. core 패치 0 |
| 전용 SQLite(workboard식) | `openclaw/plugin-sdk/state-paths`(`resolveStateDir`) + `plugin-state-runtime` | ✅ | ✅ 자체 AUTOINCREMENT seq | 강(독립 파일) | 스키마/수명이 안 맞을 때. 코드 더 많음(`extensions/workboard/src/sqlite-store.ts:45`) |
| `openKeyedStore` | `types-core.ts:374` | ✅ | ✗(순서 없음, TTL/maxEntries eviction) | 중 | outbox 부적합 |
| file/JSONL | — | 부분 | 수동 | — | **금지**(`AGENTS.md:77`) |

→ **1차: `openChannelIngressQueue`**(재사용 최대, core 0). 스키마가 부족하면 전용 SQLite로 승격.
**Retry**(지시서 §17): network/429/502/503/504 재시도; schema-invalid/auth/forbidden/permanent는 dead-letter. exp backoff + jitter + max attempts + nextAttemptAt, 재시작 후 pending 복구. 이번엔 OV wire schema 고정 안 함 — **Mock Receiver**(`RuntimeEventReceiver.send`)만.

## 7. Artifact Collector

지시서 §14 `RuntimeArtifact`(artifactId, taskId, runId, type, relativePath, sha256, sizeBytes, mimeType?, createdAt). 수집: git diff/status, changed files, commit hash, branch, test/lint/typecheck/build output, executor summary.
규칙: **절대 host path 노출 금지**(relativePath만), SHA-256, 크기 제한, **symlink traversal 차단**(`src/agents/sandbox/fs-bridge-path-safety.ts:78` `assertPathSafety` 재사용), workspace 밖 수집 금지, secret pattern redaction, 큰 artifact는 metadata만 이벤트에. Store: `<runtime-root>/artifacts/<taskId>/<runId>/`.
**ACP가 파일 이벤트를 안 주므로**(§2-2) turn 종료 후 worktree를 `git status`/`git diff`로 스캔해 changed files를 도출.

## 8. Worktree Manager (신규, 얇게)

재사용 라이브러리 없음 → `src/infra/update-runner.ts`의 검증된 argv를 미러링한 얇은 모듈 BUILD:
- 생성: `git -C <gitRoot> worktree add -b agent/<taskId>/<runId> <dir> <baseSha>`(cf. `update-runner.ts:1185`의 `worktree add --detach`, branch-per-run은 `scripts/pr-lib/worktree.sh:55`).
- 제거: `worktree remove --force`(`update-runner.ts:1325`), `prune`(`:1345`), 실패 정리 `fs.rm`(`:302`).
- git 실행은 `runCommandWithTimeout`(argv, no shell). repo root: `findGitRoot`(`src/infra/git-root.ts:38`).
경로: `<runtime-root>/workspaces/<project-key>/<taskId>/<runId>/`, branch `agent/<taskId>/<runId>`.
**금지**(지시서 §9): main working tree 수정, 사용자 branch 강제 checkout, `git reset --hard`, `git clean -fd`, force/remote push, baseRevision 불일치 무시. baseRevision 제공 시 실제 HEAD와 일치 검증, 불일치면 **blocked 반환**.
**격리는 내재적**: 모든 git 작업이 `git -C <root>`로 별도 dir에 수행되어 main tree를 건드리지 않음. 경로 confine은 `src/infra/boundary-path.ts`/`path-alias-guards.ts` 재사용.

## 9. 변경 파일 정책 + repository allowlist (지시서 §21)

worktree 밖 수정/허용 범위/symlink escape/`.git` 직접 변경/binary 생성/과대 파일/secret-like 파일 검사. 무조건 차단: `.env`, `*.pem`, `*.key`, `id_rsa`, `credentials*`, `secrets*`. repository별 예외는 profile에서만.
repository.path는 RepositoryExecutionProfile allowlist로 검증(`networkAllowed`, `allowedExecutables`, `allowedVerificationCommands`).

## 10. Cancellation (지시서 §18)

`cancel(runId)` → AbortController abort → `cancelSession`(graceful) **+ `closeSession`**(SIGTERM→750ms→SIGKILL 자식 트리, `extensions/acpx/src/process-reaper.ts:271-299`) → active 명령 terminate → verification 중지 → RUN_CANCELLED → 가능한 artifact 수집 → cleanup policy. `ExecutorInput.abortSignal`은 turn 신호에 bridge됨(`manager.turn-runner.ts:202-208`). 규칙: cancel 후 retry 금지, completed Run cancel 금지, idempotent.

## 11. Recovery (지시서 §19)

재시작 후 조사: worktree 존재 / executor process 존재(`getSessionStatus`) / outbox pending / artifact dir / run metadata. `RecoveredRunState{status: running|orphaned|completed|unknown, ...}`. executor 살아있으면 재연결 조사, workspace만 있으면 orphaned, **임의 completed 금지**, unknown은 blocked 보고 준비만, 자동 재실행 안 함. ACP liveness 레지스트리는 SDK 밖(`src/acp/control-plane/active-turns.ts:5`)이라 adapter가 in-flight 상태를 자체 추적.

## 12. Single Worker Run (지시서 §20) + 성공 조건

순서: input validation → repository/profile validation → run metadata → worktree prepare → RUN_PREPARING → executor start → 결과 수집 → changed files 검사 → verification 실행 → artifacts 수집 → structured result → RUN_COMPLETED/FAILED/BLOCKED → outbox flush → cleanup.
**성공 = executor completed ∧ 필수 verification 전부 passed ∧ artifact 수집 성공 ∧ 금지 변경 없음.** 모델이 "완료"라 해도 미충족이면 completed 아님(증거 기반).

## 13. Planner / Reviewer (후속)

Single Worker 안정화 후. Planner(코드 미수정, read-only) `PlannerResult`, Reviewer(write 없음, 별도 session/모델 policy) `ReviewerResult`. 내부 fixture로 검증, 아직 OV 계약으로 안 보냄. Reviewer pass도 Task 완료 확정 아님.

## 14. 패키징 & 첫 Worker E2E 테스트 구조

**위치**: `extensions/agent-runtime/`(번들 플러그인, workboard 패턴). 파일: `openclaw.plugin.json` + `package.json`(`openclaw.extensions:["./index.ts"]`) + `index.ts`(`definePluginEntry`) + `api.ts` + `runtime-api.ts` + `src/**`(+ colocated `*.test.ts`). tsconfig 불필요.
**순수 lib(gateway 없이 vitest)**: input · worktree · command · verification · artifacts · events · outbox · worker(주입된 `{run}`·`Executor` 인터페이스 위). ACP 실제 실행만 wiring에서 `getAcpSessionManager` 기반 구현에 바인딩, 테스트는 mock.
**첫 Worker E2E(Mock Orchestration, §24)**:
```
test/fixtures/repositories/simple-ts-project/  (원본 불변)
→ temp dir 복사 → Fixture RuntimeRunInput
→ Worker Runtime → real temp git worktree → (mock 또는 real ACP) Executor
→ 파일 변경 → real verification(runPluginCommandWithTimeout) → Artifact(sha256)
→ RuntimeEvent → Outbox(openChannelIngressQueue) → Mock Receiver
→ 재시작 시뮬 → pending 복구 → cancel → 프로세스 종료 → Reviewer evidence
```
실제 ACP 모델 호출은 비결정적이므로 첫 E2E는 **Executor를 mock**(파일 변경+이벤트를 시뮬)으로 돌려 worktree/verification/artifact/outbox/recovery/cancel 경로를 검증하고, 실제 Codex ACP 연결은 별도 opt-in live 테스트로 둔다.

## 15. 재사용 / 신규 / 미구현 요약 (§33 요구)

- **재사용**: ACP(`getAcpSessionManager`), 명령 실행(`runPluginCommandWithTimeout`/`src/process/exec.ts`), sandbox backend(`openclaw/plugin-sdk/sandbox`), outbox(`openChannelIngressQueue`), KV(`openKeyedStore`), path-safety(`fs-bridge-path-safety`/`boundary-path`), git root(`git-root`), worktree argv 패턴(`update-runner.ts`).
- **신규 adapter(얇게)**: AcpExecutorAdapter, WorktreeManager, VerificationRunner(runner 래퍼), ArtifactCollector, RuntimeEvent/Outbox 어댑터, WorkerRuntime, Mock Receiver, RuntimeRunInput 검증.
- **미구현(중복 금지)**: 새 컨테이너 시스템, 새 command exec, 새 ACP harness/provider, 새 영속 계층.
- **core patch**: **불필요**(모든 seam이 공개 SDK). 유일한 잔여 한계는 ACP app-server 호스트 env 격리 부재 — adapter env allowlist로 완화하고 한계로 문서화.

## 16. 단계 (OC-R1~R10)

R1 조사+ADR(본 문서) → R2 Runtime Core(input/Executor/AcpExecutorAdapter) → R3 Worktree → R4 Command/Verification → R5 Artifact → R6 Event/Outbox → R7 Single Worker → R8 Planner/Reviewer schema → R9 Mock orchestration E2E → R10 독립 리뷰(`docs/ov-integration/reviews/runtime-execution-review.md`).
Draft PR은 R1(문서)+R2(Executor)+R3(Worktree) 시점, Worker 미완성 명시(지시서 §28).
