---
name: gusta-update-ssot
description: >-
  기존 SSOT의 기획 변경을 반영하는 내부 기획 스킬(rev·chg·STATE pending). 태스크화는 gusta-create-task, 사용자의 기획 요청은 gusta-plan으로.
---

# gusta-update-ssot — 기획 변경 → SSOT rev+1

**역할: 기획자.** gusta-create-ssot와 같은 규칙(기술 결정 금지)으로 SSOT를 개정하고 변경의 **파급을 드러낸다**.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`.

## 1. 시작
대상 SSOT 식별 → `vibe brief <ID>`로 현재 결정 블록 → `vibe log --text 'gusta-update-ssot <ID> start'`. 출발점:
- gusta-plan의 해석표·gusta-sketch의 고른 시안 — 인터뷰는 거기서 못 정한 공백만 묻는다.
- ideation 문서 — 원본 활성 문서의 domains·vision·shape·explored로 반영 범위를 확인하고, open 문서는 문서·STATE st를 ready로 바꾼다. ideation/done/은 입력이 아니다.
- gusta-start 요청 실행이면 요청문이 출발점이다 — 요청문이 정한 것은 사용자 결정으로 그대로 쓰고, 공백만 맡김 규칙으로 채운다.
- gusta-doc-review가 넘긴 보류 항목(모순·공백·애매한 문장)이면 그 원문 — 어느 쪽이 맞는지 정하고(맡김은 inbox `decided`에 선택·대안·이유), 단순 편집으로 모순을 감추지 않는다.

## 2. 변경 분석
- 요구를 결정 단위로 옮긴다: 어떤 `<ID>-n`이 + / ✎ / - 인가.
- 파급: `vibe brief <ID>-n`의 referrers로 영향받는 결정·flow·constraints·활성 태스크를 찾는다. `→!`·`→=`로 가리키는 결정은 함께 영향받는다. doing 태스크(작업 묶음이면 STATE todo라도 `work board`의 활성 attempt)는 커밋 후 보고해 워커가 동기화·재검증하거나 재분해·재배정되게 한다.
- 남은 기획 질문은 gusta-create-ssot 2단계 기준으로 level별 인터뷰한다(맡김에서 과금·데이터 삭제·개인정보·보안은 `[?]`·`parked`).
- 사실상 새 도메인 규모면 gusta-create-ssot를 제안한다.

## 3. 적용
- ✎는 결정 라인 교체, +는 새 번호, 철회는 지우지 않고 [x]로.
- rev+1, chg 1줄(-는 없어진 것을 남긴다). 인용줄·플로우·제약도 동기화.

**최종 점검** — 확인 요청 전에 한 줄씩 통과시킨다.
- 따로 바뀔 정책은 쪼개고, 조건은 줄을 합치지 말고 결정 블록(2칸 들여쓴 하위 항목·표)으로 편다(신호: ` ← ` 2개 이상, ` · ` 3덩어리 이상, 한 줄 700자 초과).
- 호환성·실패 조건·보안·과금·데이터 보존·수치와 단위·부정 표현(no·never·only)·트레이드오프의 ← 이유는 남기고, 요청·대화 흔적(경위·승인자·날짜·인터뷰 순서·과거 화면·버그 해명·폐기된 방식의 상세·미사여구)은 뺀다. 날짜는 측정 출처 `measured YYMMDD`만.
- 범위 제외는 [o] 부정형 한 줄, [x]는 지금 효력이 없는 결정뿐(경위 없이).
- 다른 정본(코드·SSOT)의 상세는 참조로 대신한다: 그것 없이 적용할 수 없으면 `→!`, 규칙이 거기 있으면 `→=`, 배경이면 `→~`(프로젝트 FORMAT에 이 표기가 없으면 `→`만 쓰고 next에 FORMAT 이관).
- 섹션은 FORMAT 골격(decisions·flow·constraints·chg)뿐, chg는 `- rN YYMMDD 요약` 한 줄씩(✎는 old→new만), `<...>` 자리표시·빈 (opt) 섹션 없음.

## 4. 마감
- STATE: ssot rev 갱신 + pending에 델타(`AUTH-2✎ AUTH-5+`, tasked=0이면 `all` 유지) + [?] 수, next에 `gusta-create-task <ID>`. `vibe log` 1줄(영향권에 doing 태스크가 있으면 경고 1줄 더).
- 코드가 먼저 바뀐 변경(gusta-design-mode·gusta-showcase 마감)을 문서에 맞추는 개정이면 태스크를 만들지 않는다: pending 없이 tasked=rev로 두고 `vibe log`에 구현 커밋 SHA를 남긴다.
- ideation에서 시작했으면 [전환 마감 절차](../gusta-create-ssot/references/ideation.md)를 수행한다.
- 보고(level별): 바뀐 결정, 파급 범위, 다음 단계.
