# 09 · ov-bridge 첫 Vertical Slice (구현 완료)

> 목표 달성: **Telegram(또는 임의 채널) → agent `ov_create_task` → OV API client → 계약 준수 Mock OV →
> `CreateTaskResponse` → taskId 반환.** 실제 NewWorld OV API·SQLite·Planner·Worker는 아직 연결하지 않음.
> 구현체: `extensions/ov-bridge` (+ 공유 계약 `@ouomoxo/ov-agent-contracts`). OpenClaw core 수정 0.

## 흐름

```
agent ─ ov_create_task(input) ─▶ runCreateTask
  ├ resolveOvBridgeConfig(env|pluginConfig)         → CONFIGURATION_ERROR 시 중단
  ├ correlationId/idempotencyKey/sentAt 생성 (bridge)
  ├ buildCreateTaskRequest → parseCreateTaskRequest  → REQUEST_VALIDATION_ERROR 시 네트워크 미호출
  └ createOvApiClient.createTask
        POST {base}/tasks  (Authorization/X-Contract-Version/X-Correlation-ID/Idempotency-Key)
        201/200 → parseCreateTaskResponse + correlation 일치 + status RECEIVED + dedup↔status strict
        4xx/5xx → parseContractError → 정규화 OvBridgeErrorCode
        timeout/network/429/5xx → 제한 retry(동일 key/payload/fingerprint/correlationId)
  ▶ { ok:true, taskId, deduplicated, correlationId, message } | { ok:false, code, retryable, ... }
```

## 구성

- 계약: `@ouomoxo/ov-agent-contracts`를 **git+exact SHA**로 고정(`extensions/ov-bridge/package.json`,
  현재 `95c2c839ab0932964541117b245c1c2469d4e0e8`). `file:`/floating ref 금지. 계약 레포가 `dist`를 vendoring하여
  설치 시 빌드 스크립트가 없어 OpenClaw `allowBuilds`를 건드리지 않음. pnpm-lock.yaml이 이 SHA를 가리킴.
- 환경변수: `OV_API_BASE_URL`, `OV_SERVICE_TOKEN`, `OV_CONTRACT_VERSION`(기본 1.0),
  `OV_REQUEST_TIMEOUT_MS`(10000), `OV_MAX_RETRIES`(2). plugin config(`plugins.ov-bridge`)가 env보다 우선.
- 도구 input/output·HTTP flow·retry·보안 경계 상세: `extensions/ov-bridge/README.md`.

## 결정 로그 (이 슬라이스)

- **D-A 계약 소비 = git+SHA + dist vendoring.** pnpm `allowBuilds` 게이트가 git dep의 `prepare` 빌드를 차단
  (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`)하므로, OpenClaw 워크스페이스 config를 바꾸는 대신 계약 레포에 `dist`를
  커밋해 빌드 불필요한 self-contained git dep으로 만듦. → OpenClaw "core/config 변경 0" 유지.
- **D-B dedup↔status strict.** HTTP 201↔`deduplicated:false`, 200↔`true` 불일치 시 즉시 `INVALID_RESPONSE`
  (초기엔 strict; 추후 warning 완화 여지).
- **D-C idempotency key 파생.** `telegram:<channelId>:<messageId>:create-task`,
  `slack:<channelId>:<thread|message>:<messageId>:create-task`, 그 외 `<channel>:<invocationId>:create-task`.
  같은 메시지 재전송은 dedup, 다른 명령은 비충돌.
- **D-D retry correlationId 유지.** 한 logical request이므로 재시도 시 correlationId 동일(권장안 채택).
  maxRetries=N = 최초 시도 외 추가 N회.

## 검증 (이번 슬라이스 게이트 통과)

- `pnpm tsgo:extensions` (prod) ✅ · `pnpm tsgo:extensions:test` ✅
- `pnpm test extensions/ov-bridge` → **49 tests / 5 files 통과** ✅
- `pnpm lint:extensions` ✅ + plugin-sdk import 경계 검사(no-plugin-sdk-internal / no-relative-outside-package /
  no-src-outside-plugin-sdk) ✅
- `pnpm build` (전체) ✅
- core `src/**` 변경 0, 변경은 `pnpm-lock.yaml`(계약 SHA) + 신규 `extensions/ov-bridge/**`뿐.
- working tree에 실토큰 없음. Mock은 `test-support/`에만 있고 production entry(`index.ts`/`src`)에서 import 안 함.

> 빠른 반복 게이트: `pnpm tsgo:extensions && pnpm test extensions/ov-bridge`.
> ov-bridge 변경 후 회귀 게이트는 [08-baseline-verification.md](./08-baseline-verification.md) 참조(+ `pnpm lint:extensions`, `pnpm build`).

## Mock OV 서버

`extensions/ov-bridge/test-support/mock-ov-server.ts` — **계약 검증 서버**(단순 fixture 아님): Bearer 토큰·
`X-Contract-Version`·correlation/idempotency 헤더↔바디 일치·`parseCreateTaskRequest` 검증, 계약 fingerprint
기반 idempotency store(201 최초 / 200 동일 payload dedup / 409 다른 payload conflict), 구조화 `ContractError`,
configurable failure scenarios(401/403/404/422/429/500/503/delay/malformed/invalid-contract/correlation-mismatch/
connection-close), request recording, 토큰 redaction. Mock 전용 taskId는 결정론적(`task_mock_NNNN`).
**production bundle 미포함**(entry에서 import 안 함). 실행은 테스트(`startMockOvServer`)에서만.

## Telegram 범위

자동화 테스트는 tool 레벨 + 플러그인 로딩(`pluginEntry.register`로 `ov_create_task` 등록 검증)까지 커버.
실제 Telegram E2E는 token/환경 준비 시 수동 smoke만(본 슬라이스 범위 밖). bot token을 fixture/로그에 저장하지 않음.

수동 시나리오: 사용자 "OV 프로젝트 테스트 실패를 분석해" → Intake agent가 `ov_create_task` 호출 →
"Task <id>를 OV에 등록했습니다." 회신.

## lifecycle event — 미지원 (의도적)

`src/plugins/services.ts`의 진단 이벤트 신뢰 게이트, run/tool lifecycle 구독, trusted package signing, core patch는
이번 단계에서 **건드리지 않음**. 첫 슬라이스는 명시적 `ov_create_task` 호출만으로 완료. ([02](./02-openclaw-internals.md) §4·§7)

## 실제 OV 연결 전 남은 작업 (backlog / ADR candidate)

1. **OV `POST /api/agent/v1/tasks` 실제 바디 스키마 확정** — OV 팀과 `ov-agent-contracts`에서 합의(현재
   `NewWorld/src/main/controlplane/` 미구현). create 입력의 `source`/`project` 채우는 주체 확정.
2. **OV 서비스 토큰 발급/주입** — service identity `openclaw-intake`, scope `task:create`/`task:read`,
   256bit 난수, OV는 hash 저장(OV Phase 3).
3. **Intake agent 구성** — `openclaw.json`에서 `agents.intake.tools.allow=["ov_create_task"]` + system prompt,
   Telegram `dmPolicy:"allowlist"` + numeric `allowFrom`. ([06](./06-vertical-slice.md))
4. **lifecycle event 전달**(진단 신뢰 게이트 결정), Runtime API(`/api/runtime/v1/runs`), 승인 흐름 — Phase 2+.
5. 계약 확장 시 `ov-agent-contracts` 새 SHA로 재고정 + lockfile 갱신.
