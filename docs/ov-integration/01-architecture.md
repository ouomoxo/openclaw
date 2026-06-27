# 01 · 아키텍처와 책임 경계

## 두 시스템

```
사용자
  │  (Telegram / Slack)
  ▼
┌─────────────────────────────────────────────┐
│ OpenClaw  (이 레포)                           │
│ Messaging Gateway + Agent Runtime + Router   │
│  - 채널 어댑터(telegram/slack) ── 이미 존재    │
│  - Intake / Planner / Worker / Reviewer Agent │
│  - Executor(Native/Codex/ClaudeCode/GLM)      │
│  - Sandbox(docker/ssh) · ACP 하네스           │
│  - extensions/ov-bridge ◀── 우리가 만드는 것   │
└───────────────┬─────────────────────────────┘
                │  HTTPS REST (/api/agent/v1) + SSE
                │  ov.create_task / append_event / register_artifact / request_approval ...
                ▼
┌─────────────────────────────────────────────┐
│ OV  (NewWorld=Electron, Mobile=Capacitor)     │
│ Control Plane + System of Record              │
│  Message→Task→Plan→Approval→AgentRun→Event    │
│        →Artifact→Verification→Decision/Memory │
│  - SQLite 이벤트 소싱 캐노니컬 스토어          │
│  - Approval Inbox · Situation Feed · Dashboard│
└─────────────────────────────────────────────┘
```

핵심: **OpenClaw는 실행하고 보고한다. OV는 기록하고 판단한다.**

## 책임 경계

### OpenClaw가 소유 (이 레포에서 구현/재사용)

채널 어댑터(telegram/slack), 채널 인증·allowlist, 대화 session, Intake/Planner/Worker/Reviewer
Agent, 모델 provider 연결, Skills 로딩, Tool routing, agent loop, subagent 실행, Sandbox 요청,
Local Node 요청, OpenClaw 내부 실행 로그, 단기 대화 문맥.

### OpenClaw가 **소유하지 않음** (OV가 소유)

Task/Project canonical state, Approval 최종 결정, 장기 Decision, VerifiedMemory, 사용자 UI 상태,
비용 원장 최종값, **Task 완료 최종 판정**, OV DB 직접 접근, 배포·삭제의 자율 승인.

> 대칭 확인: OV 측 `NewWorld/docs/control-plane/SPEC.md §2`가 거울상으로 같은 경계를 정의한다 —
> OV는 "OpenClaw의 대화 세션, provider 인증, Codex turn, shell loop, Skills 런타임, Telegram transport,
> Docker sandbox 구현, OpenClaw 내부 DB"를 소유하지 않는다.

## 실행 파이프라인에서 OpenClaw의 역할

OV 파이프라인 `Message → Task → Plan → Approval → AgentRun → Event → Artifact → Verification → Decision/Memory`에서:

| 단계 | 누가 | OpenClaw 측 동작 |
|------|------|------------------|
| Message | OpenClaw | Telegram/Slack 수신, 대화/명령 구분 |
| Task | OV | OpenClaw Intake가 `ov.create_task` 호출 → OV가 Task 생성·소유 |
| Plan | OV(저장) / OpenClaw(생성) | Planner Agent가 구조화된 Plan 생성 → `ov.create_plan`로 제출 |
| Approval | OV | OpenClaw은 `ov.request_approval`만. 승인은 OV·사용자가. OpenClaw은 재개 명령을 기다림 |
| AgentRun | OpenClaw(실행) / OV(기록) | OV가 AgentRun 요청 → OpenClaw가 Worker/Reviewer 실행 |
| Event | OpenClaw→OV | 모든 lifecycle 이벤트를 `ov.append_event`로 전달(순서·idempotency 보장) |
| Artifact | OpenClaw→OV | diff/commit/test report 등을 `ov.register_artifact`로 제출(큰 건 URI+hash) |
| Verification | OpenClaw(증거)/OV(판정) | Worker가 test/build 실행해 증거 생성. 통과 판정은 OV |
| Decision/Memory | OV | OpenClaw은 관여하지 않음. VerifiedMemory는 OV가 승인 후 승격 |

## 4개 Agent (OpenClaw 측 역할)

| Agent | 권한 요지 | 출력 | 비고 |
|-------|-----------|------|------|
| **Intake** | 파일·shell 없음, `ov.*` 도구만 | OV Task 생성/상태/취소 | 채널 메시지 해석. 성공 판단 안 함 |
| **Planner** | repo read-only, write 금지 | 구조화 `PlannerOutput` | 코드 수정 안 함 |
| **Coding Worker** | workspace write, shell allowlist, commit ○ / push ✗ | diff·test·`AgentRunResult` | worktree+sandbox에서만 |
| **Reviewer** | read-only, test 실행 가능, write/commit 금지 | `ReviewerOutput` | pass도 Task 완료 확정 아님 |

Agent ↔ Executor 분리: "Coding Worker"는 *역할*, "CodexExecutor"는 *실행 방식*.
([02-openclaw-internals.md](./02-openclaw-internals.md) §5의 ACP 하네스가 Executor 추상화에 해당.)

## 두 레포 토폴로지 (개발 머신 `~/Desktop/`)

| 레포 | 역할 | 이 작업에서 |
|------|------|-------------|
| **openclaw** (이 레포) | 외부 실행기 = Gateway+Runtime | ✅ 여기서 `extensions/ov-bridge` 개발 |
| **NewWorld** (`name: ov`, Electron) | OV Control Plane 본체 | 계약(§7,§8) 제공. OV 팀이 병렬 개발 |
| **Mobile** (`ov-mobile`, Capacitor) | OV 모바일 Companion | 2단계. OV API에만 연결 |
| **ov-agent-contracts** (신규) | 공유 타입·JSON Schema | 양쪽이 의존. [04-contracts.md](./04-contracts.md) |

> OV 레포의 규칙(`NewWorld/AGENTS.md`)은 "openclaw 레포는 수정하지 않는다"이고, 이 레포의 규칙은
> "OpenClaw core는 수정하지 않고 `ov-bridge` 플러그인으로만 연동한다"이다. 두 규칙은 **상보적**이며,
> 계약(`ov-agent-contracts`)이 둘을 잇는 유일한 결합점이다.

## Contract Version

연동 계약은 `contractVersion: "1.0"`으로 시작한다(OV `AgentRunInput`, `RuntimeEvent` 등 공통).
OpenClaw gateway-protocol 자체의 `PROTOCOL_VERSION`(현재 4)과는 **별개**다 —
ov-bridge는 gateway-protocol 버전을 올리지 않는 경로로 설계한다([02](./02-openclaw-internals.md) §3).
