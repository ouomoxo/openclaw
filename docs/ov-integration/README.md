# OV Integration — OpenClaw 측 통합 문서

이 디렉터리는 **OpenClaw를 OV의 실행 런타임으로 연동**하는 작업의 단일 진입점이다.
OpenClaw 레포(이 레포) 안에서 작업할 때 **여기부터 읽는다.**

OpenClaw = **Messaging Gateway + Agent Runtime + Execution Router**.
OV(`~/Desktop/NewWorld`, `~/Desktop/Mobile`) = **Control Plane + System of Record**.
OpenClaw는 canonical Task 상태를 소유하지 않는다. 모든 실행은 OV의 `taskId`/`runId`에 종속된다.

## 읽는 순서

| # | 문서 | 내용 | 언제 읽나 |
|---|------|------|-----------|
| — | [README.md](./README.md) | 진입점 · 황금 규칙 · 네비게이션 | 항상 먼저 |
| 0 | [00-spec-openclaw.md](./00-spec-openclaw.md) | OpenClaw 측 개발 지침서 **원문**(캐노니컬) | 요구사항 확인 시 |
| 1 | [01-architecture.md](./01-architecture.md) | 책임 경계 · 시스템 다이어그램 · 두 레포 토폴로지 | 설계 판단 시 |
| 2 | [02-openclaw-internals.md](./02-openclaw-internals.md) | **OpenClaw 내부 구조 조사 결과**(plugin/tool/hook/gateway/session/sandbox) `path:line` | 구현 위치 찾을 때 — 가장 자주 |
| 3 | [03-ov-bridge-design.md](./03-ov-bridge-design.md) | `extensions/ov-bridge` 구체 설계 · 파일 스켈레톤 · 결정 로그 | ov-bridge 작성 시 |
| 4 | [04-contracts.md](./04-contracts.md) | OV API 표 · 공유 타입 · 이벤트 매핑 · `ov-agent-contracts` 레포 계획 | 계약/스키마 작업 시 |
| 5 | [05-phases.md](./05-phases.md) | OC-Phase 1~9 체크리스트(OpenClaw 시ms과 매핑) | 다음 작업 고를 때 |
| 6 | [06-vertical-slice.md](./06-vertical-slice.md) | 첫 슬라이스: Telegram→Intake→OV create_task→Task ID | 지금 구현할 것 |
| 7 | [07-skills-and-mcp.md](./07-skills-and-mcp.md) | Agent별 Skill 배치 · 핀 고정 · MCP 활용 | Agent 구성 시 |
| 8 | [08-baseline-verification.md](./08-baseline-verification.md) | install/build/typecheck/test/lint baseline 결과 · 회귀 게이트 | 환경/회귀 확인 시 |
| 9 | [09-ov-bridge-vertical-slice.md](./09-ov-bridge-vertical-slice.md) | ov-bridge 첫 슬라이스 구현 결과 · 결정 로그 · 남은 작업 | ov-bridge 작업 시 |

OV 측(Control Plane) 계약의 **진실 공급원**은 OV 레포에 있다:
`~/Desktop/NewWorld/docs/control-plane/`(README → ARCHITECTURE → ROADMAP → SPEC).

## 황금 규칙 (이 작업의 하드 정책)

1. **조사 완료 전 core 코드 수정 금지.** 문서화 단계에서는 `docs/` 외 파일을 만들지 않는다.
2. **OpenClaw core(`src/**`)를 수정하지 않는다** — Extension API(`openclaw/plugin-sdk/*`)로 해결 불가능함을
   문서로 증명한 경우에만 예외. 모든 OV 연동은 **`extensions/ov-bridge`** 플러그인으로 구현한다.
3. **`ov-gateway`/`ov-runtime`를 core에 새로 만들지 않는다.** OpenClaw가 이미 Gateway이자 Runtime이다.
4. **OpenClaw는 상태의 최종 판단자가 아니다.** Task 완료/승인 확정은 OV가 한다. OpenClaw는
   AgentRun 완료를 *보고*할 수 있을 뿐, Task 완료를 *확정*하지 않는다.
5. **OpenClaw는 승인할 수 없다.** 사용자 Telegram 텍스트를 직접 신뢰해 고위험 작업을 실행하지 않는다.
   승인은 OV Approval API에 제출하고 OV의 결과를 기다린다.
6. **공통 타입/JSON Schema는 별도 `ov-agent-contracts` 레포**로 분리한다(양쪽이 의존).
7. 문서/설명은 **한국어**, 코드·식별자·계약 스키마는 **영어**.
8. OpenClaw 플러그인 작성 규칙을 따른다: import는 `openclaw/plugin-sdk/*`와 로컬 `api.ts`/`runtime-api.ts`만.
   `src/**` 딥임포트 금지. 자세한 건 [02-openclaw-internals.md](./02-openclaw-internals.md) §1.

## 현재 상태 (2026-06-27)

- ✅ openclaw fork 클론 + upstream 연결 (`origin` = `ouomoxo/openclaw`, `upstream` = `openclaw/openclaw`)
- ✅ 내부 구조 조사 완료 (이 문서 세트)
- ✅ OV 측 계약 확보 (`NewWorld/docs/control-plane/SPEC.md`)
- ✅ Baseline 검증 완료 — install/build/typecheck/test/lint 전부 통과 ([08](./08-baseline-verification.md), commit `c5d34c8376`)
- ✅ `ov-agent-contracts` 레포 생성 + remote push + SHA 고정 (`95c2c839…`, Draft PR #1)
- ✅ 첫 vertical slice 구현 — `extensions/ov-bridge` (`ov_create_task` + 계약준수 Mock, 49 tests) ([09](./09-ov-bridge-vertical-slice.md))
- ⬜ 실제 OV(NewWorld) API 연결 · Intake agent 구성 · lifecycle event (Phase 2+)

> OpenClaw 레포 루트의 `AGENTS.md`/`CLAUDE.md`는 OpenClaw 프로젝트 자체의 규칙이다. **수정하지 않는다.**
> 우리 작업 규칙은 이 디렉터리의 [`AGENTS.md`](./AGENTS.md)에 있다(telegraph 스타일, read-first).
