# Runtime Execution — Independent Security Review (OC-R10)

> 대상: `extensions/agent-runtime/src/**` (실험적 Agent Execution Runtime). 독립 리뷰어(별도 에이전트) 적대적 검토.
> 등급: BLOCKER / HIGH / MEDIUM / LOW / NOTE. 정책: **BLOCKER/HIGH는 수정**, 보안 관련 MEDIUM도 수정, 나머지는 문서화.
> 결과 요약: **BLOCKER 0 · HIGH 3 · MEDIUM 6 · LOW 2 · NOTE 7.**

## HIGH (전부 수정함)

- **H1 — git runner가 `process.env` 전체를 git 자식에 주입** (`worktree.ts` `createDefaultGitRunner`).
  WorktreeManager·ArtifactCollector의 기본 경로라 실제로 동작. `git worktree add`의 `post-checkout` 훅/`core.fsmonitor`가
  **full host env(토큰/SSH)로 임의 코드 실행** 가능. env 최소화 불변식 위반.
  **Fix:** git runner를 sanitized env로 교체(PATH + 전용 HOME만), `GIT_CONFIG_GLOBAL=/dev/null`·`GIT_CONFIG_NOSYSTEM=1`·
  `GIT_TERMINAL_PROMPT=0`, 모든 git 호출에 `-c core.hooksPath=/dev/null -c protocol.ext.allow=never` 주입. ✅ 수정.

- **H2 — forbidden credential 파일 탐지 누락 + 대소문자 + 바이너리 cred redaction 우회** (`artifact-collector.ts`).
  `.p12/.pfx/.jks/.keystore/.p8`, `kubeconfig`/`.kube/config`, `.git-credentials`, `id_dsa/id_ecdsa` 미탐지; `/i` 없어
  `.PEM/.ENV/ID_RSA` 통과; 바이너리 cred는 `git diff --binary`가 키 자료를 patch로 기록(텍스트 redaction 무력).
  **Fix:** 패턴 확장 + 전부 case-insensitive + **forbidden 발견 시 diff artifact를 쓰지 않고 차단**(M4 동시 해결). ✅ 수정.

- **H3 — 빈 `verificationCommands` → 완료가 모델 self-report에만 의존**.
  `[].every()===true`로 `allPassed` 공허참 → `completed = executorStatus==="completed"`(모델 자기보고)만으로 RUN_COMPLETED.
  배너의 "모델이 done이라 해도 완료 아님" 위반.
  **Fix:** `allPassed`에 `evidences.length>0` 요구 → 검증 증거 없으면 completed 불가. ✅ 수정.

## MEDIUM

- **M1 — redaction이 현대 토큰 형식 다수 누락**(`ghp_`/`xox`/`AIza`/`sk-`/`glpat-`/JWT/DB URL). → 패턴 추가. ✅ 수정.
- **M2 — run 식별자/baseBranch charset 미검증 → path traversal + git arg injection**.
  `taskId/runId`가 경로·git 인자로 흐름(`../` 탈출), `baseBranch` 선행 `-`가 git 옵션으로 해석.
  **Fix:** id `^[A-Za-z0-9._-]+$`·`..` 거부; `rev-parse --end-of-options`·선행 `-` baseBranch 거부. ✅ 수정.
- **M3 — `isHighRiskCommand` 우회**(`--eval=`, `-r/--require/--import`, `python -m`). verification 경로(exact allowlist)라 잠재적.
  **Fix:** `=`형·require/import·`python -m` 추가. ✅ 수정.
- **M4 — 비밀 포함 diff artifact가 forbidden 차단 *이전*에 기록**. → H2 fix로 함께 해결(forbidden 시 diff 미기록). ✅ 수정.
- **M5 — SIGKILL이 직접 자식만 종료(자식 트리 누수); worktree git에 abortSignal 미전달**.
  **Fix:** `detached:true` + 프로세스 그룹 `kill(-pid)`. (worktree abortSignal 연결은 후속.) ✅ 부분 수정.
- **M6 — `npm test`/`npm run`은 package.json scripts를 셸로 실행 → argv allowlist 우회**. 모델이 worktree에서 scripts를 수정 가능.
  network 미격리라 exfil 경로. **수용·문서화(production blocker)**; 가능 시 `--ignore-scripts`/고정 package.json. 📝 문서화.

## LOW

- **L1 — validateCommand 후 spawn 사이 cwd TOCTOU**(심볼릭 스왑). cwd는 런타임이 설정(모델 아님)이라 영향 낮음. 📝 문서화(후속: resolved path로 spawn).
- **L2 — SQLite outbox durability가 암묵적(WAL/synchronous pragma 없음)**. **Fix:** `journal_mode=WAL; synchronous=NORMAL` 명시. ✅ 수정.

## NOTE (검증됨/경미)

- productionEligible은 순수 AND이며 항상 false. 정확.
- inspectRecovery는 절대 completed 반환 안 함. 정확.
- worktree는 add/remove --force/prune만, reset/clean/checkout/push/-B 없음 → main tree 불변. 정확.
- network/gitPush/deployment hard-reject, repo allowlist가 git 이전 실행. 정확.
- `isWithinRoot`/`withinAny`가 `sep`로 prefix 오탐 방지, 비존재 경로 fail-closed. 정확.
- `collectText` 절단 시 `truncated` 필드 없음(관측 갭, 누출 아님 — hash는 stored bytes 기준). 📝 후속.
- 다중 run 공유 outbox 시 sequence interleave(eventId dedup은 유지). 경미.

## 조치

- **HIGH 3 + MEDIUM(M1/M2/M3/M4/M5) + L2 수정 완료.** M6/L1/truncated는 production blocker/후속으로 문서화.
- 수정 후 전체 검증 재실행: `pnpm tsgo:extensions`·`tsgo:extensions:test`·`pnpm test extensions/agent-runtime`·`pnpm lint:extensions`·`oxfmt --check`·`pnpm build`.
- M6(`npm` scripts 우회), L1(cwd TOCTOU), ACP 명령 우회(class C), 호스트 격리 부재는 **production gate** 항목(ADR-4)으로 남는다. core patch 없음.
