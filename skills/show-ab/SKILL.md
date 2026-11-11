---
name: show-ab
description: >-
  "/show-ab, A/B로 비교해줘, 두 가지(여러) 방식으로 만들어서 보여줘, 시안 여러 개 띄워줘, 어느 쪽이 빠른지 비교해줘"일 때
  사용한다. 문제 하나를 서로 다른 접근의 변형 2~6개로 병렬 구현하고(변형마다 브랜치·worktree·하위 세션) 각자 다른 포트에
  띄우거나 같은 측정을 나란히 돌려 보여 준다. 사용자가 고른 변형만 현재 브랜치에 합친다. 디자인·UX·UI·기능·성능 비교. 함께 전용.
---

# show-ab — 변형 비교 진행자

**역할: 비교 진행자(함께 전용).** 서로 다른 안을 실제로 만들어 띄우고, 사용자는 보고 고른다. 변형 구현은 하위 세션이, 브랜치·worktree·커밋·서버·측정·정리는 `vibe ab`가 맡는다. 이 세션은 변형 설계·비교표·채택 기록만 하고 코드를 직접 쓰지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

## 1. 변형 설계
- 요청을 한 문장 목표와 비교 축(디자인·UX·UI·기능·성능)으로 정리한다. 변형 수는 사용자가 말한 대로, 없으면 2개(최대 6 — 변형마다 세션 하나만큼 토큰·시간이 든다).
- 변형마다 접근 하나: 목표·제약은 같고 방식은 확실히 다르게(사소한 차이 여럿보다 의미 있는 차이 하나). 사용자가 안을 말했으면 그대로 쓴다. 문제 자체가 모호할 때만 한 번 묻는다.
- 변형은 실험이다 — spec/을 고치지 않고 기존 SSOT 결정·계약을 모두 지킨다. 결정을 바꿔야 성립하는 안이면 변형 설명에 그 결정 ID를 적는다.
- UI 비교인데 화면에 백엔드·인증·시드 데이터가 필요하면 있는 것(Storybook 등 샌드박스, ARCH의 mock 스위치)을 변형마다 $PORT로 띄우고, 없으면 2절 scaffold.
- 맡김에서는 실행하지 않는다(고를 사람이 없다). inbox parked에 비교 요청을 남긴다.

## 2. 준비
`vibe ab start <slug> --variants <n> --shared-file <공통> [--scaffold-prompt <file> | --scaffold <ref>] [--setup '<의존성 설치>'] [--reuse <의존성 폴더> ...] [--copy <미추적 파일> ...] --json`
- 미커밋 변경이 있으면 거절된다 — 사용자 변경은 임의로 커밋하지 않고 묻는다.
- shared에는 변형 공통 글을 한 번만: 목표·제약·지킬 결정(`vibe brief` 블록)·볼 화면·완료 기준.
- scaffold: 세션 하나가 `ab/<slug>/base`에 화면을 결정적 mock 데이터·인증 stub(가능하면 `?mock=empty|error` 상태도)으로 띄우는 커밋을 만들고 변형은 그 위에서 시작한다. 프롬프트에는 볼 화면·필요한 데이터만, 있는 커밋은 `--scaffold <ref>`. ok:false면 보고하고 `stop --remove`. scaffoldWarnings(고친 UI 파일)가 대상 화면 자체면 scaffold부터 다시.
- setup은 lockfile에 맞는 설치(`npm ci` 등)로 worktree마다 병렬 실행된다. `--copy`는 `.env.local`처럼 git에 없지만 실행에 필요한 파일만.
- `--reuse node_modules`(모노레포는 폴더마다): lockfile대로 설치된 ignored 의존성 폴더를 lockfile이 기준과 같을 때 설치 대신 복사한다(다르면 setup). 오래된 설치·절대 symlink·postinstall 결과는 그대로 복사되거나 빠진다.

## 3. 병렬 구현 — 하위 세션
변형마다 이 변형의 접근만 `<dir>/<v>.md`에 쓰고 동시에 띄운다:
- 기본(헤드리스): `vibe ab run <slug> --all --prompt-dir <dir> --provider <claude|codex> [--allow-tool '<태스크 검사 명령 규칙>'] --json` 하나를 백그라운드로 실행한다(병렬, 끝나면 한 번 알림). 한 변형만은 `--variant <v> --prompt-file <file>`. 세션은 자기 worktree만 고치고, CLI가 shared를 앞에 붙이고 끝나면 변형 브랜치에 커밋한다. 돌아오는 것은 summary·view·path(볼 곳·URL 경로)뿐이다.
- run이 scaffoldTouched(scaffold 줄·파일을 바꾼 곳)·scaffoldResidue(옮겨 쓴 mock 줄)를 주면 보여 주기 전에 되돌리는 follow-up을 보낸다(데이터 변경은 summary로).
- 네이티브 하위 세션 도구를 써도 된다(worktree 경로·shared+접근을 주고 커밋·서버·scaffold 수정은 하지 않게). 같은 대화에서 역할만 바꿔 변형을 직접 만들지 않는다.
- 변형은 영향 단위 테스트와 빠른 검사만 돌린다(전체 스위트는 합친 뒤 마감 관문에서 한 번).

## 4. 보여 주기
- 화면이 있으면 `vibe ab serve <slug> --command '<개발 서버, 포트는 $PORT>' --json`: 변형마다 자기 포트에 띄우고 path가 응답하면 비교 페이지(hub)를 띄운다. 명령은 ARCH·package.json의 dev 스크립트로 고르고 포트 인자가 필요하면 `$PORT`를 넘긴다(예 `npm run dev -- --port $PORT`). 준비 실패(5xx·무응답)는 로그 tail로 원인을 보고하고 URL이 있다고 말하지 않는다. 3xx·4xx면 그 status를 함께 말한다.
- 사용자에게는 hub URL 하나만 준다 — 변형이 나란히 보이고 거기서 메모·choose를 남길 수 있다고 한 줄로. hub가 null이면 serve를 다시 돌린다(서버는 두고 hub만 다시 뜬다). 빈 프레임은 앱이 frame을 막는 것 — 새 탭 링크로.
- 성능·동작 비교는 `vibe ab exec <slug> --command '<측정 명령>' --repeat 3 --json`: 변형을 번갈아 실행해 중앙값·최소·종료 코드·마지막 줄을 모은다(hub에도 표시). 실행 사이의 흔들림보다 작은 차이는 차이라고 하지 않는다.
- 비교표 하나로 보여 준다: 변형 | 접근 | 측정값 | 볼 곳(view) | 장단점·위험. 판정은 사용자 몫이고 추천은 근거와 함께 한 줄만.
- 사용자가 다 봤다고 하면 `vibe ab status <slug> --json`의 feedback(메모·chosen)을 읽는다. chosen은 의사 표시일 뿐 — 확인받고 pick한다.
- 특정 변형을 고쳐 달라고 하면(말 또는 메모) `vibe ab run <slug> --variant <v> --follow-up-file <요청만>`(접근·지난 요약·메모는 CLI가 붙인다). 이어 `vibe ab serve <slug> --variant <v> --command …`는 살아 있는 서버를 두고 응답만 확인한다(hot reload가 없으면 `--restart`).
- "A의 X에 B의 Y"처럼 섞자면 `vibe ab add <slug> --from <A>`로 A에서 이어지는 새 변형을 만들고 그것만 run한다(다른 변형은 `git diff`로 읽힌다).

## 5. 채택과 정리
- `vibe ab pick <slug> --variant <v> --approach '<영어 한 줄 접근>' --json`: 서버·hub를 끄고 그 변형만 현재 브랜치에 merge 커밋으로 합친 뒤 worktree를 정리한다. 변형 브랜치는 `prune-branches`(기본 true, `--prune-branches`면 강제)대로 지운다. 충돌이면 현재 브랜치는 그대로 두고 보고한다.
- pick은 scaffold의 줄·파일만 빼고 합친다(같은 파일의 변형 수정은 남는다). todo(실제 데이터 연결)는 create-task로.
- 채택 기록: pick이 쓴 STATE log 줄(files)을 커밋 하나로 남기고, 채택안이 SSOT 규칙을 바꿨으면 이어서 update-ssot(대안=고르지 않은 변형, 이유=사용자 선택 근거).
- 합친 뒤에는 평소대로 영향 검사, push 직전 마감 관문(start-vibe 4절).
- 고르지 않고 끝내면 `vibe ab stop <slug> --remove`. 나중에 보겠다면 서버·hub를 두고 `vibe ab status <slug>`의 hub URL을 다시 준다.
