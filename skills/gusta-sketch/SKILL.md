---
name: gusta-sketch
description: >-
  기획의 진입점. "/gusta-sketch, 이런 걸 만들고 싶어, 기획하자, 아이디어 있어, 시안 먼저 보여줘, 이 기능 바꾸자,
  스택 정하자" 일 때 사용. 만들 것을 HTML 시안 한 페이지로 그려 로컬 포트 하나에 띄워 보여 주고, 사용자가 고르고
  다듬어 정한 것은 spec 문서(ARCH·SSOT)와 태스크까지 만들고, 아직 정하지 않고 미룬 구상은 ideation 문서에 남긴다. 제품 코드는 고치지 않는다 — 구현은 /gusta-start가
  묻지 않고 실행한다. 코드까지 만들어 비교하려면 gusta-showcase, 화면을 보며 코드를 바로 고치려면 gusta-design-mode.
---

# gusta-sketch — 구상하고 고른다

**역할: 기획 진행자.** 미리 잘 구상해 두면 그다음은 자동으로 돈다 — 이 스킬이 그 "미리"다. AI는 시안·선택지·추천을 만들고 사람은 보고 고른다. 정한 것은 문서와 태스크로 남겨 /gusta-start가 묻지 않고 실행하게 하고, 미룬 것은 ideation 문서에 남겨 다음 sketch의 재료로 쓴다. 기획·기술 판단은 이 스킬이 부르는 내부 스킬(gusta-create-architecture·gusta-create-ssot·gusta-update-ssot·gusta-create-task)이 자기 역할로 한다 — 그 절차를 여기서 다시 쓰지 않는다. 제품 코드·테스트는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 gusta-create-architecture 실행을 안내한다. `settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 하고, agents 미정이면 맡김을 시작하지 않는다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 문서 상태를 STATE에, 세션 기록(시작·상태 변화·활동)을 `vibe` 명령으로만(`beat`·`claim`·`inbox`·`log`) 남기고 SESSIONS.md를 직접 고치지 않는다. 워커는 STATE·SSOT·세션 기록 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. Git 구현은 land·deploy·plan·저장소 기본 브랜치가 아닌 하위 브랜치에서만 하며, 배정된 격리 작업 공간을 쓴다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 inbox(`vibe inbox add`)와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.
5. **읽기**: status 요약·`vibe brief <T###|ID-n|ID@rev> --summary`로 필요한 범위를 찾는다. 큰 brief는 `--section decisions|tasks --offset <n> --limit <n>`으로 원문 블록째 읽고 모든 필요 블록의 coverage를 확인한다. 전체 brief의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 보고서도 필요한 절만 읽고, 출력은 요약·tail, 전체 로그는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`). CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- `vibe status --json`을 본다. spec/이 없거나 스택·구조·검증 명령을 정해야 하면 gusta-create-architecture부터 한다 — 검증 명령이 있어야 /gusta-start가 태스크를 끝까지 검증한다.
- 구상할 것: 사용자의 요청 그대로. 같은 주제의 open/ready ideation 문서가 있으면 이어서 쓴다. 요청이 없으면 status의 남은 기획 재료를 보여 주고 고르게 한다 — 미룬 구상(open/ready ideation), 태스크로 아직 안 쪼갠 SSOT 변경(pending), 채택된 review, 결정함(`vibe inbox list --kind decided`)의 잠정 결정. 이미 정해진 결정은 시안 없이 3절로 간다. 잠정 결정을 바꾸는 요청도 여기서 받는다(gusta-update-ssot 뒤 `vibe inbox resolve --id <id> --log '<한 줄>'`).
- 최초 기획이나 단계 전환은 [제품 지원 정책](../gusta-create-architecture/references/product-support.md)으로 단계·실제 지원 환경/버전·제외·검토 시점의 추천안을 먼저 보여 주고 선택받는다. 기존 승인 범위는 다시 묻거나 줄이지 않고 architecture에 기록을 넘긴다.
- slug=영문 kebab. `vibe log --text 'sketch <slug> start'`.

## 2. 시안 — 보고 고르기
- 화면·흐름·데이터처럼 눈으로 보면 빨리 정해지는 것은 HTML 한 페이지로 그린다: `.tmp/sketch/<slug>/index.html`. `.tmp/`는 git이 추적하지 않는 작업 폴더라 커밋하지 않는다. 외부 리소스 없는 한 파일(인라인 CSS·SVG)로, 아티팩트처럼 보기 좋게 만든다. 동작하는 코드가 아니라 보이는 기획이다 — 실제 화면 같은 정적 목업, 사용자 흐름, 상태별 화면(빈·오류·많음), 필요하면 다이어그램.
- 실제로 갈리는 선택이 있으면 시안을 같은 페이지에 나란히 둔다. 개수는 사용자가 말한 대로, 아니면 2~3개, 갈림이 없으면 하나. 시안마다 이름·한 줄 접근·장단점을 붙이고 추천 하나를 표시한다.
- `vibe sketch serve <slug> --json`으로 포트 하나에 띄우고 url을 알려 준다(떠 있으면 같은 url을 돌려준다). 페이지를 고치면 새로고침만 하면 된다 — 서버를 다시 띄우지 않는다.
- 한 라운드 = 시안 갱신 → 짧은 요약과 선택지형 질문 2~3개 → 답 반영. 사용자가 고를 때까지 돈다. 넓히기(놓친 방향·유사 사례)·좁히기(핵심 하나·안 할 것·v1 경계)·검증(허점·가장 위험한 가정)을 오간다. 결정은 사용자가 한다. 기술 구현 결정은 하지 않는다 — 실현 가능성 우려만 남겨 gusta-create-task로 넘긴다.
- 정책 문구·규칙 하나처럼 볼 것이 없는 변경은 시안을 건너뛰고 3절로 간다.
- level: expert=갈림길만 짧게 / mid=선택지+영향 1줄 / novice=시나리오와 예시로 풀어서.

## 3. 문서와 태스크
고른 시안을 문서로 옮긴다. 대화와 시안에만 있는 합의는 없던 것이 된다.
- 새 도메인은 gusta-create-ssot, 기존 도메인 변경은 gusta-update-ssot를 이 세션에서 이어서 한다. 고른 시안의 결정·안 할 것·v1 경계가 재료이고, 인터뷰는 시안에서 정하지 못한 공백만 묻는다.
- 이어서 gusta-create-task로 실행할 태스크까지 만든다(dep·lane·검증 포함). 개발 질문도 이 세션에서 받는다 — /gusta-start는 묻지 않으므로 여기서 정해 둔다.
- 시안의 핵심 화면이 기대하는 모습은 태스크 acceptance에 말로 적는다(HTML은 커밋되지 않는다).
- ideation 문서의 채택 범위를 SSOT로 옮겼으면 그 SSOT 스킬의 [전환 마감 절차](../gusta-create-ssot/references/ideation.md)로 닫는다(남은 미정 줄이 있으면 ready로 둔다).
- 기획 커밋(spec/만)과 `vibe plan-push`는 각 기획 스킬 절차대로 한다. 코드 반영(`vibe push`)은 하지 않는다.

## 4. 미룬 구상 — ideation 문서
사용자가 "이렇게 하자"고 정하지 않은 것은 SSOT·태스크로 옮기지 않는다. "이 부분은 괜찮은데 나중에 다시 고민하자"처럼 미룬 구상, 아직 고르지 않은 시안의 방향, 남은 질문은 ideation 문서에만 적는다 — 이 문서의 용도는 그것뿐이다.
- 이 스킬 폴더의 assets/ideation.md를 `spec/ideation/<slug>.md`로 복사해 채운다(slug는 활성·done 양쪽에 중복 금지). STATE에 `## ideation`(`| id | st |`)이 없으면 `## ssot` 바로 앞에 추가하고 행 `<slug> | open@YYMMDD`를 둔다.
- vision에 문제·핵심 가치, explored에 시안의 방향을 [o] 채택(정해서 SSOT로 간 것)·[x] 폐기(이유 필수 — 같은 논의를 반복하지 않게)·[?] 미정으로, 미정 질문은 open에. 시안 HTML은 커밋되지 않으니 다시 볼 핵심(화면 구성·흐름)을 말로 남긴다.
- 기록 형식은 `vibe format --section ideation` 발췌를 따른다. ideation 문서와 STATE만 기획 커밋하고 `vibe plan-push`한다.

## 5. 마감
- `vibe sketch stop <slug>`로 서버를 내린다. 시안 파일은 `.tmp`에 남는다 — 다시 부르면 이어서 고친다.
- `vibe log` 1줄. next는 CLI가 태스크로 갱신한다.
- cfg.lang으로 요약: 고른 것 / 버린 것(이유) / 미뤄 ideation에 남긴 것 / 바뀐 SSOT rev·만든 태스크 / "이제 /gusta-start로 실행하면 묻지 않고 진행합니다".
