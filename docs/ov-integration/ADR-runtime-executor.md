# ADR · Agent Execution Runtime — Executor & 패키징 결정

> Status: **Accepted for experimental runtime development — NOT accepted for production execution.**
> Date: 2026-06-28 · Branch: `feat/agent-execution-runtime`
>
> 이 Runtime은 **Experimental**이며 다음으로만 분류·운영한다: test/fixture repository 전용, production credential 없음,
> 신뢰하지 않는 repository 없음, public network 실행 없음. "보안 sandbox 완료"/"production ready"라고 주장하지 않는다.
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

## ADR-4. 격리 경계의 정확한 구분 — experimental 한정 수용 (core 패치 안 함)

**정확한 표현(이 문구만 사용):**
> OpenClaw command tools와 ACP model process의 격리 경계는 **다르다**. ACP process는 현재 별도의 강제 sandbox 정책을
> 완전히 상속하지 않으며, host 환경변수 상속과 container privilege/resource policy에 한계가 있다. 이번 Phase에서는
> **environment minimization과 workspace isolation**으로 위험을 줄이지만, 이는 **완전한 hostile-code sandbox가 아니다.**

"sandbox 격리 완료"/"ACP가 Docker sandbox 안에서 안전하게 실행됨" 같은 표현은 **사용하지 않는다.**

**Context.** docker sandbox는 플러그인 도달 가능(`openclaw/plugin-sdk/sandbox`)하나, **Codex/ACP app-server는 호스트에서
plain spawn으로 실행되며 gateway 프로세스의 env를 상속**한다(`extensions/codex/src/app-server/transport-stdio.ts:52-114`).
docker는 OpenClaw 자체 exec 도구만 감싼다. 기본값은 `mode:off`·`--user` 없음·자원 제한 없음.

**Decision.**
- 새 컨테이너 시스템을 만들지 않고 기존 backend를 재사용.
- 우리가 **완전히 제어하는** verification command runner의 env는 §3 allowlist로 **새로 구성**(host env 비상속).
- ACP model process 자체의 container/privilege/resource/network 격리는 **이번 범위에서 보장하지 않으며 production blocker로 기록**.
- 부족분은 **core patch로 해결하지 않고** 후속 ADR(Production Gate 해법 비교)로 미룬다.

**Why.** core 수정은 원칙·리뷰 위험 위반. 실질 위험(우리가 spawn하는 child의 secret 누출)은 env 재구성으로 차단 가능하나, ACP
model process의 강한 격리는 공개 seam만으로 불가 → 정직하게 한계로 남긴다.

**Status.** Accepted **for experimental runtime development only**. NOT accepted for production execution.

### ADR-4 Evidence (§9 host-context 프로브, 2026-06-28)

`extensions/agent-runtime/test-support/host-context-probe.mjs` 실행 결과(값 없이 이름·불리언만; codex 바이너리 미실행 —
provider cred 없음). ACP app-server가 spawn되는 **호스트 컨텍스트**를 특성화:

| 항목 | 측정값 | production blocker? |
|------|--------|---------------------|
| uid / isRoot | 501 / **false** | uid 0 아님 → 미해당(이 머신) |
| inContainer | **false** | ✅ blocker (컨테이너 없음) |
| dockerSocketVisible | false | 미해당 |
| hostHomeWritable | **true** | ✅ blocker |
| repoParentWritable | **true** | ✅ blocker |
| ssh/.aws/gh/.npmrc 가시 | ssh✅ gh✅ npmrc✅ | ✅ blocker (host credential path 가시) |
| secret-패턴 env 상속 | **10개**(SSH_AUTH_SOCK, CLAUDE_CODE_*, 주입한 FAKE_OV_SERVICE_TOKEN 등) | ✅ blocker (host env 상속) |
| enforcedContainerResourceLimits | **false** | ✅ blocker (CPU/RAM/PID 제한 없음) |
| network isolation | 미강제(host network) | ✅ blocker |

→ 확인된 production blocker: **컨테이너 없음, host HOME/repo-parent writable, host credential path 가시, host secret env 상속,
자원 제한 없음, network 미격리.** 미해당: uid 0, docker socket. 이 evidence가 §11 `RuntimeSecurityPosture` 기본값(아래 ADR-8)을 정당화.

### Production Gate (해결 전 production 비활성)

다음이 모두 검증·통과되기 전 runtime을 production에 활성화하지 않는다:
ACP model process non-root · host secret env 비상속 · provider credential child 비상속 · outbound network deny/allowlist ·
writable mount가 worktree/runtime dir로 제한 · CPU/RAM/PID/time limits · process-tree cancellation · no Docker socket ·
no host credential mounts · hostile-fixture escape test 통과 · independent security review 통과.
해법 후보(후속 ADR에서 비교, **지금 core patch 안 함**): ① upstream ACP sandbox 지원 ② ACP app-server를 별도 hardened
container로 ③ rootless container + explicit mounts/env/network/resources ④ Local Node 전용 isolated worker ⑤ 별도 execution daemon.

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

## ADR-8. 모든 Run 결과에 `RuntimeSecurityPosture`를 박제하고 격리 종류를 구분한다

**Decision.** `ExecutorResult`/`RunSnapshot`에 `RuntimeSecurityPosture`를 포함한다(모델·Worker가 변경 불가, 런타임이 측정/주입):
`environmentSanitized, workspaceIsolated, processUserVerifiedNonRoot, resourceLimitsVerified, networkIsolationVerified,
productionEligible, limitations[]`. 또한 `start` 시 `RUNTIME_SECURITY_POSTURE_RECORDED` 이벤트를 기록하고 내부 결과에 보존(추후 OV 전달용).

**기본 예상값(ADR-4 evidence 기준):** `environmentSanitized=true`(우리 command runner 한정), `workspaceIsolated=true`,
`processUserVerifiedNonRoot=false`, `resourceLimitsVerified=false`, `networkIsolationVerified=false`, **`productionEligible=false`**.

**격리 종류 구분(문서·코드 naming):** `workspaceIsolation`(worktree=변경 격리) ≠ `processIsolation` ≠ `credentialIsolation`
≠ `networkIsolation` ≠ `resourceIsolation`. **worktree 존재가 나머지 격리 충족을 의미하지 않는다.**

## ADR-9. Env는 allowlist에서 새로 구성, runtime 전용 HOME, command deny-list

**Decision.**
- ACP 세션/command 실행에 `process.env` 전체를 전달하지 않는다. **allowlist에서 새 env 객체를 생성**한다(패턴 차단만으로 의존하지 않음).
  허용 후보: `PATH, HOME(전용), TMPDIR, LANG, LC_ALL, TERM, CI, NO_COLOR`; 도구별 opt-in: `NODE_OPTIONS, RUST_BACKTRACE,
  CARGO_HOME(전용), npm_config_cache(전용)`. `OV_*/TELEGRAM_*/SLACK_*/GITHUB_*/GH_*/AWS_*/GOOGLE_*/AZURE_*/ANTHROPIC_*/
  OPENAI_*/CLAUDE_*/CODEX_*/SSH_*/DOCKER_*/KUBECONFIG/DATABASE_URL/*_TOKEN/*_SECRET/*_PASSWORD/*_KEY`는 기본 차단.
- **Runtime 전용 HOME** `<runtime-root>/homes/<runId>/`(최소 config·전용 cache/temp·빈 git config). `~/.ssh`/`~/.aws`/`~/.config/gh`/
  `~/.npmrc` token/keychain/shell history/실제 git credential helper 미포함. git identity는 테스트용 이름·이메일 명시.
- **Command deny-list**: `sh,bash,zsh,fish,sudo,su,ssh,scp,curl,wget,nc,socat,docker,kubectl,terraform,ansible` 기본 거부.
  `node -e`/`python -c`/`npx`처럼 임의 코드 실행 가능 명령은 별도 **high-risk 등급**(일반 allowlist 항목으로 취급하지 않음).
- **Network**: 기본 `network:false`. 단 ACP process에 강제 deny 불가 → "보안 보장"으로 표현하지 않고 production blocker로 기록.
  E2E fixture는 network·dependency-install 불필요한 것만 사용.
- **Repository trust**: `RepositoryExecutionProfile.trustLevel ∈ {fixture, trusted-local, untrusted}`. fixture 허용,
  trusted-local 명시 테스트만, **untrusted 거부**. `allowDependencyInstall`/`networkAllowed` 포함.

**Why.** §9 evidence가 host env/credential/network 노출을 확인. 우리가 제어 가능한 경계(child env, HOME, command, cwd)에서
최대한 위험을 줄이고, 제어 불가한 ACP-process 격리는 blocker로 정직히 남긴다.

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
| 8 | 결과에 `RuntimeSecurityPosture` 박제 + 격리 종류 구분 | 불필요 |
| 9 | env allowlist 재구성 · 전용 HOME · command deny-list · repo trustLevel | 불필요 |

**전체 결론: Agent Execution Runtime은 OpenClaw core 수정 없이 `extensions/agent-runtime` 플러그인 + 공개 SDK seam만으로 구현
가능하다. 단 이는 Experimental(fixture 전용·non-production)이며, ACP model process의 container/credential/network/resource
격리는 §9 evidence가 확인한 production blocker로 남는다.** 우리가 제어하는 경계(child env 재구성, 전용 HOME, command policy,
worktree 격리, evidence 수집, cancellation)로 위험을 줄이되 hostile-code sandbox로 표현하지 않는다. Production gate 해법은 후속 ADR.
