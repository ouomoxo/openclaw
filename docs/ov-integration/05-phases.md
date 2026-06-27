# 05 · 개발 단계 (OC-Phase 1~9)

> 지침서 §25의 단계를 OpenClaw 실제 시seam과 매핑. 각 Phase는 **완료 조건(DoD)**을 가진다.
> 원칙: OC-Phase 1차 완료 경로(지침서 §27)가 안정화되기 전 무제한 자율 루프·자율 배포·자동 Memory·복잡한
> 멀티에이전트 조직을 추가하지 않는다. OV 측 대응 Phase는 `NewWorld/docs/control-plane/ROADMAP.md`.

| OC-Phase | 내용 | 핵심 OpenClaw seam | DoD |
|----------|------|---------------------|-----|
| **1 Gateway** | VPS 설치, process supervision, Telegram, allowlist, health, logging | 기존 `extensions/telegram`, `src/gateway`, `src/node-host`. 신규 코드 거의 없음 — **설정** 중심 | VPS 재시작 자동 복구, 허용 사용자만 접근, 안정 송수신 |
| **2 OV Tools** 🟡 | OV API client, create/get task, append event, register artifact, request approval | `ov-bridge`: client + `ov_create_task` tool + 계약준수 Mock (49 tests). append_event/artifact/approval·outbox는 추후 | **create_task 슬라이스 완료**([09](./09-ov-bridge-vertical-slice.md)). idempotency/retry/contract test ✅ |
| **3 Intake Agent** 🟡 | 메시지 분류, Task 생성, 상태 조회, 취소 | `ov_create_task` 도구 준비됨. `openclaw.json` intake agent(`tools.allow:["ov_create_task"]` + system prompt) 구성은 실제 OV 연결 시 | 도구 등록·플러그인 로드 테스트 ✅. 자연어→Task 경로는 agent 구성 후 |
| **4 Runtime API** | create/inspect/cancel/resume Run, Agent routing | `ov-bridge` `runtime-api/routes.ts` → `dispatchGatewayMethod("agent",...)`. 라우팅은 `src/routing` | OV가 Run 생성·취소 가능 |
| **5 Planner** | read-only repo, 구조화 Plan, permission request, risk 제안 | planner agent config(read-only tool policy) + `PlannerOutput` 도구화 → `ov_create_plan` | Plan을 OV에 제출, 코드 미수정 |
| **6 Coding Worker** | worktree, sandbox, executor, event reporting, artifact collection | worktree 헬퍼(신규 소량) + `src/agents/sandbox`(docker) + ACP(`extensions/acpx`) + 진단 이벤트 service | 독립 worktree/sandbox 작업, 이벤트·Artifact 전달 |
| **7 Reviewer** | diff review, evidence review, structured findings, no-write | reviewer agent config(read-only) + `ReviewerOutput` | 독립 검토 결과 제출, write 금지 |
| **8 Local Node** | Tailscale, node auth, command allowlist, status/reconnect | `src/node-host`(local/remote, Tailscale) 또는 `ssh` sandbox 백엔드 | Local Mac Node에서 실행·재연결 |
| **9 Slack** | Telegram과 동일 Task 모델·OV Tools 재사용 | 기존 `extensions/slack` + 같은 intake agent | Slack에서 동일 경로 동작 |

## Phase별 주의

- **Phase 1~3은 코드 신규가 거의 없다.** 대부분 `openclaw.json` 설정(채널 allowlist, agent 정의, tool policy)과
  `ov-bridge`의 도구 레이어다. 첫 슬라이스([06](./06-vertical-slice.md))가 Phase 1~3을 가로지른다.
- **Phase 4(Runtime API)와 Phase 6(이벤트)** 에서 [02](./02-openclaw-internals.md) §7의 core 수정 후보(진단
  신뢰 게이트)가 등장. 그때 근거 기록 후 사용자 승인.
- **Phase 6의 worktree-per-run**(지침서 §13)은 OpenClaw에 전용 매니저가 없어 신규 헬퍼가 필요(소량, 플러그인 측 가능,
  [02](./02-openclaw-internals.md) §5.3).
- **Executor(§11)**는 ACP 레지스트리 항목으로 매핑 — Codex는 이미 연결됨(`@zed-industries/codex-acp@0.15.0`).
  새 프로세스 spawn/프로토콜 구현 금지.

## 1차 완료 경로 (지침서 §27 = 우리의 "끝")

Telegram 지시 → Intake가 OV Task 생성 → OV가 Planner Run 요청 → Planner Plan 제출 → 승인 후 Worker Run →
worktree/sandbox 작업 → 이벤트·Artifact 전달 → Reviewer 검토 → OV가 Task 확정 → 사용자에게 요약 → 재시작 복구.
이 경로 = OC-Phase 1~7의 통합. Phase 8(Local Node)·9(Slack)는 그 다음.
