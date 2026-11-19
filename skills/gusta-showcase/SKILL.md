---
name: gusta-showcase
description: >-
  "/gusta-showcase, A/B로 비교해줘, 여러 방식으로 만들어 보여줘"에 사용. 변형 2~6개를 코드까지 병렬 구현해 포트마다 띄우고, 사용자가 고른 메인을 디자인 모드로 다듬어 반영한다. 코드 없이 시안만 보려면 gusta-sketch.
---

# gusta-showcase — 변형 비교 진행자

**역할: 비교 진행자.** 서로 다른 안을 코드까지 만든 변형을 포트마다 띄우고, 메인은 사용자가 고른다. 사용자가 직접 부를 때만 쓴다 — 맡김에서는 실행하지 않고 inbox parked에 비교 요청을 남긴다. 변형 구현은 하위 세션이 한다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

## 1. 변형 설계
SETTINGS `usage-measurement`가 true인 시작 대화는 [사용량 절차](../gusta-start/references/usage.md)로 작업 전 기준선을 시작하고 마감 응답(실패·주차 포함)에 summary·로컬 artifact를 붙인다(false면 실행하지 않음).
- 요청을 한 문장 목표와 비교 축(디자인·UX·UI·기능·성능)으로 정리한다. 변형 수는 사용자가 말한 대로, 없으면 2개(최대 6).
- 변형마다 접근 하나: 목표·제약은 같고 방식은 확실히 다르게(사소한 차이 여럿보다 의미 있는 차이 하나). 사용자가 말한 안은 그대로 쓴다. 문제 자체가 모호할 때만 한 번 묻는다.
- 변형은 spec/을 고치지 않고 기존 SSOT 결정·계약을 지킨다. 결정을 바꿔야 성립하는 안이면 변형 설명에 그 결정 ID를 적는다.
- UI 비교에 백엔드·인증·시드 데이터가 필요하면 있는 샌드박스(Storybook, ARCH의 mock 스위치)를 $PORT로 띄우고, 없으면 [scaffold](references/scaffold.md)를 읽고 쓴다.

## 2. 준비
`vibe ab start <slug> --variants <n> --shared-file <공통> [--scaffold-prompt <file> | --scaffold <ref>] [--setup '<의존성 설치>'] [--reuse <의존성 폴더> ...] [--copy <미추적 파일> ...] --json`
- 미커밋 변경으로 거절되면(start·main 모두) 사용자 변경을 임의로 커밋하지 않고 묻는다.
- shared: 변형 공통 글 — 목표·제약·지킬 결정(`vibe brief` 블록)·볼 화면·완료 기준.
- setup은 lockfile대로 설치(`npm ci` 등). `--copy`는 `.env.local`처럼 git에 없지만 실행에 필요한 파일만. `--reuse node_modules`(모노레포는 폴더마다)는 설치 대신 복사한다 — 오래된 설치·절대 symlink·postinstall 결과에 기대면 쓰지 않는다.

## 3. 병렬 구현 — 하위 세션
변형마다 그 변형의 접근만 `<dir>/<v>.md`에 쓰고 동시에 띄운다:
- 기본: `vibe ab run <slug> --all --prompt-dir <dir> [--allow-tool '<태스크 검사 명령 규칙>'] --json`을 백그라운드로 한 번(도구·모델은 CLI가 SETTINGS `agents`로 배정 — `--provider`는 사용자가 고를 때만). 한 변형만은 `--variant <v> --prompt-file <file>`.
- 결과에 scaffoldTouched·scaffoldResidue가 있으면 [scaffold](references/scaffold.md)대로 처리한다.
- 네이티브 하위 세션 도구도 된다(worktree 경로·shared+접근을 주고 커밋·서버·scaffold 수정은 금지). 같은 대화에서 역할만 바꿔 변형을 직접 만들지 않는다.
- 변형은 영향 단위 테스트와 빠른 검사만 돌린다.

## 4. 보여 주기
- 화면이 있으면 `vibe ab serve <slug> --command '<개발 서버, 포트는 $PORT>' --json`(ARCH·package.json의 dev 스크립트, 예 `npm run dev -- --port $PORT`). 준비 실패(5xx·무응답)는 로그 tail로 원인을 보고하고 URL이 있다고 말하지 않는다. 3xx·4xx면 그 status도 말한다.
- 사용자에게는 hub URL 하나만 준다 — 변형이 나란히 보이고 메모·choose를 남길 수 있다고 한 줄로. hub가 null이면 serve를 다시 돌린다. 빈 프레임은 앱이 frame을 막는 것 — 새 탭 링크로.
- 성능·동작 비교는 `vibe ab exec <slug> --command '<측정 명령>' --repeat 3 --json`. 실행 사이의 흔들림보다 작은 차이는 차이라고 하지 않는다.
- 비교표 하나: 변형 | 접근 | 측정값 | 볼 곳(view) | 장단점·위험. 판정은 사용자 몫, 추천은 근거와 함께 한 줄만.
- 사용자가 다 봤다고 하면 `vibe ab status <slug> --json`의 feedback(메모·chosen)을 읽는다. chosen은 의사 표시일 뿐 — 확인받고 메인으로 정한다.
- 메인 전에 특정 변형 수정을 원하면(말 또는 메모) `vibe ab run <slug> --variant <v> --follow-up-file <요청만>` 뒤 `vibe ab serve <slug> --variant <v> --command …`(hot reload가 없으면 `--restart`).

## 5. 메인 다듬기와 마감
- 메인이 정해지면 세션 tag(영숫자 2-8자)로 `vibe ab main <slug> --variant <v> --tag <tag> --json`(디자인 모드가 열린다). 메인을 바꾸면 다시 `vibe ab main`.
- 그다음은 gusta-design-mode 2절 루프로 메인 worktree(`main.path`)만 고친다. 다른 변형의 장점("b의 헤더")은 `others`의 path나 `git diff <base> ab/<slug>/<x>`로 보고 옮긴다. scaffold의 줄·파일은 고치지 않는다. 메인 worktree는 프로젝트 밖이라 편집 권한 창이 뜨면 그 경로를 작업 폴더로 추가하게 안내한다(Claude Code는 `/add-dir <path>`).
- 사용자가 끝났다고 하면 gusta-design-mode 4절 마감을 0번(`vibe ab pick`)부터 한다.
- 고르지 않고 끝내면 `vibe ab stop <slug> --remove`(메인의 미커밋 편집으로 거절되면 버릴지 묻는다). 나중에 보겠다면 서버·hub를 두고 `vibe ab status <slug>`의 hub URL을 다시 준다.
