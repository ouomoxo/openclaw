# 00 · OpenClaw 개발 지침서 (캐노니컬 원문)

> OV 연동 Messaging Gateway 및 Agent Execution Runtime.
> 원문 보존 = 캐노니컬 요구사항. 해석·구현 매핑은 [02](./02-openclaw-internals.md)·[03](./03-ov-bridge-design.md),
> 단계 계획은 [05](./05-phases.md) 참조. OV 측 거울 문서는 `NewWorld/docs/control-plane/SPEC.md`.

## 1. 시스템 정의

OpenClaw는 메시지를 받아 독립적으로 모든 것을 처리하는 챗봇이 **아니다.** 역할:

1. Telegram·Slack 메시지를 수신한다.
2. 일반 대화와 실행 명령을 구분한다.
3. 실행 명령을 OV Task로 등록한다.
4. OV가 요청한 AgentRun을 실행한다.
5. 적절한 Agent, Skill, Tool, Executor를 선택한다.
6. 실행 도중 발생한 이벤트를 OV에 보고한다.
7. 결과와 Artifact를 OV에 제출한다.
8. OV가 확정한 결과를 사용자에게 전달한다.

OpenClaw는 작업 상태의 최종 판단자나 장기 기록 저장소가 **아니다.**

## 2. 책임 경계

**소유:** Telegram·Slack adapter, 채널 인증·allowlist, 대화 session, Intake/Planner/Worker/Reviewer
Agent, 모델 provider 연결, Skills 로딩, Tool routing, agent loop, subagent 실행, Sandbox 요청,
Local Node 요청, OpenClaw 내부 실행 로그, 단기 대화 문맥.

**비소유:** Task/Project canonical state, Approval 최종 결정, 장기 Decision, VerifiedMemory,
사용자 UI 상태, 비용 원장 최종값, Task 완료 최종 판정, OV DB 직접 접근, 배포·삭제의 자율 승인.

## 3. 전체 아키텍처

```
Telegram / Slack → Channel Adapter → Authentication/Allowlist → Intake Agent
→ OV Task API → OV Orchestrator → OpenClaw Execution API → Agent Router
   ├ Planner ├ Coding Worker ├ Reviewer
→ Executor Router  ├ Codex ├ Claude Code ├ GLM ├ Native Worker
→ Sandbox / Local Node → OV Event / Artifact API
```

## 4. Channel Adapter

초기 채널: Telegram DM, Slack DM, Slack 지정 채널 mention.
책임: 메시지 수신, immutable user ID 식별, workspace/chat ID 식별, thread 식별, 메시지 정규화,
결과 전송, 승인 버튼/명령 처리.

```ts
interface IncomingMessage {
  channel: "telegram" | "slack";
  channelId: string;
  threadId?: string;
  messageId: string;
  userId: string;
  text: string;
  attachments?: AttachmentReference[];
  receivedAt: string;
}
```

## 5. 인증 및 접근 통제

**Telegram:** 허용된 numeric user ID만. username 인증 금지. 그룹 입력 기본 차단. Bot token은
secret store. 고위험 승인은 Telegram 버튼만으로 완료하지 않는 정책 지원.
**Slack:** 허용 workspace/user/channel ID. bot message·webhook loop 차단. thread 기반 Task 연결.
**공통:** 허용되지 않은 사용자의 요청은 모델에 전달하지 않는다. 인증 실패도 OV에 보안 이벤트로 보고 가능.

## 6. Intake Agent

목적: 사용자의 자연어를 직접 실행하지 않고 OV Task로 변환.
분류: `CHAT, TASK_CREATE, TASK_STATUS, TASK_CANCEL, APPROVAL_DECISION, SYSTEM_STATUS, UNKNOWN`.
허용 도구: `ov.create_task, ov.get_task, ov.list_tasks, ov.request_cancel, ov.get_pending_approvals,
ov.submit_user_decision`.
금지 도구: shell, file write, git, deployment, external messaging, direct worker execution.
동작: 프로젝트 식별 → 목표 구조화 → source channel metadata 추가 → OV Task 생성 → Task ID·접수 상태 반환.
Intake Agent는 작업 성공 여부를 판단하지 않는다.

## 7. OV Tool Set

OpenClaw는 OV를 직접 SQL로 접근하지 않는다. 필수 Tool:

```
ov.create_task, ov.get_task, ov.list_tasks, ov.get_project_context, ov.create_plan,
ov.request_approval, ov.create_agent_run, ov.append_event, ov.register_artifact,
ov.complete_agent_run, ov.fail_agent_run, ov.get_pending_approvals, ov.request_cancel
```

도구 설계 원칙 — 나쁜 도구: `ov.execute(action,payload)`, `ov.database_query(sql)`,
`ov.update_anything(entity,fields)`. 좋은 도구: `ov.append_event(taskId,runId,event)`,
`ov.register_artifact(taskId,runId,artifact)`, `ov.request_approval(taskId,action,planHash,payload)`.
각 도구는 단일 목적을 가진다.

## 8. OV 실행 요청 수신

OV는 OpenClaw에 `AgentRunInput`을 전송. OpenClaw 검증 항목: contract version, taskId, runId,
correlationId, role, objective, permissions, callback endpoint, callback token, timeout, project
repository. 검증 실패 시 실행을 시작하지 않는다.

```ts
interface AgentRunAccepted {
  accepted: boolean;
  runId: string;
  openClawSessionId?: string;
  agentId?: string;
  rejectionReason?: string;
}
```

## 9. Agent 구성

초기에는 네 Agent만 운영.

**9.1 Intake** — 채널 메시지 해석, OV Task 생성, 상태 조회, 사용자 명령 전달. 파일·shell 권한 없음.

**9.2 Planner** — 목표 해석, 저장소 탐색, 작업 범위 산정, acceptance criteria 보완, 실행 단계 생성,
위험도 제안, 권한 요청, verification command 제안.
권한: `repository: read-only, filesystem: read-only, shell: 제한적 read-only, network: 기본 차단, write: 금지`.

```ts
interface PlannerOutput {
  summary: string;
  assumptions: string[];
  steps: { id: string; description: string; expectedChanges: string[]; }[];
  requestedPermissions: string[];
  verificationCommands: string[];
  expectedArtifacts: string[];
  estimatedRisk: "R0" | "R1" | "R2" | "R3";
  blockers: string[];
}
```
Planner는 코드를 수정하지 않는다.

**9.3 Coding Worker** — 독립 worktree 준비, 코드 탐색·수정, 테스트 실행, lint/typecheck/build,
commit, Artifact 생성, 진행 이벤트 보고.
권한: `filesystem: task workspace only, shell: allowlist, network: default deny, git commit: 허용,
git push: 금지, deployment: 금지, secret read: 금지`. Base repo의 main working tree를 수정하지 않는다.

**9.4 Reviewer** — Plan과 diff 비교, acceptance criteria 검토, 테스트 evidence 검토, 보안·회귀 위험 검토,
완료 여부 권고. 권한: `repository: read-only, diff: read, tests: 실행 가능, file write: 금지,
git commit: 금지, network: 기본 차단`.

```ts
interface ReviewerOutput {
  decision: "pass" | "request-changes" | "blocked";
  findings: {
    severity: "info" | "warning" | "error" | "critical";
    category: string;
    description: string;
    evidence?: string;
    recommendation?: string;
  }[];
  unmetCriteria: string[];
  requiredVerifications: string[];
}
```
Reviewer의 pass도 OV의 최종 완료 판정은 아니다.

## 10. Agent Routing

role 기반: `intake→Intake, planner→Planner, worker→Coding Worker, reviewer→Reviewer`.
모델 선택은 별도 정책. OV는 모델 이름 대신 `modelPolicy`(`fast, balanced, high-reliability,
independent-review`)를 전달할 수 있고, OpenClaw가 실제 provider를 선택한다.

## 11. Executor 추상화

```ts
interface Executor {
  start(input: ExecutorInput): Promise<ExecutorHandle>;
  send(handleId: string, message: string): Promise<void>;
  cancel(handleId: string): Promise<void>;
  inspect(handleId: string): Promise<ExecutorSnapshot>;
  collectArtifacts(handleId: string): Promise<ExecutorArtifact[]>;
}
```
구현체: `OpenClawNativeExecutor, CodexExecutor, ClaudeCodeExecutor, GLMExecutor, LocalNodeExecutor`.
Agent와 Executor를 분리한다(Coding Worker는 역할, CodexExecutor는 실행 방식).

## 12. 실행 환경

**12.1 VPS Sandbox** — 작업별 독립 환경(Task→worktree→sandbox container→executor).
기본 정책: non-root, capabilities drop all, read-only base image, workspace mount only, CPU/RAM/process
limit, timeout, network disabled.
**12.2 Local Mac Node** — 로컬 전용 OV DB, macOS 앱 실행, Tauri native 테스트, 비공개 로컬 파일,
고성능 빌드, Apple 플랫폼 빌드. 연결: VPS OpenClaw ↔ Tailscale ↔ Local Node. outbound/private network만.
허용 명령 allowlist를 둔다.

## 13. Worktree 정책

각 Task의 각 Worker Run은 별도 worktree.
경로 예: `/var/lib/openclaw/workspaces/ov/task_01/run_02/`. 브랜치: `agent/task_01/run_02`.
규칙: main working tree 수정 금지, `git reset --hard` 기본 금지, `git clean -fd` 기본 금지,
force push 금지, remote push는 별도 Approval, 작업 종료 후 Artifact 보존 후 cleanup.

## 14. Skill 배치

- **Intake:** task-intake, ov-task-management, channel-reporting
- **Planner:** architecture, task-planning, threat-model, tool-design, context-degradation
- **Coding Worker:** systematic-debugging, root-cause-tracing, test-driven-development,
  using-git-worktrees, verification-before-completion, finishing-a-development-branch,
  frontend-design, webapp-testing
- **Reviewer:** differential-review, insecure-defaults, accessibility,
  verification-before-completion, property-based-testing

모든 Agent에 모든 Skill을 제공하지 않는다. Skill은 검증된 commit SHA에 고정. 자동 업데이트하지 않는다.

## 15. 실행 이벤트 보고

OpenClaw가 OV에 보내는 최소 이벤트:
- **Run:** RUN_STARTED, RUN_HEARTBEAT, RUN_BLOCKED, RUN_FAILED, RUN_COMPLETED, RUN_CANCELLED
- **Tool:** TOOL_CALL_STARTED, TOOL_CALL_COMPLETED, TOOL_CALL_FAILED
- **Command:** COMMAND_STARTED, COMMAND_COMPLETED, COMMAND_FAILED
- **File:** FILE_CREATED, FILE_MODIFIED, FILE_DELETED
- **Verification:** TEST_STARTED, TEST_PASSED, TEST_FAILED, BUILD_STARTED, BUILD_PASSED, BUILD_FAILED
- **Artifact:** ARTIFACT_CREATED

이벤트 payload에서 secret, 전체 환경변수, credential을 제거한다.

## 16. Event 전송 규칙

```ts
interface RuntimeEvent {
  contractVersion: "1.0";
  eventId: string;
  taskId: string;
  runId: string;
  correlationId: string;
  sequence: number;
  type: string;
  severity: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
```
원칙: 순서 보장, 실패 시 재시도, idempotency key, callback 실패 시 local outbox 저장 후 복구 재전송,
무한 재시도 금지, delivery 상태 모니터링. **재시작 후에도 미전송 이벤트를 복구**해야 한다.

## 17. Artifact 제출

대상: git diff, commit hash, branch, test/build/lint report, screenshot, generated file, execution log.
큰 경우 파일 자체가 아니라 URI와 hash 제출. 등록 후 OV 접근 가능 여부 확인.

## 18. 완료 보고 계약

```ts
interface AgentRunResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  changedFiles: { path: string; changeType: "created" | "modified" | "deleted"; }[];
  verification: {
    type: string; command?: string; exitCode?: number;
    status: "passed" | "failed" | "skipped"; artifactId?: string;
  }[];
  artifacts: { type: string; uri: string; sha256?: string; }[];
  risks: string[];
  blockers: string[];
  requestedNextAction?: { type: string; approvalRequired: boolean; payload: Record<string, unknown>; };
}
```
OpenClaw는 AgentRun 완료는 보고하지만 Task 완료를 직접 확정하지 않는다.

## 19. Approval 처리

흐름: `Agent → ov.request_approval → OV → Desktop/Mobile/Telegram → 사용자 결정 → OV Approval 확정
→ OpenClaw에 실행 재개 명령`. OpenClaw가 사용자의 Telegram 텍스트를 직접 신뢰해 고위험 작업을 실행하지
않는다. 사용자 입력을 OV Approval API에 제출하고 OV 결과를 기다린다.

## 20. Chat 결과 보고

채팅은 요약 인터페이스다. 상세 기록은 OV에 둔다. (진행 상태/완료 보고 포맷은 원문 §20 참조 —
Task ID, 프로젝트, 상태, 에이전트, 경과 시간, 최근 상황, 변경 요약, 다음 작업.)

## 21. Heartbeat와 복구

상태: healthy, delayed, stalled, offline.
복구: 재시작 후 활성 Run 조회 → Executor 상태 확인 → 실행 중이면 재연결 / 종료됐으면 결과 수집 /
알 수 없으면 OV에 blocked 보고. **임의로 성공 처리 금지.**

## 22. 보안

**Secret:** 모델 prompt에 secret 금지, worker 전체 env 조회 금지, provider별 credential 분리,
GitHub read/write 분리, callback token은 Run 단위 단기 토큰 권장.
**Shell:** command allowlist, 위험 command denylist, interpolation 검증, timeout, output size 제한.
**Network:** 기본 deny, hostname allowlist, 요청 권한과 실제 연결 비교, 임의 다운로드 금지.
**Skills:** source audit, commit pinning, scripts/hooks/binary/network 검사, automatic update 금지.

## 23. 관측성

로그 필드: timestamp, level, component, taskId, runId, correlationId, agentId, executorType,
eventType, durationMs, status.
측정: Task 접수 수, 실행 성공률, 첫 시도 성공률, 평균 Run 시간, 평균 재시도, callback 실패,
event delivery delay, tool failure, 모델별 비용, agent별 성공률.

## 24. OpenClaw API (OV가 사용할 최소 API)

```
POST /api/runtime/v1/runs
GET  /api/runtime/v1/runs/:runId
POST /api/runtime/v1/runs/:runId/cancel
POST /api/runtime/v1/runs/:runId/resume
GET  /api/runtime/v1/health
GET  /api/runtime/v1/agents
```
Run 생성 요청은 OV의 실행 봉투를 받는다. OpenClaw API는 공용 인터넷에 직접 노출하지 않는다.
Tailscale 또는 private reverse proxy를 사용한다.

## 25. 개발 단계 (요약 — 상세는 [05-phases.md](./05-phases.md))

1. Gateway · 2. OV Tools · 3. Intake Agent · 4. Runtime API · 5. Planner · 6. Coding Worker ·
7. Reviewer · 8. Local Node · 9. Slack.

## 26. 테스트 전략

- **Unit:** message classification, agent routing, permission validation, event sequencing,
  retry policy, output redaction.
- **Contract:** OV API schema, AgentRunInput, RuntimeEvent, AgentRunResult, contract version.
- **Integration:** Telegram→Task, OV→Run, Run→Event callback, Artifact callback, Approval request,
  Cancel, restart recovery.
- **Security:** unauthorized user, forged callback, expired token, path traversal, prohibited command,
  network escape, malicious Skill.

## 27. 완료 정의 (1차)

1. 사용자가 Telegram에서 OV 프로젝트 작업을 지시. 2. Intake가 OV Task 생성. 3. OV가 Planner Run 요청.
4. Planner가 구조화 Plan 제출. 5. 승인 후 Coding Worker Run 시작. 6. Worker가 독립 worktree·sandbox에서
작업. 7. 모든 주요 이벤트가 OV에 전달. 8. 테스트·diff가 Artifact로 등록. 9. Reviewer가 독립 검토 제출.
10. OV가 최종 Task 상태 확정. 11. OpenClaw가 사용자에게 요약 전송. 12. OpenClaw·OV 재시작해도 복구.

이 경로 안정화 전에는 무제한 자율 루프, 자율 배포, 자동 Memory 확정, 복잡한 멀티에이전트 조직을 추가하지 않는다.
