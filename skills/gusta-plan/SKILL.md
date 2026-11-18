---
name: gusta-plan
description: >-
  기획의 진입점. "/gusta-plan, 기획하자, 이런 걸 만들고 싶어, 요구사항 정리해서 태스크로 만들어줘, 이 기능
  바꾸자, 아이디어 있어, 같이 정리해 보자, 스택 정하자" 일 때 사용. 요구사항을 한 번에 받거나 대화로 함께 키워 spec
  문서(ARCH·SSOT)와 태스크까지 만들고 기획 브랜치 원격에 올린다. 아직 정하지 않고 미룬 구상은 ideation 문서에
  남긴다. 제품 코드는 고치지 않는다 — 구현은 /gusta-start가 묻지 않고 실행한다. 화면·흐름을 눈으로 보고
  골라야 하면 gusta-sketch로, 코드로 만들어 비교해야 하면 gusta-showcase로 이어 준다.
---

# gusta-plan — 말로 정하고 태스크로 남긴다

**역할: 기획 진행자.** 요구사항을 한 번에 받아도, 한 줄 구상에서 시작해 대화로 키워도 끝은 같다 — /gusta-start가 묻지 않고 실행할 태스크가 기획 브랜치 원격에 올라간다. AI는 해석·추천안·문서·태스크를 만들고 사람은 고른다. 말로 좁혀지지 않는 갈림만 gusta-sketch(시안)·gusta-showcase(코드 변형)로 넘긴다. 기획·기술 판단은 이 스킬이 부르는 내부 스킬(gusta-create-architecture·gusta-create-ssot·gusta-update-ssot·gusta-create-task)이 자기 역할로 한다 — 그 절차를 여기서 다시 쓰지 않는다. 제품 코드·테스트는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 gusta-create-architecture 실행을 안내한다. `settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 하고, agents 미정이면 맡김을 시작하지 않는다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 문서 상태를 STATE에, 세션 기록(시작·상태 변화·활동)을 `vibe` 명령으로만(`beat`·`claim`·`inbox`·`log`) 남기고 SESSIONS.md를 직접 고치지 않는다. 워커는 STATE·SSOT·세션 기록 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. Git 구현은 land·deploy·plan·저장소 기본 브랜치가 아닌 하위 브랜치에서만 하며, 배정된 격리 작업 공간을 쓴다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 inbox(`vibe inbox add`)와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.
5. **읽기**: status 요약·`vibe brief <T###|ID-n|ID@rev> --summary`로 필요한 범위를 찾는다. 큰 brief는 `--section decisions|tasks --offset <n> --limit <n>`으로 원문 블록째 읽고 모든 필요 블록의 coverage를 확인한다. 전체 brief의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 보고서도 필요한 절만 읽고, 출력은 요약·tail, 전체 로그는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`). CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- `vibe status --json`을 본다. spec/이 없거나 스택·구조·검증 명령을 정해야 하면 gusta-create-architecture부터 한다 — 검증 명령이 있어야 /gusta-start가 태스크를 끝까지 검증한다.
- 최초 기획이나 단계 전환은 [제품 지원 정책](../gusta-create-architecture/references/product-support.md)으로 단계·실제 지원 환경/버전·제외·검토 시점의 추천안을 먼저 보여 주고 선택받는다. 기존 승인 범위는 다시 묻거나 줄이지 않고 architecture에 기록을 넘긴다.
- 받은 대로 시작한다: 요구사항 묶음(여러 줄·파일·이슈 본문)이면 2절 해석표를 한 번에 채우고, 한두 줄 구상이면 빈 해석표로 3절 대화부터 한다. 같은 주제의 open/ready ideation 문서가 있으면 그 explored·shape·open을 해석표에 올려 이어 간다.
- 인자가 `review/<slug>`·ideation slug처럼 기획 재료를 가리키면 그것부터 한다. 요청이 없으면 status의 남은 기획 재료를 보여 주고 고르게 한다 — 미룬 구상(open/ready ideation), 태스크로 아직 안 쪼갠 SSOT 변경(pending), 채택된 review, 결정함(`vibe inbox list --kind decided`)의 잠정 결정. pending과 채택된 review는 물을 것이 없으면 바로 4절로 간다. 잠정 결정을 바꾸는 요청은 gusta-update-ssot 뒤 `vibe inbox resolve --id <id> --log '<한 줄>'`.
- slug=영문 kebab. `vibe log --text 'plan <slug> start'`.

## 2. 해석표
받은 요구사항을 한 줄씩 나눠 대화에 표로 보여 준다(파일로 쓰지 않는다): 요구사항 · 분류 · 대상(도메인·결정 ID@rev, 새 도메인이면 후보 이름) · 추천안 또는 메모. 기존 결정은 `vibe brief <ID> --summary`로 찾아 필요한 블록만 읽는다.
- **정함**: 사용자가 직접 정한 것. 그대로 문서로 가고 다시 묻지 않는다.
- **공백**: 정하지 않은 것. 추천안 하나와 이유 한 줄을 붙인다.
- **충돌**: 기존 결정과 다른 것. 그 결정 ID@rev와 무엇이 바뀌는지 붙인다.
- **민감**: 과금·데이터 삭제·개인정보·보안. 사용자가 명시하기 전에는 `[?]`로 둔다.
- **볼 것·비교할 것**: 말로는 갈림이 좁혀지지 않는 것 — 5절.
- **미룸·안 할 것**: 6절 ideation 또는 v1 경계로.
요구사항을 조용히 버리지 않는다 — 모든 줄이 문서·태스크·미룸·안 할 것 중 하나로 끝난다.

## 3. 대화 — 사용자가 끝났다고 할 때까지
- 한 라운드 = 해석표 갱신 → 짧은 요약과 선택지형 질문 2~4개(충돌·민감·공백 순) → 답 반영. 정함은 다시 묻지 않는다. 공백·충돌·민감이 없으면 묻지 않고 해석표만 보여 준 뒤 4절로 간다.
- 넓히기(놓친 방향·유사 사례)·좁히기(핵심 하나·안 할 것·v1 경계)·검증(허점·가장 위험한 가정)을 오간다. 결정은 사용자가 한다. 기술 구현 결정은 하지 않는다 — 실현 가능성 우려만 남겨 4절의 gusta-create-task로 넘긴다.
- level: expert=갈림길만 짧게 / mid=선택지+영향 1줄 / novice=시나리오와 예시로 풀어서.
- 공백·충돌이 모두 정해지거나 미룸으로 갈리면 문서와 태스크로 옮기자고 제안한다. 더 다듬고 싶다면 계속 돈다. 도중에 멈추면 정한 것을 지금 옮길지 묻고, 나머지는 6절에 남긴다.

## 4. 문서·태스크·push
정한 해석표를 문서로 옮긴다. 대화에만 있는 합의는 없던 것이 된다.
- 새 도메인은 gusta-create-ssot, 기존 도메인 변경은 gusta-update-ssot를 이 세션에서 이어서 한다. 정함·답한 공백·충돌이 재료이고, 인터뷰는 해석표에서 정하지 못한 공백만 묻는다.
- 이어서 gusta-create-task로 실행할 태스크까지 만든다(dep·lane·검증 포함). 채택된 review는 SSOT 없이 gusta-create-task로 간다. 개발 질문도 이 세션에서 받는다 — /gusta-start는 묻지 않으므로 여기서 정해 둔다.
- ideation 문서의 채택 범위를 SSOT로 옮겼으면 그 SSOT 스킬의 [전환 마감 절차](../gusta-create-ssot/references/ideation.md)로 닫는다(남은 미정 줄이 있으면 ready로 둔다).
- 기획 커밋(spec/만)과 `vibe plan-push`는 각 기획 스킬 절차대로 한다. 원격 기획 브랜치에 올라가야 다른 세션·기기의 /gusta-start가 태스크를 집는다. ID 충돌로 거절되면 다시 채번해 올리고, 그 밖의 실패(원격·인증)는 마감 보고에 그대로 남긴다 — 올라가지 않은 것을 올렸다고 보고하지 않는다. 코드 반영(`vibe push`)은 하지 않는다.

## 5. 넘기기 — 말로 좁혀지지 않을 때
- **볼 것**(화면 구성·흐름·상태별 화면처럼 보면 빨리 정해지는 것): 시안으로 보고 고를지 제안한다. 동의하면 그 항목만 gusta-sketch 2절로 시안을 띄워 고르고, 고른 것은 해석표의 정함으로 돌아와 4절로 함께 간다.
- **비교할 것**(실제 동작감·성능·구현 방식처럼 코드로 만들어 봐야 갈리는 것): /gusta-showcase를 제안한다. 그 스킬이 변형을 코드까지 만들고 채택한 변형의 SSOT를 맞추므로 이 세션에서 태스크로 만들지 않는다 — 비교할 질문을 6절에 남기고 마감 보고에 `/gusta-showcase <비교할 질문>`을 안내한다. 나머지는 4절대로 끝낸다.
- 스택·구조·검증 명령을 바꿔야 하면 gusta-create-architecture를 이 세션에서 이어서 한다.

## 6. 미룬 구상
사용자가 정하지 않고 미룬 것·고르지 않은 방향·남은 질문·비교할 질문은 [미룬 구상 기록](references/ideation.md)대로 ideation 문서에만 남긴다.

## 7. 마감
- 해석표의 모든 줄이 문서·태스크·미룸·안 할 것 중 하나로 끝났는지 확인한다.
- 시안을 띄웠으면 `vibe sketch stop <slug>`. `vibe log` 1줄. next는 CLI가 태스크로 갱신한다.
- cfg.lang으로 요약: 요구사항 → 결정(ID@rev) → 태스크(T###) 대응 / 미뤄 ideation에 남긴 것 / 버린 것(이유) / plan-push 결과(올라간 브랜치, 실패면 이유) / 넘길 곳(`/gusta-showcase` 등) / "이제 /gusta-start로 실행하면 묻지 않고 진행합니다".
