---
name: gusta-sketch
description: >-
  눈으로 보고 고르는 기획. "/gusta-sketch, 시안 먼저 보여줘, 화면 보고 정하자"에 사용. HTML 시안 한 페이지를 띄우고 고른 것을 SSOT·태스크로 만든다. 제품 코드는 고치지 않는다.
---

# gusta-sketch — 보고 고른다

**역할: 기획 진행자(시안).** 보면 빨리 정해지는 기획을 HTML 시안으로 고르게 하고, 고른 것을 SSOT·태스크로 남긴다. 말로 정할 기획은 gusta-plan, 기획·기술 판단은 내부 기획 스킬이 한다. 제품 코드·테스트는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`. CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- spec/이 없거나 스택·구조·검증 명령·제품 단계를 정하거나 바꿔야 하면 gusta-create-architecture부터 한다.
- 같은 주제의 open/ready ideation이 있으면 이어 쓴다. 요청이 없거나 볼 것이 없는 기획(기획 재료 고르기·잠정 결정 바꾸기·정한 결정 옮기기)은 gusta-plan으로 한다.
- `vibe log --text 'sketch <slug> start'`(slug=영문 kebab).

## 2. 시안 — 보고 고르기
- `.tmp/sketch/<slug>/index.html` 한 파일에 외부 리소스 없이(인라인 CSS·SVG) 보기 좋게 그린다 — 동작 코드가 아닌 정적 목업·사용자 흐름·상태별 화면(빈·오류·많음)·필요하면 다이어그램.
- 실제로 갈리는 선택은 같은 페이지에 나란히 둔다 — 개수는 사용자가 말한 대로, 아니면 2~3개, 갈림이 없으면 하나. 시안마다 이름·한 줄 접근·장단점, 추천 하나 표시.
- `vibe sketch serve <slug> --json`의 url을 알려 준다. 고친 페이지는 새로고침이면 보인다.
- 라운드마다 시안 갱신 → 짧은 요약 + 선택지형 질문 2~3개 → 반영, 사용자가 고를 때까지. 넓히기(놓친 방향)·좁히기(핵심·안 할 것·v1 경계)·검증(가장 위험한 가정)을 오간다. 기술 구현은 정하지 않고 실현 가능성 우려만 gusta-create-task로 넘긴다.
- 볼 것이 없는 변경(정책 문구·규칙 하나)은 시안 없이 3절로.
- level: expert=갈림길만 / mid=선택지+영향 1줄 / novice=시나리오·예시로.

## 3. 문서와 태스크
고른 시안을 이 세션에서 이어서 문서로 옮긴다.
- 새 도메인은 gusta-create-ssot, 기존 도메인은 gusta-update-ssot — 고른 시안의 결정·안 할 것·v1 경계가 재료이고, 시안에서 못 정한 공백만 묻는다. ideation 채택 범위를 옮겼으면 [전환 마감 절차](../gusta-create-ssot/references/ideation.md)로 닫는다.
- 이어서 gusta-create-task로 실행할 태스크까지 만든다. 개발 질문도 여기서 받는다. 핵심 화면이 기대하는 모습은 acceptance에 말로 적는다(HTML은 커밋하지 않는다).
- 코드 반영(`vibe push`)은 하지 않는다.

## 4. 미룬 구상
정하지 않은 것(미룬 구상·고르지 않은 시안의 방향·남은 질문)은 [미룬 구상 기록](../gusta-plan/references/ideation.md)대로 ideation 문서에만 적는다.

## 5. 마감
`vibe sketch stop <slug>`(시안 파일은 `.tmp`에 남아 다시 부르면 이어 고친다). `vibe log` 1줄. cfg.lang 요약: 고른 것 / 버린 것(이유) / 미룬 것 / 바뀐 SSOT rev·만든 태스크 / "이제 /gusta-start로 실행하면 묻지 않고 진행합니다".
