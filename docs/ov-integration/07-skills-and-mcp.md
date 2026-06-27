# 07 · Skills & MCP 활용

> 지침서 §14(Skill 배치)·§22(Skills 보안)를 OpenClaw 현실에 매핑. **중요: 스킬 체계가 둘이다.**

## ⚠️ 두 가지 스킬 체계 (혼동 금지)

1. **OpenClaw 통합 스킬** — `openclaw/skills/`(53개: `github`, `obsidian`, `taskflow`, `coding-agent`,
   `node-connect`, `skill-creator`, `gh-issues` 등). OpenClaw 런타임이 agent에 로드하는 **도구·통합** 스킬.
2. **방법론 스킬** — 지침서 §14가 요구하는 `systematic-debugging`, `differential-review`,
   `test-driven-development`, `verification-before-completion` 등. 이건 Anthropic 계열 **개발 방법론** 스킬로,
   **OpenClaw `skills/`에 그 이름으로 존재하지 않는다**(확인 완료). 일부는 이미 `Mobile/.claude/skills`에 있음
   (`differential-review`, `insecure-defaults`, `property-based-testing`, `frontend-design`, `webapp-testing`,
   `baseline-ui`, `fixing-accessibility`, `fixing-motion-performance`).

→ 지침서 §14 스킬은 **vendoring(가져와 핀 고정)** 대상이다. OpenClaw agent가 이 방법론 스킬을 어떻게 로드하는지는
**Skills Phase 착수 시 추가 조사**(OpenClaw의 skill 로딩 경로 `skills/` + `skill-creator` + agent skill config)가
필요하다. MVP(첫 슬라이스)에는 방법론 스킬이 필요 없으므로 지금 vendoring하지 않는다.

## Agent별 Skill 배치 (지침서 §14)

| Agent | 방법론 스킬 | 출처 후보 |
|-------|-------------|-----------|
| **Intake** | task-intake, ov-task-management, channel-reporting | **신규 작성**(OV 전용, 존재 안 함) |
| **Planner** | architecture, task-planning, threat-model, tool-design, context-degradation | Anthropic 계열 vendoring |
| **Coding Worker** | systematic-debugging, root-cause-tracing, test-driven-development, using-git-worktrees, verification-before-completion, finishing-a-development-branch, frontend-design, webapp-testing | 일부 `Mobile/.claude/skills`, 나머지 vendoring |
| **Reviewer** | differential-review, insecure-defaults, accessibility, verification-before-completion, property-based-testing | 다수 `Mobile/.claude/skills`에 존재 → 재사용 |

**모든 Agent에 모든 Skill을 주지 않는다**(지침서 §14). 역할별로만.

## 핀 고정 정책 (지침서 §14 + §22)

- **commit SHA 고정.** 스킬을 가져올 때 정확한 commit SHA에 핀. 자동 업데이트 금지.
- **source audit.** 가져오기 전 scripts·hooks·binary·network 접근을 검사(§22 Skills).
- vendoring 위치(제안): `openclaw/skills/<name>` 또는 우리 작업 전용 디렉터리. 결정은 Skills Phase에서.
- 매니페스트에 출처 URL·SHA·audit 일자를 기록한 `SKILLS.lock`(또는 유사) 유지.

## MCP 활용

OpenClaw는 MCP 서버를 agent 도구로 소비할 수 있다(`src/config/types.mcp.ts` — `command`/`args` stdio 또는
`url` sse/http; 정규화 `src/config/mcp-config.ts`).

- **OV 연동에서 MCP를 쓰지 않기로 결정**([03](./03-ov-bridge-design.md) D2): OV 도구는 `ov-bridge` 플러그인의
  agent tool로 노출한다. 이유 — MCP는 도구만 노출 가능하나, ov-bridge는 도구 + 이벤트 전달 + Runtime API + 승인
  중계 + outbox를 **한 패키지**로 묶어야 하고, 진단 이벤트 신뢰 게이트도 플러그인이어야 풀 수 있다.
- **MCP가 적합한 경우**: OV와 무관한 외부 서비스를 빠르게 도구로 붙일 때. 그때는 `openclaw.json`의 mcp 설정으로 agent에 attach.

## Claude Code(나)가 이 레포에서 쓰는 것

이 레포에서 개발할 때 내가 참조/활용하는 것:
- **이 문서 세트(`docs/ov-integration/`)** 와 [AGENTS.md](./AGENTS.md) — 매 작업 전.
- **프로젝트 메모리**(`~/.claude/projects/.../memory/`) — repo 전략·OV 앱·계약 포인터.
- OpenClaw 루트 `AGENTS.md` — 빌드/테스트/플러그인 규칙(수정 금지, 읽기만).
- 조사가 필요하면 **읽기 전용 Explore 에이전트**로 병렬 조사 후 문서에 `path:line` 인용을 남긴다.

## 다음 액션 (Skills 관련)

1. (Skills Phase) OpenClaw agent의 방법론-스킬 로딩 경로 조사.
2. Reviewer 스킬을 `Mobile/.claude/skills`에서 audit 후 SHA 고정해 vendoring.
3. Intake 전용 스킬(task-intake/ov-task-management/channel-reporting) 신규 작성.
4. `SKILLS.lock` 도입.
