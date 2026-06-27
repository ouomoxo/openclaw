# 02 · OpenClaw 내부 구조 (조사 결과 · 개발 지도)

> 2026-06-27 읽기 전용 조사 결과. 모든 인용은 repo-root 기준 `path:line`.
> ov-bridge를 어디에 어떻게 붙일지 판단할 때 이 문서를 본다. 코드 변경 전 해당 섹션을 재확인할 것.

핵심 요약 (한 문단): OpenClaw는 거대한 pnpm 모노레포다. core(`src/**`)는 **plugin-agnostic**이고,
플러그인은 **오직 `openclaw/plugin-sdk/*`**를 통해서만 core에 접근한다(`AGENTS.md:58-60`).
따라서 OV 연동은 `extensions/ov-bridge` **번들 플러그인**으로 구현한다. 플러그인이 쓸 수 있는 seam:
**Tool 등록**, **HTTP route 등록**, **gateway method 등록/호출**, **service 등록**(+진단 이벤트 구독),
**hook 등록**, **channel 등록**. 이 중 OV 연동에 핵심은 Tool·진단이벤트·gateway dispatch다.

---

## 1. 플러그인 시스템 — ov-bridge의 골격

### 1.1 플러그인을 구성하는 파일
번들 플러그인 = `extensions/<id>/` 워크스페이스 패키지. 최소 파일:

| 파일 | 역할 | 템플릿 |
|------|------|--------|
| `package.json` | `"openclaw": { "extensions": ["./index.ts"] }`, SDK는 **devDependency** `"@openclaw/plugin-sdk": "workspace:*"`, 번들은 `"private": true` | `extensions/webhooks/package.json:7-14` |
| `openclaw.plugin.json` | **코드 실행 없이** 읽히는 매니페스트. 필수 `id`, `configSchema`. `activation`, `contracts` | `extensions/bonjour/openclaw.plugin.json:1-14`, `extensions/webhooks/openclaw.plugin.json:1-51` |
| `tsconfig.json` | `"extends": "../tsconfig.package-boundary.base.json"` | `extensions/webhooks/tsconfig.json:1-16` |
| `index.ts` | `export default definePluginEntry({ id, name, description, register(api){...} })` | `extensions/webhooks/index.ts:46-54` |
| `api.ts` / `runtime-api.ts` | (선택) SDK 재노출 로컬 배럴 | `extensions/webhooks/api.ts:2-7` |
| `src/**`, `index.test.ts` | private 구현 + 매니페스트 계약 테스트 | — |

스캐폴드 생성기 존재: **`openclaw plugins init <id> --name "..."`** → `openclaw plugins build` →
`openclaw plugins validate` (`docs/plugins/tool-plugins.md:16-68`). 툴 전용은 `defineToolPlugin`
(`openclaw/plugin-sdk/tool-plugin`)이 매니페스트 메타를 자동 생성.

### 1.2 SDK import 경로 (이것만 사용)
```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { type OpenClawPluginApi, type PluginLogger, type PluginRuntime } from "openclaw/plugin-sdk/core";
// lazy/async 런타임 헬퍼: openclaw/plugin-sdk/{runtime,webhook-ingress,secret-input-runtime,config-contracts}
```
- `definePluginEntry` 정의: `src/plugin-sdk/plugin-entry.ts:255-280`. 채널 플러그인은 `defineChannelPluginEntry`(`src/plugin-sdk/core.ts:548-594`).
- 활성화 시 넘어오는 컨텍스트 객체 = **`OpenClawPluginApi`**: `src/plugins/types.ts:2611-2927`.
  주요 멤버: `id, name, config, pluginConfig, runtime, logger`(`:2612-2628`), 그리고 seam 메서드:
  `registerTool`(`:2640`), `registerHook`(`:2644`), `registerHttpRoute`(`:2649`), `registerChannel`(`:2653`),
  `registerGatewayMethod`(`:2661`), `registerService`(`:2697`), `registerProvider`(`:2711`),
  `on(hookName,handler)`(`:2922`).
- 로더가 `register(api)`를 호출: `src/plugins/loader.ts:2840-2863`.
- 런타임 task 표면(OV create_task에 유용): `api.runtime.tasks.managedFlows`
  (`src/plugins/runtime/runtime-taskflow.types.ts:74-146`) — 단, 이건 **OpenClaw 내부 TaskFlow**이지
  OV Task가 아니다. OV Task는 HTTP로 만든다(§아래·[04](./04-contracts.md)). 혼동 주의.

### 1.3 작성 규칙 (위반 시 빌드/체크 실패)
- import는 `openclaw/plugin-sdk/*` + 로컬 `api.ts`/`runtime-api.ts`만. `src/**`·타 extension `src/**` 딥임포트 금지,
  패키지 루트 밖 상대 import 금지 (`extensions/AGENTS.md:27-31`). 가드: `scripts/check-extension-plugin-sdk-boundary.mjs`.
- import-time side effect로 가용성 등록 금지 — 모든 wiring은 `register(api)` 안에서 (`extensions/AGENTS.md:68-70`).
- 런타임 deps는 플러그인 자기 `package.json`에. SDK는 devDependency (`extensions/AGENTS.md:34-37`).
- `registerTool`로 등록하는 모든 툴 이름은 **`contracts.tools`에 선언**돼 있어야 함 (안 그러면 하드 에러, §2).

---

## 2. Agent Tool 등록 — `ov.*` 도구 노출

### 2.1 툴 인터페이스
`AgentTool`: `packages/agent-core/src/types.ts:459-485` — `name`, `label`(필수), `description`,
`parameters`(**TypeBox** `Type.Object`), `execute(toolCallId, params, signal?, onUpdate?)`.
타입 소거 변형 `AnyAgentTool`: `src/agents/tools/common.ts:46-57` (SDK 재노출 `src/plugin-sdk/plugin-entry.ts:6`).
결과 헬퍼 `jsonResult(payload)`: `src/agents/tools/common.ts:417`.

### 2.2 등록
`api.registerTool(factory, { names })` — `src/plugins/types.ts:2640-2643`, 구현 `src/plugins/registry.ts:602-655`.
매니페스트 `contracts.tools`에 선언된 이름만 허용(`registry.ts:610-642`). **툴 이름은 snake_case** →
`ov.create_task`가 아니라 **`ov_create_task`**로 등록(점 표기는 MCP 관례). 캐노니컬 예시: `extensions/workboard/`
(`index.ts:8-33`, `src/tools.ts:188-315`, `openclaw.plugin.json:10-40`).

### 2.3 스키마 검증 (TypeBox, zod 아님)
`Type.Object({...}, { additionalProperties: false })`. **enum은 flat string helper** 사용 —
`Type.Union([Type.Literal(...)])` 금지(일부 provider가 `anyOf` 거부, `AGENTS.md:282`).
헬퍼: `stringEnum/optionalStringEnum` `src/agents/schema/string-enum.ts:17-39`.

### 2.4 Agent별 툴 스코프 (Intake는 ov_*만)
Agent config `tools?: AgentToolsConfig` (`src/config/types.agents.ts:156`, 타입 `src/config/types.tools.ts:398-435`):
`profile`(`minimal|coding|messaging|full`), `allow`, `alsoAllow`, `deny`. 매처: `src/agents/tool-policy-match.ts:8-46`
— **deny가 항상 우선, allow 비어있으면 deny 안 된 전체 허용, allow 채워지면 strict allowlist, glob 지원.**
→ Intake Agent는 `openclaw.json`에서:
```jsonc
{ "agents": { "intake": { "tools": { "allow": ["ov_*"] } } } }
```
이렇게 하면 shell/file/git 자동 배제. 방어적으로 `"deny": ["bash","exec","apply_patch","write","read","process"]` 추가 가능.

---

## 3. Gateway 프로토콜 & AgentRun 호출

### 3.1 프로토콜
`packages/gateway-protocol/*` = **WebSocket 와이어 계약**(typebox만 의존). 프레임: `req/res/event`
(`packages/gateway-protocol/src/schema/frames.ts:152,163,175`). 메인 run 요청 스키마 `AgentParamsSchema`
(`packages/gateway-protocol/src/schema/agent.ts:185`) — `message`(필수), `agentId?`, `sessionKey?`,
필수 `idempotencyKey`(이게 **runId**가 됨). `agent.wait`(`:265`), 스트리밍 `AgentEventSchema`(`:57`).
버전 `PROTOCOL_VERSION = 4` (`packages/gateway-protocol/src/version.ts:2-6`). **버전 bump은 owner 확인
필요한 파괴적 변경**(`AGENTS.md:106-107`, 가드 `native-protocol-levels.guard.test.ts`).
→ **ov-bridge는 이 버전을 올리지 않는 경로로 설계한다.**

### 3.2 run이 실제로 시작되는 경로
모든 ingress는 **`agentCommandFromIngress`**(`src/agents/agent-command.ts:2526`) → `runEmbeddedAgent`
(`src/agents/embedded-agent-runner/run.ts:602`, 루프 `:1885`)로 수렴. WS 경로: 채널 → `request("agent", ...)`
→ `agentHandlers.agent`(`src/gateway/server-methods/agent.ts:984`) → `dispatchAgentRunFromGateway`(`:834`)
→ `agentCommandFromIngress`(`:880`).
run 종결 상태: `src/agents/agent-run-terminal-outcome.ts` — reasons `completed|hard_timeout|timed_out|
cancelled|aborted|blocked|failed`(`:18`), `cancelled` 우선·`hard_timeout` sticky(`:196`).

### 3.3 OV → OpenClaw run 트리거 (옵션 비교)
| 방법 | 경로 | 평가 |
|------|------|------|
| **OpenAI 호환 HTTP** | `POST /v1/chat/completions`(`src/gateway/openai-http.ts:884`), `POST /v1/responses`(`src/gateway/openresponses-http.ts:461`) — 둘 다 `agentCommandFromIngress` 직접 호출, gateway-auth | **가장 마찰 적음**. 프로토콜 버전 작업 불필요 |
| **네이티브 WS** | OV가 `@openclaw/gateway-client`로 `client.request("agent", ...)` (`packages/gateway-client/src/client.ts:1629`) | 가장 제어력 큼(sessionKey/deliver/idempotencyKey/스트리밍). WS 핸드셰이크 필요 |
| **admin-http-rpc** | `POST /api/v1/admin/rpc`(`extensions/admin-http-rpc/index.ts:13`), allowlist `src/methods.ts:5-55` | **`agent` 미포함** → 인터랙티브 run 직접 시작 불가. 단 `tasks.{list,get,cancel}`·`cron.run`·`config`·`channels`는 가능 → **OV→OpenClaw 제어용 surface로 적합** |
| **in-process(플러그인)** | `dispatchGatewayMethod("agent", params, {expectFinal:true})` (`src/plugin-sdk/gateway-method-runtime.ts:42`), 플러그인 route가 `contracts.gatewayMethodDispatch: ["authenticated-request"]` 선언 시 | ov-bridge가 OpenClaw 안에서 run을 시작/관찰할 때 |

> 권장: **OV→OpenClaw 제어**는 OpenClaw 측 `POST /api/runtime/v1/runs`(지침서 §24)를 ov-bridge의 HTTP route로
> 구현하고, 내부에서 `dispatchGatewayMethod("agent", ...)`로 위임. admin-http-rpc의 allowlist에 `agent`를
> **추가하지 않는다**(의도적으로 관리 전용). 자세한 결정은 [03](./03-ov-bridge-design.md).

---

## 4. Hook & 라이프사이클 이벤트 — OV로 이벤트 전달

### 4.1 두 시스템 (혼동 주의)
1. **`src/hooks/` 내부 훅** (`registerInternalHook`, `src/hooks/internal-hooks.ts:220`): 5개 거친 패밀리뿐 —
   `command|session|agent|gateway|message` (`src/hooks/internal-hook-types.ts:2`). tool/run/file 이벤트 **없음.** → 부적합.
2. **`src/infra/diagnostic-events.ts` 진단 이벤트 버스**: 실제 라이프사이클 텔레메트리. `run.started/completed`,
   `tool.execution.*`, `model.call.*`, `exec.process.completed`, `message.*`, `session.*`. → **이걸 구독해야 함.**

### 4.2 구독 방법과 ⚠️ 신뢰 게이트
- 공개 API `onDiagnosticEvent`(`openclaw/plugin-sdk/diagnostic-runtime`)는 **trusted 이벤트를 필터링**해서 버림
  (`src/infra/diagnostic-events.ts:1284`). run/tool 이벤트는 trusted로 발행되므로 **여기로는 안 옴.**
- 실제 피드는 service의 `start(ctx)`에서 **`ctx.internalDiagnostics.onEvent(...)`** 구독. 그러나 이 capability는
  **id가 `diagnostics-otel`/`diagnostics-prometheus`이고 origin이 bundled일 때만** 부여(`src/plugins/services.ts:31-37,52-59`).
  → **ov-bridge가 run/tool 이벤트를 받으려면 번들/신뢰 플러그인으로 패키징하거나, 그 게이트 allowlist에 `ov-bridge`를
  추가해야 한다.** 이건 core 수정에 해당하므로 [03](./03-ov-bridge-design.md)에서 결정 필요(=Extension API로 불가능한 예외 후보).
- 템플릿: **`extensions/diagnostics-prometheus/`** (`index.ts:7`, `src/service.ts:1024-1029` 구독, `:554-993`
  `switch(evt.type)` 디스패치). 이걸 복사해 Prometheus store를 OV HTTP 클라이언트로 교체.

### 4.3 OV 이벤트 ↔ OpenClaw 이벤트 매핑 (갭 명시)
| OV 이벤트 | OpenClaw `evt.type` | 출처 |
|-----------|---------------------|------|
| RUN_STARTED | `run.started` | `diagnostic-events.ts:527`, emit `src/agents/harness/lifecycle.ts:241` |
| RUN_HEARTBEAT | `run.progress`(per-run) / `diagnostic.heartbeat`(gateway-wide) | `:359` / `:367` |
| RUN_BLOCKED | `run.completed` outcome=`blocked` | `:531-537` |
| RUN_FAILED | `run.completed` outcome=`error`, `harness.run.error` | `:531-537`,`:572` |
| RUN_COMPLETED | `run.completed` outcome=`completed` | `:531`, emit `lifecycle.ts:271` |
| TOOL_CALL_STARTED | `tool.execution.started` | `:458`, emit `src/agents/agent-tools.before-tool-call.ts:1481` |
| TOOL_CALL_COMPLETED | `tool.execution.completed` | `:462`, `…before-tool-call.ts:1526` |
| TOOL_CALL_FAILED | `tool.execution.error`(+`.blocked`) | `:467/:474`, `…:1544/:1423` |
| COMMAND_COMPLETED | `exec.process.completed` | `:496`, `src/agents/bash-tools.exec-runtime.ts` |
| COMMAND_STARTED | **갭** — 이벤트 없음 | — |
| FILE_CREATED/MODIFIED/DELETED | **갭** — `tool.execution.*`의 `toolName`(Write/Edit)으로 유추 | `:447-465` |
| TEST/BUILD_* | **갭** — `tool.execution.*`/`exec.process.completed`로 유추 | — |
| ARTIFACT_CREATED | **갭** — OpenClaw에 `artifact.*` 이벤트 없음 | — |

→ **갭 처리:** ov-bridge가 `tool.execution.*`/`exec.process.completed`에서 command 문자열·toolName을 보고
COMMAND_STARTED, FILE_*, TEST_*, BUILD_*를 **합성**하거나, upstream에 이벤트 타입 기여(PR). MVP에서는 run/tool
이벤트만 전달하고 나머지는 합성으로 채운다.

---

## 5. Session · Sandbox · Executor(ACP) — 후속 Phase 재사용 자산

### 5.1 세션/상태 저장
- **채팅 세션 레지스트리**: `SessionEntry`(`src/config/sessions/types.ts:213`), 아직 **JSON 파일**
  `agents/<id>/sessions/sessions.json`(`src/config/sessions/paths.ts:36`) — SQLite 마이그레이션 진행 중인 레거시.
- **공유 상태 DB** `state/openclaw.sqlite`(`src/state/openclaw-state-db.ts`, Kysely): `acp_sessions`,
  `sandbox_registry_entries`(`src/state/openclaw-state-schema.sql:527,745`).
- **per-agent DB** `agents/<id>/agent/openclaw-agent.sqlite`.
- ov-bridge가 OV 관련 메타(미전송 이벤트 outbox 등)를 저장한다면 공유 상태 DB의 plugin KV를 따른다(`AGENTS.md:79`).

### 5.2 Sandbox (재사용 — 직접 만들지 말 것)
`SandboxBackend` 레지스트리: `src/agents/sandbox/backend.ts:56`(register), 백엔드 **docker**(`:111`)·**ssh**(`:117`).
scope `session|agent|shared`(`src/agents/sandbox/types.ts:74`, 해석 `config.ts:80`). 워크스페이스 부트스트랩
`ensureSandboxWorkspace`(`src/agents/sandbox/workspace.ts:23`) — 여기에 worktree 경로를 `workspaceDir`로 주입.
SDK 노출 `src/plugin-sdk/sandbox.ts`. → 지침서 §12 VPS Sandbox는 이 docker 백엔드 설정으로 충족.

### 5.3 Git worktree
**전용 매니저 없음.** 격리는 per-session sandbox workspace로 함. 지침서 §13 worktree-per-run은 우리가
worktree 생성 헬퍼를 추가하고 경로를 `workspaceDir`/세션 `cwd`로 넘기는 식으로 구현(소량 신규 코드, 플러그인 측 가능).

### 5.4 Executor 추상화 = ACP 하네스
OpenClaw는 외부 코딩 에이전트를 **ACP(Agent Client Protocol)**로 실행:
- `packages/acp-core/` (프로토콜 코어, 세션 store/identity), `extensions/acpx/`(런타임·에이전트 레지스트리 =
  `{command,args,cwd}` spawn, `src/config-schema.ts:46`), `src/acp/control-plane/manager.ts`(세션 lifecycle·turn·failover).
- **Codex 이미 연결됨**: `@zed-industries/codex-acp@0.15.0`(`extensions/acpx/src/codex-auth-bridge.ts:24`),
  심층 통합 `extensions/codex/src/app-server/`. Claude/opencode/gemini도 같은 레지스트리의 에이전트 id.
- → 지침서 §11 `CodexExecutor`/`ClaudeCodeExecutor`는 **acpx 에이전트 레지스트리 항목**으로 매핑. 새로 spawn/프로토콜
  구현하지 말 것. 우리 `Executor` 인터페이스는 `AcpRuntime.ensureSession/startTurn`의 얇은 어댑터.

### 5.5 Local Mac Node
`src/node-host/`(gateway 연결 실행 호스트, `runner.ts:207` local/remote, **Tailscale 지원** `skills/node-connect/SKILL.md`)
또는 `ssh` sandbox 백엔드(`src/agents/sandbox/ssh-backend.ts:114`)로 Mac 타깃. **crabbox/testbox는 CI 전용,
런타임 아님** — 혼동 금지.

---

## 6. Telegram 채널 & Intake 진입 — 첫 슬라이스 경로

### 6.1 인입→Agent 경로
라이브러리 **grammY**(polling 기본). 진입 `extensions/telegram/index.ts:4`(`defineBundledChannelEntry`).
경로: `bot.on("message")`(`extensions/telegram/src/bot-handlers.runtime.ts:3385`) → 인증 게이트
`authorizeInboundMessage`(`:3156`) → debounce → `dispatchTelegramMessage`(`src/bot-message-dispatch.ts:743`) →
**`runChannelInboundEvent`**(`openclaw/plugin-sdk/channel-inbound`, `:1908`) = **core agent loop**.
turn이 도는 Agent는 라우팅 `route.agentId`/`route.sessionKey`(`src/routing/resolve-route.ts`)가 결정.

### 6.2 Intake를 붙이는 위치 (채널·core 수정 없이)
채널은 transport-only. Intake는 **Agent tooling + agent config**로 붙인다(텔레그램 코드 수정 ✗):
- 방법 A(권장): ov-bridge가 `ov_create_task` 등 **agent tool**을 등록하고, 텔레그램이 라우팅하는 **intake agent**를
  `openclaw.json`에 구성(`tools.allow=["ov_*"]` + system prompt). 반환된 Task ID는 기존 outbound 파이프라인으로 자동 회신.
- 방법 B(대안): **MCP server**로 `create_task` 노출(`src/config/types.mcp.ts`) 후 agent에 attach. 채널 비종속이라 OK지만
  ov-bridge 플러그인 방식이 이벤트/승인까지 한 패키지로 묶기 좋아 A를 택함([03](./03-ov-bridge-design.md) 결정 로그).

### 6.3 인증/allowlist
**numeric Telegram user ID만**(`extensions/telegram/src/allow-from.ts:16`), `@username` 거부 경고
(`src/bot-access.ts:34-58`). DM 기본 `dmPolicy:"pairing"`(미지 사용자에 pairing 코드, `src/config/types.telegram.ts:120`),
그룹 기본 `groupPolicy:"allowlist"`(`security-audit.ts:82`). 설정: `channels.telegram.allowFrom`(DM),
`groupAllowFrom`+`groups`(음수 chat ID), `dmPolicy`, `groupPolicy`(`types.telegram.ts:118-153`).
토큰: `channels.telegram.accounts.<id>.botToken`/`tokenFile` 또는 `TELEGRAM_BOT_TOKEN`(`monitor.ts:159`),
creds는 `~/.openclaw/credentials/`(`AGENTS.md:252`).
> 슬라이스 주의: 신규 DM은 기본 `pairing`이라 첫 메시지가 agent turn이 아니라 pairing 챌린지를 받음.
> 슬라이스에선 `dmPolicy:"allowlist"` + 본인 numeric ID를 `allowFrom`에 넣는다.

---

## 7. core 수정이 필요할 수 있는 지점 (Extension API 한계 후보)
1. **진단 이벤트 신뢰 게이트**(`src/plugins/services.ts:33`)에 `ov-bridge` 추가 — run/tool 이벤트 구독에 필요.
   대안: ov-bridge를 신뢰 번들로 패키징 / upstream에 "신뢰 플러그인 allowlist 설정화" 기여.
2. **누락 이벤트 타입**(command.started/file.*/test.*/build.*/artifact.*) — MVP는 합성으로 우회, 장기는 upstream 기여.

이 둘 외에 OV 연동 MVP는 **core 수정 없이** 플러그인 seam만으로 가능하다. core 수정이 불가피하다고 판단되면 먼저
이 문서에 근거를 적고 사용자 승인을 받는다(황금 규칙 §2).
