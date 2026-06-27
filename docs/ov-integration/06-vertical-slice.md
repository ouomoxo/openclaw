# 06 · 첫 Vertical Slice

> ✅ **구현됨** (도구·클라이언트·Mock 레벨). 실제 구현체와 결정 로그는 [09-ov-bridge-vertical-slice.md](./09-ov-bridge-vertical-slice.md),
> 코드는 `extensions/ov-bridge`. 아래는 원래 슬라이스 설계(참고용). 남은 것: 실제 OV 연결 + Intake agent 구성(§아래 열린 질문 1·3).

> 목표: **Telegram 메시지 → OpenClaw Intake → OV `create_task` 호출 → Task ID를 사용자에게 회신.**
> 이것이 동작하면 OV 연동의 뼈대(채널→도구→OV→회신)가 증명된다. 조사·문서화가 끝난 **지금 구현 가능**한 최소 단위.

## 설계 (core·telegram 수정 0)

```
Telegram DM ──grammY──► authorizeInboundMessage(allowlist)
   ──► runChannelInboundEvent (core agent loop)
   ──► intake agent (openclaw.json: tools.allow=["ov_create_task"], system prompt)
   ──► ov_create_task 도구 (ov-bridge) ──HTTP POST /api/agent/v1/tasks──► OV
   ◄── { taskId } ◄── 도구 결과 ◄── agent 응답 ──► Telegram 기존 outbound로 자동 회신
```

근거: [02](./02-openclaw-internals.md) §6.2(채널은 transport-only, Intake는 agent+tool로), §2(도구 등록).

## 구현 단계

1. **`extensions/ov-bridge` 스캐폴드** — `openclaw plugins init ov-bridge --name "OV Bridge"` 또는
   [03](./03-ov-bridge-design.md) 스켈레톤 수기 작성. 이 슬라이스는 도구 **하나**(`ov_create_task`)만.
2. **`ov-client.ts`** — `POST {baseUrl}/tasks`, 헤더 `Authorization`/`X-Correlation-ID`/`Idempotency-Key`/
   `X-Contract-Version`/`X-Timestamp`([04](./04-contracts.md) §보안). 슬라이스에선 단일 호출·기본 재시도만.
3. **`tools/create-task.ts`** — `AgentTool`(TypeBox 파라미터: `objective`, `projectId?`, `title?`,
   source channel metadata). `execute` → ov-client → `jsonResult({ taskId })`. 이름 `ov_create_task`,
   매니페스트 `contracts.tools`에 선언.
4. **`openclaw.json` 설정:**
   ```jsonc
   {
     "channels": { "telegram": {
       "dmPolicy": "allowlist",
       "allowFrom": ["<본인 numeric telegram id>"]
     }},
     "agents": { "intake": {
       "tools": { "allow": ["ov_create_task"] },
       "systemPrompt": "너는 OV Intake다. 실행 명령이면 ov_create_task로 OV Task를 만들고 Task ID를 회신한다. 직접 코드를 실행하지 않는다."
     }},
     "plugins": { "ov-bridge": {
       "baseUrl": "http://localhost:<OV 포트>/api/agent/v1",
       "serviceTokenRef": "<secret ref>",
       "contractVersion": "1.0"
     }}
   }
   ```
   (실제 키 이름은 구현 시 `src/config/types.*`로 확인. telegram 토큰은 `~/.openclaw/credentials/` 또는 `TELEGRAM_BOT_TOKEN`.)
5. **OV mock** — OV `/api/agent/v1/tasks`가 아직 없으면(현재 `src/main/controlplane/` 미구현) 간단한 mock 서버로
   `{ taskId: "task_..." }` 반환. contract test는 이 mock 대상.
6. **수동 검증** — Telegram에서 "OV 로그인 모듈 테스트 실패 원인 분석하고 수정해" 전송 → Task ID 회신 확인.

## 완료 조건 (이 슬라이스 DoD)

- [ ] 허용된 numeric ID만 통과(미허용 사용자는 모델에 도달 안 함).
- [ ] 자연어 실행 지시 → `ov_create_task` 호출 → OV(mock)에 Task 생성.
- [ ] Task ID가 Telegram으로 회신됨.
- [ ] Intake agent에 shell/file/git 도구 없음(`tools.allow`로 제한 확인).
- [ ] `pnpm build` · `pnpm check` · `pnpm test extensions/ov-bridge` 통과.
- [ ] core `src/**` 변경 0, telegram 변경 0.

## 의도적으로 **안 하는** 것 (이 슬라이스 범위 밖)

이벤트 전달(진단 구독·신뢰 게이트), Planner/Worker/Reviewer, sandbox/worktree, 승인 흐름, Runtime API
(`/api/runtime/v1/runs`), outbox 복구, Slack. → Phase 2 이후([05](./05-phases.md)).

## 열린 질문 (구현 착수 전 확인)

1. OV `/api/agent/v1/tasks`의 실제 요청 바디 스키마 — OV SPEC §4.3 `Task` + §7 기반이나 `create` 입력 형태 확정 필요
   (`projectId` 필수? `source`/`sourceReference` 채우는 주체?). → OV 팀과 `ov-agent-contracts`에서 합의.
2. OV 서비스 토큰 발급 방식 — 슬라이스에선 mock 토큰. 실제는 OV SPEC §9 service identity.
3. intake agent의 `systemPrompt`/config 키 정확한 이름 — 구현 시 `src/config/types.agents.ts` 확인.
