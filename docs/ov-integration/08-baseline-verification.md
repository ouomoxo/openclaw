# 08 · Baseline 검증

> OV 통합 개발 **착수 전** OpenClaw 업스트림이 로컬에서 정상 빌드·검증되는지 확정한 기록.
> 목적은 단순 빌드가 아니라 **기준선(baseline)** 확정 — 이후 ov-bridge 변경의 회귀를 이 기준과 대조한다.
> 이 검증에서는 기능/core/plugin 코드를 수정하지 않았다(문서 추가만).

## 검증 환경

| 항목 | 값 |
|------|-----|
| 검증 commit SHA | `c5d34c8376f8aa32744786cae0473c60e39ef444` |
| git describe | `v2026.4.19-beta.2-30036-gc5d34c8376` |
| branch / remote | `main` → `origin`(`ouomoxo/openclaw`), `upstream`(`openclaw/openclaw`) |
| clone 종류 | **blobless partial** (`--filter=blob:none`) — blob 지연 fetch |
| package 버전(repo) | `openclaw@2026.6.10` |
| OS / arch | Darwin 25.5.0 / **arm64** (macOS, Apple Silicon) |
| Node | **v22.20.0** (repo 요구 `engines.node >=22.19.0` ✓) |
| pnpm | **11.2.2** (repo `packageManager: pnpm@11.2.2` — corepack 자동 정렬 ✓) |
| 검증 일시 | 2026-06-27 |

## 설치

```
pnpm install --frozen-lockfile
```
- 결과: **성공** (exit 0, 1m30s). node_modules ≈ 2.2G.
- postinstall: 번들 플러그인 레지스트리 **46개 인덱싱**, 네이티브 바이너리 정상 다운로드
  (`esbuild`, `@matrix-org/matrix-sdk-crypto-nodejs` darwin-arm64). git hook prepare 완료.
- 경고/실패 없음.

## 검증 명령과 결과

repo가 공식 정의한 명령(`package.json` scripts) 사용. typecheck는 `tsc --noEmit`가 아니라
**`tsgo` 레인**(repo 규칙, `AGENTS.md:124`).

| 단계 | 명령 | 결과 | 시간 | 비고 |
|------|------|------|------|------|
| build | `pnpm build` (`scripts/build-all.mjs`) | ✅ exit 0 | ~521s | dist 13,312 파일. 경고 1건(아래 W1) |
| typecheck | `pnpm tsgo` (= `tsgo:core`, `tsconfig.core.json`) | ✅ exit 0 | ~13s | 에러 0 |
| unit test | `pnpm test extensions/webhooks` (scoped) | ✅ exit 0 | ~9s | vitest v4.1.8, 3 files / 13 tests 통과 |
| lint | `pnpm lint` (`run-oxlint-shards.mjs` + 타입인지 `tsgolint`) | ✅ exit 0 | ~610s | core/extensions/scripts 샤드 전부 finished, findings 0 |

**4개 검증 명령 전부 통과. 실패 없음.**

### 명령 선택 근거 (step 6 — 분할 검증)
전체 `pnpm check`(아키텍처·docs·import-cycle 등 수십 개 게이트 집계)와 전체 테스트 스위트는
규모가 크고 일부는 Crabbox/Testbox 전용이다(`AGENTS.md:130-137`). baseline은 다음으로 분할:
- **root/전역 검증**: `pnpm build`(전 패키지 번들), `pnpm tsgo`(core 타입), `pnpm lint`(core+extensions+scripts 샤드).
- **plugin/extension 검증**: `pnpm test extensions/webhooks` — ov-bridge가 쓸 **extension 테스트 경로**의 대표.
- **최소 Gateway 검증**: build가 gateway·plugin-sdk·gateway-protocol 패키지를 모두 번들하므로 build 통과로 갈음.
  (런타임 부팅 검증 `openclaw gateway`는 토큰/설정이 필요해 baseline 범위 밖, 슬라이스 단계에서 수행.)

## 알려진 경고 / 분류 (step 7)

수정하지 않고 분류만 한다.

- **W1 — build 청크 크기 경고** (`control-ui` `index` 청크 1,043 kB > 1024 kB).
  - 분류: **업스트림 기존 경고**(perf 권고). 빌드 실패 아님.
  - OV 개발 영향: **없음**. ov-bridge는 control-ui 번들과 무관.
- **환경 메모 — blobless partial clone**: 지연 blob fetch에도 build/typecheck/test/lint 전부 성공 →
  누락 blob 이슈 없음. 분류: **환경(정상)**.
- **환경 메모 — pnpm 11.2.2**: 최초 `pnpm --version`은 사용자 전역 10.23.0이었으나 corepack이 repo
  `packageManager` 핀(11.2.2)으로 자동 전환. 분류: **환경(정상, repo 핀 준수)**.
- **macOS/arm64**: 네이티브 의존(`matrix-sdk-crypto` darwin-arm64, esbuild)이 정상 동작. 플랫폼 이슈 없음.

**실제 repository 결함: 발견되지 않음.**

## 의도적으로 실행하지 않은 검증 (그 이유)

- `pnpm check` 전체 / 전체 테스트 스위트 / Docker·E2E·cross-OS: Crabbox/Testbox 전용 또는 과대 — baseline 범위 밖(`AGENTS.md:135`).
- **docs 린트**(`lint:docs` / `check:docs` / `pnpm docs:check-i18n-glossary`): 실행 안 함. 이유 — 이 디렉터리
  (`docs/ov-integration/**`)의 내가 추가한 `.md`는 Mintlify 규칙(`docs/CLAUDE.md`: 내부 링크는 확장자 없는
  root-relative)과 다른 `./xx.md` 상대링크를 쓴다. 이건 **내 추가 파일의 사항**이지 업스트림 baseline 결함이 아니다.
  공개 docs 네비(`docs/docs.json`)에 포함되지 않으므로 게시에 영향 없음. (필요 시 별도 정리.)

## ov-bridge 변경 후 **반드시 반복할 최소 검증** (회귀 게이트)

ov-bridge 코드를 만들거나 고친 뒤 매번:
```
pnpm tsgo                                  # 타입 회귀
pnpm test extensions/ov-bridge             # 플러그인 단위 테스트
pnpm build                                 # 번들/동적 import 경계 회귀 (published surface 변경 시 필수)
pnpm lint:extensions                       # extensions 샤드만 (전체 lint보다 빠름)
node scripts/profile-extension-memory.mjs --extension ov-bridge   # 메모리 회귀 (src/plugins/AGENTS.md:80-87)
```
broad/E2E/live 증명이 필요하면 Crabbox/Testbox로 위임한다. land 전에는 `$autoreview`(`AGENTS.md:138`).

## 결론

업스트림 OpenClaw(`c5d34c8376`)는 이 머신(macOS arm64, Node 22.20, pnpm 11.2.2)에서
**install·build·typecheck·test·lint 전부 통과**한다. OV 통합 개발의 baseline이 확정됐다.
