---
name: show-ab
description: >-
  "/show-ab, A/B로 비교해줘, 두 가지(여러) 방식으로 만들어서 보여줘, 시안 여러 개 띄워줘, 어느 쪽이 빠른지 비교해줘"일 때
  사용한다. 문제 하나를 서로 다른 접근의 변형 2~6개로 병렬 구현하고(변형마다 브랜치·worktree·하위 세션) 각자 다른 포트에
  띄우거나 같은 측정을 나란히 돌려 보여 준다. 사용자가 고른 변형만 현재 브랜치에 합친다. 디자인·UX·UI·기능·성능 비교. 함께 전용.
---

# show-ab — 변형 비교 진행자

**역할: 비교 진행자(함께 전용).** 사람이 고르는 순간을 만든다 — 서로 다른 안을 실제로 만들어 띄우고, 사용자는 보고 고른다. 변형 구현은 하위 세션이, 브랜치·worktree·커밋·서버·측정·정리는 `vibe ab`가 맡는다. 이 세션은 변형 설계·비교표·채택 기록만 하고 코드를 직접 쓰지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

## 1. 변형 설계
- 요청을 한 문장 목표와 비교 축(디자인·UX·UI·기능·성능)으로 정리한다. 변형 수는 사용자가 말한 대로, 없으면 2개(최대 6 — 변형마다 구현 세션 하나만큼 토큰·시간이 든다).
- 변형마다 접근 하나: 목표·제약은 같고 방식은 확실히 다르게(사소한 차이 여럿보다 의미 있는 차이 하나). 사용자가 안을 말했으면 그대로 쓴다. 문제 자체가 모호할 때만 한 번 묻는다.
- 변형은 실험이다 — spec/을 고치지 않고 기존 SSOT 결정·계약을 모두 지킨다. 결정을 바꿔야 성립하는 안이면 변형 설명에 그 결정 ID를 적는다.
- 맡김에서는 실행하지 않는다(고를 사람이 없다). inbox parked에 비교 요청을 남긴다.

## 2. 준비
`vibe ab start <slug> --variants <n> [--setup '<의존성 설치>'] [--copy <실행에 필요한 미추적 파일> ...] --json`
- 변형마다 `ab/<slug>/<a|b|…>` 브랜치·형제 worktree·포트(4101부터 빈 포트)가 생긴다. 미커밋 변경이 있으면 거절된다 — 사용자 변경을 임의로 커밋하지 않고 어떻게 할지 묻는다.
- setup은 lockfile에 맞는 설치(`npm ci`·`pnpm install --frozen-lockfile` 등)로 worktree마다 병렬 실행된다. `--copy`는 `.env.local`처럼 git에 없지만 실행에 필요한 파일만.

## 3. 병렬 구현 — 하위 세션
변형마다 세션 임시 폴더에 프롬프트 파일을 쓴다: 목표, 이 변형의 접근, 지킬 결정(`vibe brief` 블록 또는 SSOT ID), 볼 화면·완료 기준. 그리고 동시에 띄운다:
- 기본(헤드리스): 변형마다 `vibe ab run <slug> --variant <v> --prompt-file <file> --provider <claude|codex> [--allow-tool '<태스크 검사 명령 규칙>'] --json`을 백그라운드로 실행한다. 세션은 자기 worktree만 고치고, 끝나면 CLI가 변형 브랜치에 커밋한다. 돌아오는 것은 summary·view(어디를 보면 되는지)뿐이다.
- 네이티브 하위 세션 도구를 써도 된다(worktree 경로 지정, 커밋·서버 실행은 하지 않게). 같은 대화에서 역할만 바꿔 변형을 직접 만들지 않는다.
- 변형은 영향 단위 테스트와 빠른 검사만 돌린다. 전체 스위트는 채택한 변형을 합친 뒤 평소의 마감 관문에서 한 번.

## 4. 보여 주기
- 화면이 있으면 `vibe ab serve <slug> --command '<개발 서버, 포트는 $PORT>' --json`: 변형마다 자기 포트에 띄우고 준비될 때까지 기다린다. 명령은 ARCH·package.json의 dev 스크립트로 고르고 포트 인자가 필요하면 `$PORT`를 넘긴다(예 `npm run dev -- --port $PORT`). 준비 실패는 로그 tail로 원인을 보고하고 URL이 있다고 말하지 않는다.
- 성능·동작 비교는 `vibe ab exec <slug> --command '<측정 명령>' --repeat 3 --json`: 변형을 번갈아 실행해 중앙값·최소·종료 코드·마지막 줄을 모은다. 실행 사이의 흔들림보다 작은 차이는 차이라고 하지 않는다.
- 비교표 하나로 보여 준다: 변형 | 접근 | URL 또는 측정값 | 볼 곳(view) | 장단점·위험. 판정은 사용자 몫이고 추천은 근거와 함께 한 줄만.
- 특정 변형을 고쳐 달라고 하면 그 변형에만 `vibe ab run`을 다시 돌린다(새 프롬프트에는 요청만). 서버는 `vibe ab serve <slug> --variant <v>`로 그 변형만 다시 띄운다.

## 5. 채택과 정리
- `vibe ab pick <slug> --variant <v> --json`: 서버를 모두 끄고 그 변형만 현재 브랜치에 merge 커밋으로 합친 뒤 worktree를 정리한다. 변형 브랜치는 spec/SETTINGS.md `prune-branches`(기본 true)대로 지운다. false여도 `--prune-branches`를 주면 지운다. 충돌이면 현재 브랜치는 그대로 두고 보고한다.
- 채택 기록은 디자인 마감과 같다: STATE log `- YYMMDD ab <slug>: adopt <v> — <approach>`를 merge 직후 커밋 하나로 남기고, 채택안이 SSOT 규칙을 바꿨으면 이어서 update-ssot(대안=고르지 않은 변형, 이유=사용자 선택 근거).
- 합친 뒤에는 평소대로 영향 검사, push 직전 마감 관문(start-vibe 4절).
- 고르지 않고 끝내면 `vibe ab stop <slug> --remove`(브랜치는 pick과 같은 설정을 따른다). 나중에 보겠다면 서버만 두고 `vibe ab status <slug>`로 다시 보여 준다.
