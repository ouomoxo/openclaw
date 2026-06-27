# AGENTS.md — OV Integration (scoped)

Telegraph style. OV 연동 작업의 read-first 규칙. 루트 `AGENTS.md`(OpenClaw 자체 규칙)에 **추가**되는 것이지
대체가 아니다. 충돌 시 루트가 우선.

## Start

- 이 작업 진입점: [`README.md`](./README.md). 매 작업 전 관련 문서만 읽는다.
- OpenClaw = Gateway+Runtime. OV(`~/Desktop/NewWorld`,`~/Desktop/Mobile`) = Control Plane+SoR. OpenClaw는 Task 상태를 소유하지 않는다.
- OV 계약 진실 공급원: `~/Desktop/NewWorld/docs/control-plane/`. 공유 와이어 타입은 `ov-agent-contracts`(별도 레포).

## Hard policy

- OpenClaw core(`src/**`) 수정 금지. 모든 OV 연동은 `extensions/ov-bridge` 플러그인으로. Extension API로 불가능함을 문서로 증명한 경우에만 core 수정, 그것도 사용자 승인 후.
- core에 `ov-gateway`/`ov-runtime` 신규 구현 금지. OpenClaw가 이미 Gateway·Runtime이다.
- 루트 `AGENTS.md`/`CLAUDE.md` 수정 금지(읽기만).
- 분석/문서화 단계에서는 `docs/ov-integration/**` 외 파일 생성 금지. 구현 단계 진입은 첫 슬라이스([06](./06-vertical-slice.md))부터.
- OpenClaw는 승인하지 않는다. 사용자 텍스트로 고위험 작업 직접 실행 금지 → `ov_request_approval`로 OV에 제출, OV 결과 대기.
- OpenClaw는 Task 완료를 확정하지 않는다. AgentRun 완료만 보고.

## Plugin 규칙 (위반 시 check 실패)

- import는 `openclaw/plugin-sdk/*` + 로컬 `api.ts`/`runtime-api.ts`만. `src/**`·타 extension `src/**` 딥임포트 금지. (`extensions/AGENTS.md:27-31`)
- import-time side effect 금지. 모든 wiring은 `register(api)` 안. (`extensions/AGENTS.md:68-70`)
- `registerTool` 이름은 매니페스트 `contracts.tools`에 선언. 툴 이름은 snake_case(`ov_create_task`).
- 스키마는 TypeBox. enum은 flat string helper(`anyOf` 금지). (`AGENTS.md:282`)
- 런타임 deps는 플러그인 `package.json`. SDK는 devDependency.
- 상태 저장은 SQLite(공유 `state/openclaw.sqlite` plugin KV 또는 전용 스키마). JSON/JSONL 사이드카 금지. (`AGENTS.md:77`)

## Build / test

- `pnpm install` → `pnpm build` → `pnpm check`. 테스트: `pnpm test extensions/ov-bridge`(전체 `vitest` 직접 호출 금지).
- 플러그인 변경 후: `pnpm build` + 메모리 프로파일 `node scripts/profile-extension-memory.mjs --extension ov-bridge`.
- 문서 언어 한국어, 코드·식별자·계약 영어.

## Map

- 내부 구조 인용(`path:line`): [02-openclaw-internals.md](./02-openclaw-internals.md).
- ov-bridge 설계·결정 로그: [03-ov-bridge-design.md](./03-ov-bridge-design.md).
- OV API·공유 타입·이벤트 매핑: [04-contracts.md](./04-contracts.md).
- 단계/슬라이스: [05](./05-phases.md)·[06](./06-vertical-slice.md).

## Investigate before build

- 새 통합/도구를 만들기 전 OpenClaw가 이미 제공하는지 확인(루트 `AGENTS.md` existing-solutions preflight).
- 의존 동작은 소스/타입 직접 확인. 추측 금지. 조사는 읽기 전용 Explore 에이전트로, 결과는 `path:line` 인용으로 문서에 남긴다.
