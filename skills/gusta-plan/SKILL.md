---
name: gusta-plan
description: >-
  기획 진입점. "/gusta-plan, 기획하자, 이런 걸 만들고 싶어, 이 기능 바꾸자, 스택 정하자"에 사용. 요구사항을 정해 SSOT·태스크까지 만들어 올린다. 화면을 보고 고르려면 gusta-sketch, 코드로 비교하려면 gusta-showcase.
---

# gusta-plan — 말로 정하고 태스크로 남긴다

**역할: 기획 진행자.** 요구사항을 정해 /gusta-start가 묻지 않고 실행할 태스크까지 기획 브랜치에 올린다. 기획·기술 판단은 내부 기획 스킬이 하고, 제품 코드·테스트는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`. CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- spec/이 없거나 스택·구조·검증 명령·제품 단계를 정하거나 바꿔야 하면 gusta-create-architecture부터 한다.
- 요구사항 묶음(여러 줄·파일·이슈 본문)이면 2절 해석표를 한 번에 채우고, 한두 줄 구상이면 빈 해석표로 3절 대화부터 한다. 같은 주제의 open/ready ideation이 있으면 그 explored·shape·open을 해석표에 올린다.
- 인자(`review/<slug>`·ideation slug)가 있으면 그것부터, 요청이 없으면 남은 기획 재료(ideation, SSOT pending, 채택된 review, `vibe inbox list --kind decided`)를 보여 고르게 한다. pending·review는 물을 것이 없으면 바로 4절로. 잠정 결정을 바꾸면 gusta-update-ssot 뒤 `vibe inbox resolve --id <id> --log '<한 줄>'`.
- `vibe log --text 'plan <slug> start'`(slug=영문 kebab).

## 2. 해석표
요구사항을 한 줄씩 대화에 표로 보여 준다(파일 아님): 요구사항 · 분류 · 대상(도메인·ID@rev 또는 새 도메인 후보) · 추천안/메모.
- **정함**: 사용자가 정한 것 — 그대로 문서로 가고 다시 묻지 않는다.
- **공백**: 추천안 하나 + 이유 한 줄. **충돌**: 기존 결정 ID@rev와 바뀌는 점.
- **민감**: 과금·데이터 삭제·개인정보·보안 — 사용자가 명시하기 전에는 `[?]`.
- **볼 것·비교할 것**은 5절, **미룸·안 할 것**은 6절 또는 v1 경계.
요구사항을 조용히 버리지 않는다 — 모든 줄이 문서·태스크·미룸·안 할 것 중 하나로 끝난다.

## 3. 대화 — 사용자가 끝났다고 할 때까지
- 라운드마다 해석표 갱신 → 짧은 요약 + 선택지형 질문 2~4개(충돌·민감·공백 순) → 반영. 물을 것이 없으면 4절로.
- 넓히기(놓친 방향)·좁히기(핵심·안 할 것·v1 경계)·검증(가장 위험한 가정)을 오간다. 기술 구현은 정하지 않고 실현 가능성 우려만 gusta-create-task로 넘긴다.
- level: expert=갈림길만 / mid=선택지+영향 1줄 / novice=시나리오·예시로.
- 다 정해지거나 미뤄지면 문서로 옮기자고 제안한다. 도중에 멈추면 정한 것을 지금 옮길지 묻고 나머지는 6절로.

## 4. 문서·태스크·push
정한 해석표를 이 세션에서 이어서 문서로 옮긴다.
- 새 도메인은 gusta-create-ssot, 기존 도메인은 gusta-update-ssot — 해석표에서 못 정한 공백만 묻는다. ideation 채택 범위를 옮겼으면 [전환 마감 절차](../gusta-create-ssot/references/ideation.md)로 닫는다.
- 이어서 gusta-create-task로 실행할 태스크까지 만든다(채택된 review는 SSOT 없이). 개발 질문도 여기서 받는다.
- `vibe plan-push` 실패는 보고에 그대로 남긴다 — 올라가지 않은 것을 올렸다고 보고하지 않는다. 코드 반영(`vibe push`)은 하지 않는다.

## 5. 넘기기
- **볼 것**(화면 구성·흐름·상태별 화면): 시안을 제안하고, 동의하면 그 항목만 gusta-sketch 2절로 띄워 고른 뒤 정함으로 돌아와 4절로 간다.
- **비교할 것**(동작감·성능·구현 방식): /gusta-showcase를 제안한다 — 그 스킬이 구현·SSOT까지 맡으므로 태스크로 만들지 않는다. 질문을 6절에 남기고 보고에 `/gusta-showcase <비교할 질문>`을 안내한다.

## 6. 미룬 구상
미룬 것·고르지 않은 방향·남은 질문·비교할 질문은 [미룬 구상 기록](references/ideation.md)대로 ideation 문서에만 남긴다.

## 7. 마감
시안을 띄웠으면 `vibe sketch stop <slug>`. `vibe log` 1줄. cfg.lang 요약: 요구사항 → 결정(ID@rev) → 태스크(T###) / 미룬 것 / 버린 것(이유) / plan-push 결과(브랜치, 실패 이유) / 넘길 곳 / "이제 /gusta-start로 실행하면 묻지 않고 진행합니다".
