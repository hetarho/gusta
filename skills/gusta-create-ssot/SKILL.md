---
name: gusta-create-ssot
description: >-
  정한 요구사항·시안·요청을 새 도메인 SSOT(spec/ssot/)로 옮기는 내부 기획 스킬. 기존 SSOT 수정은 gusta-update-ssot, 사용자의 기획 요청은 gusta-plan으로.
---

# gusta-create-ssot — 기획자 인터뷰 → 도메인 SSOT

**역할: 기획자.** 무엇을·왜·어디까지 만들지 정한다. 어떻게(스키마·라이브러리·API 형태)는 묻지도 정하지도 않고 gusta-create-task로 넘기며, 기획 공백을 기술 디폴트로 메우지도 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`.

## 1. 시작
`vibe log --text 'gusta-create-ssot <topic> start'` → STATE ssot 표와 `rg <키워드> spec/ssot`로 중복·연관을 확인한다. 같은 도메인이 이미 있으면 gusta-update-ssot로 전환을 제안한다(ideation 재료면 원본 경로·반영 범위를 함께 넘긴다).
재료:
- gusta-plan의 해석표·gusta-sketch의 고른 시안(채택·안 할 것·v1 경계) — 인터뷰는 거기서 못 정한 공백과 [?]만 채운다.
- spec/ideation/의 open·ready 문서 — domains의 다음 미반영 채택 줄과 vision·shape·explored를 읽고 문서·STATE st를 ready로 바꾼다. ideation/done/은 입력이 아니다.
- gusta-start 요청 실행이면 요청문이 재료다 — 요청문이 정한 것은 사용자 결정으로 그대로 쓰고, 공백만 맡김 규칙으로 채운다.

## 2. 기획 인터뷰
아래가 모두 결정이 될 때까지 2~4개씩 묻는다(문서·대화에 답이 있으면 묻지 않는다): 문제/목적(성공하면 무엇이 달라지나) · 타겟 · 범위(포함 / **명시적 제외**) · 핵심 플로우(FORMAT 플로우 표기) · 정책(권한, 요금·한도, 데이터 보존·삭제, 실패 시 UX) · 우선순위(나중은 [x] 보류로 기록).
- **expert**: 정책 엣지(동시성·악용·한도 초과 UX)까지 묻고 선택지는 용어로 짧게.
- **mid**: 핵심 갈림길만 선택지+영향 1줄, 엣지는 추천안을 확인.
- **novice**: 기획은 대신 정하지 않고 오히려 더 촘촘히 묻되, 용어 없이 "이런 상황이면 어떻게 되면 좋겠어요?" 식 시나리오에 추천안을 붙인다. "알아서 해줘"라고 넘긴 항목도 과금·데이터 삭제·개인정보는 명시적으로 확인받는다.
- **맡김**: 추천안으로 정한 질문마다 inbox `decided`(`<question> → <choice> (alt: …)`)를 남기고, 과금·데이터 삭제·개인정보·보안은 `[?]`·inbox `parked`.

## 3. 작성
도메인 ID를 기존과 겹치지 않게 정하고 이 스킬의 assets/ssot.md를 `spec/ssot/<ID>.md`로 복사해 채운다. 못 정한 것은 [?].
기존 문서(PRD·구 스펙·README 등)가 재료면 붙여넣지 않고 한 문단씩 "지금 지켜야 하는 규칙인가"로 걸러 결정 라인으로 다시 쓴다. 지금도 유효한지 모르는 항목은 [?]로 등록한다.

**최종 점검** — 확인 요청 전에 한 줄씩 통과시킨다.
- 따로 바뀔 정책은 쪼개고, 조건은 줄을 합치지 말고 결정 블록(2칸 들여쓴 하위 항목·표)으로 편다(신호: ` ← ` 2개 이상, ` · ` 3덩어리 이상, 한 줄 700자 초과).
- 호환성·실패 조건·보안·과금·데이터 보존·수치와 단위·부정 표현(no·never·only)·트레이드오프의 ← 이유는 남기고, 요청·대화 흔적(경위·승인자·날짜·인터뷰 순서·과거 화면·버그 해명·폐기된 방식의 상세·미사여구)은 뺀다. 날짜는 측정 출처 `measured YYMMDD`만.
- 범위 제외는 [o] 부정형 한 줄, [x]는 지금 효력이 없는 결정뿐(경위 없이).
- 다른 정본(코드·SSOT)의 상세는 참조로 대신한다: 그것 없이 적용할 수 없으면 `→!`, 규칙이 거기 있으면 `→=`, 배경이면 `→~`(프로젝트 FORMAT에 이 표기가 없으면 `→`만 쓰고 next에 FORMAT 이관).
- 섹션은 FORMAT 골격(decisions·flow·constraints·chg)뿐, chg는 `- rN YYMMDD 요약` 한 줄씩(✎는 old→new만), `<...>` 자리표시·빈 (opt) 섹션 없음.

초안 확인: novice=풀어서 설명+원문 / mid=원문+핵심 결정 요약 / expert=원문만.

## 4. 마감
STATE: ssot 행 `<ID> | 1 | 0 | all | <[?] 수>`, next에 `gusta-create-task <ID>`. `vibe log` 1줄. ideation에서 시작했으면 [전환 마감 절차](references/ideation.md)를 수행한다.
