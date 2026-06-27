# 04 · 계약 (`ov-agent-contracts`) · OV API · 이벤트 매핑

> OV(`NewWorld`)와 OpenClaw(`ov-bridge`)를 잇는 **유일한 결합점**. 두 레포가 이 계약에만 의존한다.
> OV 측 캐노니컬 정의: `NewWorld/docs/control-plane/SPEC.md §4,§7,§8,§9`.

## `ov-agent-contracts` 레포 계획

별도 git 레포(또는 npm 패키지) `ov-agent-contracts`. 내용:
- **TypeScript 타입**: 아래 공유 인터페이스.
- **JSON Schema**: 각 타입의 런타임 검증용(OpenClaw는 외부 경계에서 typebox/zod, OV는 자체 검증).
- **버전**: `contractVersion: "1.0"`. 변경은 additive 우선, 파괴적 변경은 버전 bump + 양쪽 follow-through.

> 왜 분리하나: OV 레포 규칙은 "openclaw를 읽지 않음", OpenClaw 규칙은 "core 수정 안 함". 두 레포가 서로의 소스를
> 보지 않고도 같은 와이어 포맷을 공유하려면 제3의 계약 레포가 필요하다. 양쪽이 `npm i ov-agent-contracts`(또는 git
> submodule)로 의존한다.

## 공유 인터페이스 (contractVersion "1.0")

OpenClaw 지침서와 OV SPEC에서 **공통으로 와이어를 건너는** 타입만 계약에 넣는다(내부 타입은 각자 소유):

```ts
// OV → OpenClaw : run 실행 요청 (OV SPEC §7)
interface AgentRunInput {
  contractVersion: "1.0";
  taskId: string; runId: string; correlationId: string;
  role: "planner" | "worker" | "reviewer";
  projectContext: {
    projectId: string; repository?: string; baseBranch?: string;
    technologyProfile: string[]; architectureConstraints: string[];
  };
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  permissions: {
    filesystem: "none" | "read" | "workspace-write";
    shell: boolean; network: boolean; gitCommit: boolean; gitPush: boolean; deployment: boolean;
  };
  verificationCommands: string[];
  callback: { eventEndpoint: string; artifactEndpoint: string; completionEndpoint: string; };
}

// OpenClaw → OV : 수락 응답 (지침서 §8)
interface AgentRunAccepted {
  accepted: boolean; runId: string;
  openClawSessionId?: string; agentId?: string; rejectionReason?: string;
}

// OpenClaw → OV : 이벤트 (지침서 §16). OV 측 TaskEvent로 흡수됨 (SPEC §4.6)
interface RuntimeEvent {
  contractVersion: "1.0";
  eventId: string; taskId: string; runId: string; correlationId: string;
  sequence: number; type: string; severity: string;
  payload: Record<string, unknown>; createdAt: string;
}

// OpenClaw → OV : run 완료 보고 (지침서 §18)
interface AgentRunResult {
  status: "completed" | "blocked" | "failed";
  summary: string;
  changedFiles: { path: string; changeType: "created" | "modified" | "deleted" }[];
  verification: { type: string; command?: string; exitCode?: number;
                  status: "passed" | "failed" | "skipped"; artifactId?: string }[];
  artifacts: { type: string; uri: string; sha256?: string }[];
  risks: string[]; blockers: string[];
  requestedNextAction?: { type: string; approvalRequired: boolean; payload: Record<string, unknown> };
}

// Planner / Reviewer 산출물 (지침서 §9) — OV Plan/Verification에 매핑
interface PlannerOutput { /* 지침서 §9.2 / 00-spec-openclaw.md */ }
interface ReviewerOutput { /* 지침서 §9.4 */ }
```

> OV 측 도메인 모델(`Task`, `ExecutionPlan`, `AgentRun`, `TaskEvent`, `Approval`, `Artifact`,
> `Verification`, `Situation`)은 **OV가 소유**(SPEC §4)하고 계약에 직접 넣지 않는다. 계약은 와이어 경계의
> 입출력 envelope만. 단, 이벤트 타입 enum과 risk/permission enum은 양쪽이 합의해야 하므로 계약에 포함한다.

## OV API 표 (`/api/agent/v1` · OV SPEC §8)

```
Task:     POST /tasks · GET /tasks/:taskId · GET /tasks · POST /tasks/:taskId/commands
Plan:     POST /tasks/:taskId/plans · GET /tasks/:taskId/plans · GET /plans/:planId
AgentRun: POST /tasks/:taskId/runs · GET /runs/:runId · POST /runs/:runId/cancel ·
          POST /runs/:runId/heartbeat · POST /runs/:runId/complete · POST /runs/:runId/fail
Event:    POST /tasks/:taskId/events · GET /tasks/:taskId/events · GET /events/stream (SSE)
Approval: POST /tasks/:taskId/approvals · POST /approvals/:approvalId/approve ·
          POST /approvals/:approvalId/reject · GET /approvals/pending
Artifact: POST /tasks/:taskId/artifacts · GET /artifacts/:artifactId
Context:  GET /projects/:projectId/agent-context
Situation:GET /situations · POST /situations/:situationId/resolve
```

## API 보안 (OV SPEC §9)

OpenClaw는 **전용 service identity** 사용. 부여 scope:
`ov.task:create, ov.task:read, ov.run:create, ov.run:update, ov.event:append, ov.artifact:create,
ov.context:read, ov.approval:request`.
**부여 금지** scope: `ov.approval:approve, ov.task:force-complete, ov.policy:update, ov.memory:verify`.

필수 요청 헤더: `Authorization`, `X-Correlation-ID`, `Idempotency-Key`, `X-Contract-Version`,
`X-Timestamp` (선택: 요청 서명). → ov-bridge `ov-client.ts`가 모든 요청에 이 헤더를 붙인다.

## 이벤트 타입 enum (계약 합의 대상)

OpenClaw 발행(지침서 §15) → OV TaskEvent(SPEC §4.6). 두 목록은 **거의 일치**한다:

```
RUN_STARTED RUN_HEARTBEAT RUN_BLOCKED RUN_FAILED RUN_COMPLETED RUN_CANCELLED
TOOL_CALL_STARTED TOOL_CALL_COMPLETED TOOL_CALL_FAILED
COMMAND_STARTED COMMAND_COMPLETED COMMAND_FAILED
FILE_CREATED FILE_MODIFIED FILE_DELETED
TEST_STARTED TEST_PASSED TEST_FAILED  BUILD_STARTED BUILD_PASSED BUILD_FAILED
ARTIFACT_CREATED            // OV 측은 ARTIFACT_REGISTERED — ⚠ 이름 불일치, 계약에서 통일 필요
```

이름 차이(`ARTIFACT_CREATED` vs `ARTIFACT_REGISTERED`)와 OpenClaw 미발행 이벤트(COMMAND_STARTED 등 →
[02](./02-openclaw-internals.md) §4.3 갭)는 `ov-agent-contracts`에서 **정규 enum 하나로 확정**한다.
OV는 추가로 `RUN_TIMED_OUT`, `TASK_*`, `PLAN_*`, `APPROVAL_*`, `VERIFICATION_*`, `SITUATION_*`를 갖지만
이들은 OV 내부에서 생성되므로 OpenClaw가 발행하지 않는다.

## 매핑 메모

- OpenClaw run의 `idempotencyKey` = run 식별자. OV `runId`와 정렬되도록 ov-bridge가 `runId`를 idempotencyKey로 전달.
- OpenClaw 진단 이벤트 → `RuntimeEvent` 변환은 ov-bridge `events/mapping.ts`. 표는 [02](./02-openclaw-internals.md) §4.3.
- `sequence`는 ov-bridge가 (taskId, runId)별 단조 증가로 부여. outbox가 순서·idempotency 보장(지침서 §16).
