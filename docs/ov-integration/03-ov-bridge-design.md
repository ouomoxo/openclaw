# 03 · `extensions/ov-bridge` 설계

> ov-bridge는 OV 연동을 담는 **단일 번들 플러그인**이다. 근거 인용은 [02](./02-openclaw-internals.md).
> 아직 코드를 만들지 않는다 — 이 문서는 구현 청사진이다.

## 책임

ov-bridge가 하는 일:
1. **OV 도구 노출** — `ov_create_task` 등 agent tool(§2). Intake/Planner/Worker가 OV와 대화하는 통로.
2. **OV HTTP 클라이언트** — `/api/agent/v1`(OV SPEC §8) 호출. 인증 헤더·idempotency·재시도·outbox.
3. **이벤트 전달** — 진단 이벤트 버스 구독 → `RuntimeEvent`로 변환 → OV `append_event`(§4 갭 처리).
4. **OpenClaw Runtime API** — `POST /api/runtime/v1/runs` 등(지침서 §24)을 HTTP route로 노출,
   내부적으로 `dispatchGatewayMethod("agent", ...)`에 위임.
5. **승인 중계** — `ov.request_approval` 도구. OpenClaw는 승인하지 않고 OV에 제출만.

ov-bridge가 **하지 않는** 일: Task 상태 소유, 승인 결정, telegram/slack 코드 수정, core `src/**` 수정.

## 파일 스켈레톤 (구현 시)

```
extensions/ov-bridge/
  package.json            # openclaw.extensions:["./index.ts"]; deps: 검증/HTTP; SDK는 devDep
  openclaw.plugin.json    # id:"ov-bridge"; configSchema; activation.onStartup:true;
                          #   contracts.tools:[ov_create_task, ...]; contracts.gatewayMethodDispatch?
  tsconfig.json           # extends ../tsconfig.package-boundary.base.json
  api.ts                  # re-export definePluginEntry, OpenClawPluginApi 등 from openclaw/plugin-sdk/*
  runtime-api.ts          # re-export diagnostic-runtime / http route 런타임 헬퍼
  index.ts                # definePluginEntry({ id, name, register(api){ ... } })
  src/
    config.ts             # api.pluginConfig 해석 (OV base URL, service token ref, allowlist)
    ov-client.ts          # OV /api/agent/v1 클라이언트 (헤더·idempotency·재시도)
    outbox.ts             # 미전송 이벤트 SQLite outbox + 재전송 (지침서 §16 복구)
    tools/
      create-task.ts      # ov_create_task
      get-task.ts         # ov_get_task / ov_list_tasks
      append-event.ts     # ov_append_event
      register-artifact.ts
      request-approval.ts
      ...                 # OV Tool Set 전체 (지침서 §7)
    events/
      service.ts          # registerService → ctx.internalDiagnostics.onEvent 구독
      mapping.ts          # OpenClaw evt.type → RuntimeEvent (갭 합성 포함)
    runtime-api/
      routes.ts           # registerHttpRoute: /api/runtime/v1/runs|health|agents → dispatchGatewayMethod
  index.test.ts           # 매니페스트 contracts.tools == 등록 툴 이름 검증
```

`index.ts` 형태:
```ts
import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createOvTools } from "./src/tools/index.js";
import { createOvEventService } from "./src/events/service.js";
import { registerRuntimeRoutes } from "./src/runtime-api/routes.js";

export default definePluginEntry({
  id: "ov-bridge",
  name: "OV Bridge",
  description: "OV Control Plane 연동: OV 도구, 이벤트 전달, Runtime API.",
  register(api: OpenClawPluginApi) {
    api.registerTool((ctx) => createOvTools(api, ctx), {
      names: ["ov_create_task","ov_get_task","ov_list_tasks","ov_get_project_context",
              "ov_create_plan","ov_request_approval","ov_create_agent_run","ov_append_event",
              "ov_register_artifact","ov_complete_agent_run","ov_fail_agent_run",
              "ov_get_pending_approvals","ov_request_cancel"],
    });
    api.registerService(createOvEventService(api));     // 진단 이벤트 구독 (신뢰 게이트 주의)
    registerRuntimeRoutes(api);                         // POST /api/runtime/v1/runs 등
  },
});
```

## OV 도구 → OV API 매핑

| 도구 이름(OpenClaw) | 지침서 §7 | OV API(`/api/agent/v1`) |
|---------------------|-----------|--------------------------|
| `ov_create_task` | ov.create_task | `POST /tasks` |
| `ov_get_task` | ov.get_task | `GET /tasks/:taskId` |
| `ov_list_tasks` | ov.list_tasks | `GET /tasks` |
| `ov_get_project_context` | ov.get_project_context | `GET /projects/:projectId/agent-context` |
| `ov_create_plan` | ov.create_plan | `POST /tasks/:taskId/plans` |
| `ov_request_approval` | ov.request_approval | `POST /tasks/:taskId/approvals` |
| `ov_create_agent_run` | ov.create_agent_run | `POST /tasks/:taskId/runs` |
| `ov_append_event` | ov.append_event | `POST /tasks/:taskId/events` |
| `ov_register_artifact` | ov.register_artifact | `POST /tasks/:taskId/artifacts` |
| `ov_complete_agent_run` | ov.complete_agent_run | `POST /runs/:runId/complete` |
| `ov_fail_agent_run` | ov.fail_agent_run | `POST /runs/:runId/fail` |
| `ov_get_pending_approvals` | ov.get_pending_approvals | `GET /approvals/pending` |
| `ov_request_cancel` | ov.request_cancel | `POST /runs/:runId/cancel` |

전체 OV API 표·헤더·스코프는 [04-contracts.md](./04-contracts.md).

## 결정 로그

**D1. 단일 플러그인 vs 다중.** → 단일 `ov-bridge`. OV 도구·이벤트·런타임 API·승인 중계가 같은 OV 클라이언트·
인증·outbox를 공유하므로 하나로 묶는다. 비대해지면 `src/` 하위 모듈로 분리(파일은 ~700 LOC에서 쪼갬, `AGENTS.md:212`).

**D2. Intake 진입 = Agent tool(A) vs MCP(B).** → **A(플러그인 agent tool)**. 이벤트 전달·승인 중계·outbox를 한
패키지로 묶을 수 있고, 신뢰 번들로 패키징하면 진단 게이트도 한 번에 해결. MCP는 도구만 노출 가능해 이벤트/런타임 API를
못 담음. ([02](./02-openclaw-internals.md) §6.2)

**D3. OV→OpenClaw run 트리거.** → ov-bridge가 **`POST /api/runtime/v1/runs`(지침서 §24)** HTTP route를 노출하고
내부에서 `dispatchGatewayMethod("agent", ...)`로 위임. admin-http-rpc allowlist에 `agent`를 추가하지 않음(의도적
관리 전용 유지). gateway-protocol 버전도 안 올림. ([02](./02-openclaw-internals.md) §3.3)

**D4. 이벤트 신뢰 게이트(`src/plugins/services.ts:33`).** → run/tool 이벤트 구독에 필요. **선호 순서:**
(1) ov-bridge를 bundled/trusted-official로 패키징해 자연히 부여받기 → (2) 안 되면 그 게이트를 "설정 가능한 신뢰
플러그인 allowlist"로 바꾸는 **최소 core 패치**(이 경우 황금 규칙 §2에 따라 근거 기록 후 사용자 승인). MVP(첫 슬라이스)는
이벤트 전달이 없으므로 이 결정은 Phase 2로 미룬다.

**D5. 누락 이벤트 합성.** → `tool.execution.*`·`exec.process.completed`에서 COMMAND_STARTED/FILE_*/TEST_*/
BUILD_*를 합성(toolName·command 문자열 파싱). 장기적으로 upstream에 이벤트 타입 기여 검토. ([02](./02-openclaw-internals.md) §4.3)

**D6. outbox 저장.** → 공유 상태 DB(`state/openclaw.sqlite`)의 plugin KV 또는 전용 SQLite 스키마. JSON/JSONL 파일
금지(`AGENTS.md:77`). 재시작 후 미전송 이벤트 복구(지침서 §16).

## 매니페스트 스케치 (`openclaw.plugin.json`)
```jsonc
{
  "id": "ov-bridge",
  "name": "OV Bridge",
  "description": "OV Control Plane integration.",
  "activation": { "onStartup": true },           // 이벤트 service·HTTP route를 부팅 시 바인딩
  "contracts": {
    "tools": ["ov_create_task","ov_get_task","ov_list_tasks","ov_get_project_context",
              "ov_create_plan","ov_request_approval","ov_create_agent_run","ov_append_event",
              "ov_register_artifact","ov_complete_agent_run","ov_fail_agent_run",
              "ov_get_pending_approvals","ov_request_cancel"]
    // gatewayMethodDispatch: ["authenticated-request"]  // Runtime API route가 dispatchGatewayMethod 쓸 때
  },
  "configSchema": {
    "type": "object", "additionalProperties": false,
    "properties": {
      "baseUrl":   { "type": "string", "description": "OV API base, e.g. https://ov.local/api/agent/v1" },
      "serviceTokenRef": { "type": "string", "description": "secret ref for OV service token" },
      "contractVersion": { "type": "string", "default": "1.0" },
      "runtimeApi": { "type": "object", "properties": { "enabled": { "type": "boolean" } } }
    }
  }
}
```

## 검증 명령 (구현 후)
`pnpm build` · `pnpm check` · `pnpm test extensions/ov-bridge` ·
`node scripts/profile-extension-memory.mjs --extension ov-bridge ...` (`src/plugins/AGENTS.md:80-87`).
