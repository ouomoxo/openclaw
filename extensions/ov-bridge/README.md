# @openclaw/ov-bridge

OV Control Plane 연동 플러그인. **첫 vertical slice** 범위: agent의 `ov_create_task` 도구 →
OV API client → OV(또는 contract-compliant Mock) → `taskId` 반환.

OpenClaw core는 수정하지 않는다. 모든 연동은 이 플러그인 + 공유 계약 패키지로 이뤄진다.

## 범위 (이번 슬라이스)

- `ov_create_task` 도구 등록
- OV 설정 검증, `CreateTaskRequest` 작성·검증, OV HTTP 호출, `CreateTaskResponse` 검증, `ContractError` 파싱
- timeout, 제한된 retry, credential/민감데이터 redaction, agent 친화적 결과 변환

**범위 밖**(추후 Phase): Task 상태 저장, AgentRun, lifecycle event 구독, Planner/Worker/Reviewer,
Artifact, Approval, Telegram core 수정. → [docs/ov-integration/09](../../docs/ov-integration/09-ov-bridge-vertical-slice.md).

## 계약 패키지 (exact SHA 고정)

`@ouomoxo/ov-agent-contracts`를 **git dependency + exact commit SHA**로 소비한다
(`package.json` 참조, 현재 `95c2c839ab0932964541117b245c1c2469d4e0e8`). `file:`·floating ref 금지.
계약 패키지는 `dist`를 vendoring하므로 설치 시 빌드 스크립트가 필요 없다(OpenClaw `allowBuilds` 무변경).

## 설정

환경변수(우선) 또는 plugin config(`openclaw.json`의 `plugins.ov-bridge`)에서 받는다. plugin config가 env보다 우선.

| 환경변수                | 의미                                                | 기본값  |
| ----------------------- | --------------------------------------------------- | ------- |
| `OV_API_BASE_URL`       | OV API base (예: `https://ov.example/api/agent/v1`) | (필수)  |
| `OV_SERVICE_TOKEN`      | OV service Bearer token                             | (필수)  |
| `OV_CONTRACT_VERSION`   | 계약 버전                                           | `1.0`   |
| `OV_REQUEST_TIMEOUT_MS` | 요청 timeout                                        | `10000` |
| `OV_MAX_RETRIES`        | 최초 시도 외 추가 재시도 횟수                       | `2`     |

규칙: `apiBaseUrl`/`serviceToken` 누락 시 도구 호출 시점에 `CONFIGURATION_ERROR`. URL은 **https**, 또는
loopback/사설(RFC1918)/Tailscale(100.64/10)/`.local` 호스트의 http만 허용(외부 평문 http 거부). 토큰은
오류·로그·도구 결과에 출력하지 않는다.

## 도구: `ov_create_task`

Agent는 **의미적 입력**만 준다. `contractVersion`/`correlationId`/`idempotencyKey`/`sentAt`/HTTP 헤더는 bridge가 생성한다.

입력:

```ts
{ projectId?, projectKey?, title, objective, rawInstruction, requestedType?,
  source: { channel: "telegram"|"slack"|"openclaw"|"api", userId, channelId?, threadId?, messageId? } }
```

성공 결과: `{ ok: true, taskId, status: "RECEIVED", deduplicated, correlationId, message }`.
실패 결과: `{ ok: false, code: OvBridgeErrorCode, retryable, correlationId?, message }`.

`correlationId`는 요청마다 생성·로그/요청에 동일 사용·응답과 일치 검증. `idempotencyKey`는 채널 메시지 identity로
안정 생성(`telegram:<channelId>:<messageId>:create-task` 등), 없으면 invocation id. HTTP 전송 전 항상
`parseCreateTaskRequest`로 검증(실패 시 네트워크 호출 안 함).

## HTTP flow

```
POST {apiBaseUrl}/tasks
Authorization: Bearer <token>   X-Contract-Version: 1.0
X-Correlation-ID: <id>          Idempotency-Key: <id>
Content-Type: application/json   body: CreateTaskRequest
```

응답: 201(생성)/200(dedup) → `parseCreateTaskResponse` + correlation 일치 + `status==RECEIVED` + taskId 비어있지 않음

- (strict) HTTP status↔`deduplicated` 일치. 불일치 → `INVALID_RESPONSE`. 오류 응답 → `parseContractError` 후 정규화.
  Node 내장 `fetch` 사용(신규 HTTP 의존 없음).

## Retry

재시도: network error, timeout, HTTP 429/502/503/504, ContractError `retryable===true`.
재시도 안 함: 400/401/403/404/409/422, request/response schema 실패, idempotency conflict.
재시도는 같은 `idempotencyKey`/payload/fingerprint/`correlationId`(한 logical request). exponential backoff + jitter,
budget 제한. `maxRetries=N` = **최초 시도 외 추가 N회**(총 1+N).

## 보안 경계

service token / 전체 Authorization / stack trace / 원본 HTTP 응답 전체 / `rawInstruction` 전문 /
내부 fs path를 결과·로그에 노출하지 않는다(`src/security/redaction.ts`). wire 객체를 DB row/domain으로 직접 쓰지 않는다.

## Mock OV 서버 (테스트 전용)

`test-support/mock-ov-server.ts` — 계약 검증 서버(토큰/헤더/계약/correlation/idempotency 검증, fingerprint 기반
idempotency store, 201/200/409, configurable failure scenarios, request recording, redaction). **production bundle 미포함**
(entry `index.ts`에서 import하지 않음).

## 검증

빠른 게이트:

```
pnpm tsgo
pnpm test extensions/ov-bridge
```

완료 전:

```
pnpm tsgo && pnpm test extensions/ov-bridge && pnpm build && pnpm lint:extensions
```

## 미지원 (이번 슬라이스)

lifecycle event 전달(진단 이벤트 신뢰 게이트, `src/plugins/services.ts`)·Runtime API·승인 흐름은 미구현.
backlog: [docs/ov-integration/09](../../docs/ov-integration/09-ov-bridge-vertical-slice.md) §남은 작업.
