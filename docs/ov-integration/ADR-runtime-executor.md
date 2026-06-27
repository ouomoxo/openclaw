# ADR · Agent Execution Runtime — Executor & 패키징 결정

> Status: **Accepted (설계 단계)** · Date: 2026-06-28 · Branch: `feat/agent-execution-runtime`
> 근거 조사·상세 설계는 [10-runtime-execution-design.md](./10-runtime-execution-design.md). 모든 인용은 `path:line`.
> 이 ADR은 Runtime Core 구현 전 고정해야 할 아키텍처 결정만 담는다.

---

## ADR-1. Executor seam = `getAcpSessionManager` (plugin-sdk), core 패치 없음

**Context.** 외부 AgentRun을 코딩 에이전트(Codex)로 실행해야 한다. 후보 seam: (a) `api.runtime.subagent.run`(고수준,
gateway 주입), (b) `openclaw/plugin-sdk/acp-runtime`의 `getAcpSessionManager`(ACP 제어), (c) core `src/agents/acp-spawn.ts`(플러그인 도달 불가).

**Decision.** **(b) `getAcpSessionManager`**(`src/plugin-sdk/acp-runtime.ts:6`)를 사용한다. `AcpExecutorAdapter`는 플러그인 안에 둔다.

**Why.** `subagent.run`은 **cwd를 노출하지 않는다**(`src/plugins/runtime/types.ts:81`). 우리는 worktree별 cwd가 필수이므로
`initializeSession({ cwd, agent:"codex", runtimeOptions:{timeoutSeconds} })`(`src/acp/control-plane/manager.core.ts:148`,
cwd plumb `manager.initialize-session.ts:43-67`)가 필요하다. 이 seam은 이미 discord/telegram 플러그인이 사용하며(`extensions/discord/src/monitor/provider-session.runtime.ts:2`), **core 패치/신규 SDK seam 불필요**. (c)는 extensions 경계 위반(`extensions/CLAUDE.md`).

**Consequences.** ACP 실제 실행은 gateway/backend(acpx 등록) 필요 → 순수 vitest에 없음. 따라서 Executor를 **좁은 주입 인터페이스**
(`Executor{start,cancel,inspect,collectResult}`)로 추상화하고, 실제 `getAcpSessionManager` 구현은 wiring 레이어에서만 바인딩, 테스트는 mock.

---

## ADR-2. 구조화 입력·검증·artifact는 adapter가 메운다 (harness가 안 줌)

**Context.** ACP turn 입력은 자유 텍스트뿐(`manager.types.ts:61`); harness는 verification을 돌리지 않고 파일 변경 이벤트도 주지 않는다.

**Decision.**
- `objective`/`acceptanceCriteria`/`constraints`/`verificationCommands`/`permissions`를 **프롬프트 brief로 직렬화**해 turn `text`로 전달. permissions는 acpx config + `setSessionRuntimeMode`(`manager.core.ts:201`)로.
- 변경 파일은 turn 종료 후 worktree를 `git status`/`git diff`로 **직접 스캔**.
- **verification 명령은 adapter가 직접 실행**(아래 ADR-3).

**Why.** `AcpRuntimeTurnInput`에 구조화 필드/검증/artifact 모델이 없음(조사 §2). 증거 기반 성공 판정을 harness에 위임할 수 없다.

---

## ADR-3. Command/Verification = `runPluginCommandWithTimeout` 재사용, 신규 runner 금지

**Context.** 검증 명령을 안전하게(shell injection 없이) 실행해야 한다.

**Decision.** `openclaw/plugin-sdk/run-command`의 **`runPluginCommandWithTimeout`**(core `src/process/exec.ts:341` 래핑)을 재사용한다. 새 CommandRunner를 만들지 않는다. VerificationRunner는 그 위의 얇은 래퍼.

**Why.** 이미 `spawn(executable, args)`(no shell, `src/process/exec.ts:370`) + timeout + `maxOutputBytes`(16MB) + AbortSignal +
cwd + env + exit/signal 구분을 제공하고 **플러그인 도달 가능**. 병행 구현은 `src/process/exec.ts`의 하드닝(프로세스 트리 kill, no-output-timeout, ring-buffer)을 잃는다.

**Consequences.** `exec("문자열 보간")` 사용처가 생기지 않음(지시서 §11 자동 충족). 명령 allowlist ∩ 입력 verificationCommands만 실행.

---

## ADR-4. Sandbox는 재사용하되, ACP 워커 격리 한계를 수용·문서화한다 (core 패치 안 함)

**Context.** docker sandbox는 플러그인 도달 가능(`openclaw/plugin-sdk/sandbox`)하나, **Codex/ACP app-server는 호스트에서 full host env로 실행**된다(`extensions/codex/src/app-server/transport-stdio.ts:52-114`). docker는 OpenClaw 자체 exec만 감싼다. 기본값은 `mode:off`·`--user` 없음·자원 제한 없음.

**Decision.**
- 새 컨테이너 시스템을 만들지 않고 기존 backend(`requireSandboxBackendFactory`)를 재사용.
- ACP 모델 프로세스 자체의 컨테이너 격리는 **이번 범위에서 보장하지 않는다**(한계로 수용). 대신:
  - ACP 세션·명령 실행 env를 `sanitizeEnvVars`(`openclaw/plugin-sdk/sandbox`)로 정제한 **명시적 allowlist**만 전달 — SSH/GitHub/OV/Telegram/모델 토큰 주입 금지.
  - verification 명령은 cwd=worktree, network 기본 deny, 명시 env로 실행.
- 부족분(앱서버 host-env 격리, `--user`, 자원 제한)은 **core patch로 해결하지 않고** 본 ADR/설계 문서에 한계로 명시. 추후 upstream 기여 또는 sandboxExecServer(실험적, 버전게이트) 검토는 backlog.

**Why.** 격리 강화를 위한 core 수정은 "core 수정 0" 원칙·리뷰 위험을 위반. 가장 큰 실질 위험(host env 누출)은 adapter env allowlist로 완화 가능.

---

## ADR-5. Durable Outbox = `openChannelIngressQueue` 우선, 전용 SQLite는 fallback

**Context.** OV endpoint 없이도 이벤트를 잃지 않는 영속 outbox 필요(crash 복구·sequence 보존). file/JSONL은 금지(`AGENTS.md:77`).

**Decision.** 1차로 `api.runtime.state.openChannelIngressQueue`(`src/plugins/runtime/types-core.ts:381`, 구현 `src/channels/message/ingress-queue.ts:339`)를 사용. 스키마/수명이 안 맞으면 workboard식 **전용 SQLite**(`openclaw/plugin-sdk/state-paths` `resolveStateDir` + `plugin-state-runtime`)로 승격.

**Why.** ingress queue가 이미 durable FIFO + claim/complete/fail + dedupe + prune를 제공(outbox 그 자체) → **core 패치 0**, 최소 위험. `openKeyedStore`는 순서/eviction 문제로 부적합.

**Consequences.** Receiver는 이번 단계 **Mock Receiver**(`RuntimeEventReceiver.send`). OV wire schema 미고정. retry는 내부 envelope만.

---

## ADR-6. 패키징 = 단일 번들 extension 안의 순수 TS 라이브러리 모듈

**Context.** gateway 부팅 없이 빠르게 단위/통합 테스트하고 싶다. core 수정 0.

**Decision.** `extensions/agent-runtime/`(번들 플러그인, workboard 패턴)에 런타임 코어를 **순수 TS 모듈**로 둔다.
순수 lib: input · worktree · command · verification · artifacts · events · outbox · worker. 런타임 의존(ACP 실행, 백그라운드 루프, 영속)은 좁은 인터페이스로 주입, wiring(`index.ts`/`registerService`)에서만 실제 seam 바인딩.

**Why.** workboard가 동일 구조로 gateway 없이 vitest 테스트됨(`extensions/workboard/src/{store,tools,dispatcher}.test.ts`: 주입된 store/`{run}` mock). tsconfig 불필요(extensions 프로젝트가 컴파일). import은 `openclaw/plugin-sdk/*` + 로컬 배럴만.

---

## ADR-7. Worktree Manager는 신규 구현하되 검증된 argv를 미러링

**Context.** 재사용 가능한 worktree 라이브러리가 없음(조사 PART A). PR 도구(bash)와 `update-runner.ts`(TS)에 패턴만 존재.

**Decision.** 얇은 `WorktreeManager` 모듈을 새로 만들되 `src/infra/update-runner.ts`의 argv를 미러링(`worktree add -b … <baseSha>`/`remove --force`/`prune`), git 실행은 `runCommandWithTimeout`(argv, no shell), repo root는 `findGitRoot`(`src/infra/git-root.ts:38`), 경로 confine은 `boundary-path`/`fs-bridge-path-safety` 재사용.

**Why.** 격리(별도 dir, main tree 불변)는 argv 패턴에 내재. lifecycle은 `update-runner.ts:1185/1325/1345/302`에서 검증됨. baseRevision 불일치 시 blocked 반환.

---

## 결정 요약 표

| ADR | 결정 | core 패치 |
|-----|------|-----------|
| 1 | Executor = `getAcpSessionManager`(plugin-sdk), cwd 지원 | 불필요 |
| 2 | 입력 직렬화·파일스캔·검증을 adapter가 수행 | 불필요 |
| 3 | `runPluginCommandWithTimeout` 재사용 | 불필요 |
| 4 | sandbox 재사용 + ACP 격리 한계 수용·env allowlist 완화 | **안 함(원칙)** |
| 5 | outbox = `openChannelIngressQueue` 우선 | 불필요 |
| 6 | 단일 extension 내 순수 TS lib, 의존 주입 | 불필요 |
| 7 | WorktreeManager 신규(검증 argv 미러링) | 불필요 |

**전체 결론: Agent Execution Runtime은 OpenClaw core 수정 없이 `extensions/agent-runtime` 플러그인 + 공개 SDK seam만으로 구현 가능하다.** 유일하게 수용하는 한계는 ACP app-server 호스트 env 격리 부재(adapter env allowlist로 완화, 추후 upstream 검토).
