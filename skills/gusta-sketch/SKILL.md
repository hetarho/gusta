---
name: gusta-sketch
description: >-
  눈으로 보고 고르는 기획. "/gusta-sketch, 시안 먼저 보여줘, 화면 보고 정하자"에 사용. HTML 시안 한 페이지를 띄우고 고른 것을 SSOT·태스크로 만든다. 제품 코드는 고치지 않는다.
---

# gusta-sketch — 보고 고른다

**역할: 기획 진행자(시안).** 보면 빨리 정해지는 기획을 시안으로 그려 고르게 한다 — 말로 정할 수 있는 기획은 gusta-plan의 몫이다. AI는 시안·선택지·추천을 만들고 사람은 보고 고른다. 정한 것은 문서와 태스크로 남겨 /gusta-start가 묻지 않고 실행하게 하고, 미룬 것은 ideation 문서에 남겨 다음 sketch의 재료로 쓴다. 기획·기술 판단은 이 스킬이 부르는 내부 스킬(gusta-create-architecture·gusta-create-ssot·gusta-update-ssot·gusta-create-task)이 자기 역할로 한다 — 그 절차를 여기서 다시 쓰지 않는다. 제품 코드·테스트는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`). CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- `vibe status --json`을 본다. spec/이 없거나 스택·구조·검증 명령을 정해야 하면 gusta-create-architecture부터 한다 — 검증 명령이 있어야 /gusta-start가 태스크를 끝까지 검증한다.
- 구상할 것: 사용자의 요청 그대로. 같은 주제의 open/ready ideation 문서가 있으면 이어서 쓴다. 요청이 없거나 볼 것이 없는 기획(남은 기획 재료 고르기·잠정 결정 바꾸기·이미 정한 결정 옮기기)이면 gusta-plan으로 이어서 한다.
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
사용자가 "이렇게 하자"고 정하지 않은 것(미룬 구상·아직 고르지 않은 시안의 방향·남은 질문)은 SSOT·태스크로 옮기지 않고 [미룬 구상 기록](../gusta-plan/references/ideation.md)대로 ideation 문서에만 적는다.

## 5. 마감
- `vibe sketch stop <slug>`로 서버를 내린다. 시안 파일은 `.tmp`에 남는다 — 다시 부르면 이어서 고친다.
- `vibe log` 1줄. next는 CLI가 태스크로 갱신한다.
- cfg.lang으로 요약: 고른 것 / 버린 것(이유) / 미뤄 ideation에 남긴 것 / 바뀐 SSOT rev·만든 태스크 / "이제 /gusta-start로 실행하면 묻지 않고 진행합니다".
