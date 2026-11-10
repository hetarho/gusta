---
name: update-ssot
description: >-
  기존 SSOT의 기획 변경을 기획자 역할로 반영한다(rev+1, chg 기록, STATE pending 갱신). "기획 바꾸자 /
  ~는 빼자·추가하자 / 정책 변경 / SSOT 수정" 요청일 때, 그리고 구현 중 SSOT의 모순·공백이 발견됐을 때
  사용. 태스크 파일은 건드리지 않는다 — 변경분을 태스크로 만드는 것은 create-task.
---

# update-ssot — 기획 변경 → SSOT rev+1

**역할: 기획자.** create-ssot와 같은 규칙(기술 결정 금지). 이 스킬의 핵심은 변경의 **파급을 드러내는 것**이다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

작업 묶음 워커에서 불렸으면 문서 쓰기는 `manage-work`가 반환한 group.path(기획·채번·문서 정리 위치)로 인계하고 워커 checkout의 STATE·SSOT는 바꾸지 않는다. 어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 FORMAT SETTINGS `plan`).

작업 묶음의 기획 공간에서는 공유 보드의 실행 상태와 참조 도메인으로 영향받는 워커를 확인한다. STATE의 todo 표기만으로 미착수라고 판단하지 않는다. 정책 변경을 커밋한 뒤 affected task/attempt를 보고하고, 해당 워커가 동기화·재검증하거나 재분해 후 다시 배정되게 한다.

## 1. 시작
STATE → 대상 SSOT 식별·정독 → log에 `- YYMMDD update-ssot <ID> start`.
ideation에서 넘겨받은 변경이면 원본 활성 문서의 domains·vision·shape·explored를 읽고 반영 범위를 확인한다. open 문서를 기획으로 가져왔다면 문서·STATE st를 ready로 바꾼다. ideation/done/은 기본 입력이 아니다.
입력이 doc-review가 넘긴 보류 항목(모순·공백·애매한 문장)이면 그 원문이 출발점이다. 함께 모드는 어느 쪽이 맞는지 확인받고, 맡김은 추천안으로 결정해 inbox decided에 선택·대안·이유를 남긴다. 단순 편집으로 모순을 감추지 않는다.

## 2. 변경 분석
- 요구를 결정 단위로 번역한다: 어떤 `<ID>-n`이 + / ✎ / - 인가.
- 파급 확인: `vibe brief <ID>-n`의 referrers — 그 결정을 가리키는 결정·flow·constraints(`/` 목록·범위·맨 ID 포함)와 인용한 활성 태스크 — 로 영향받는 곳과 태스크(특히 doing)를 확인한다. 바꾸는 결정을 `→!`·`→=`로 가리키는 결정은 함께 영향받는다.
- 기획 질문이 남으면 create-ssot 2단계와 같은 기준으로 level별 인터뷰(맡김 모드 규칙 포함 — 추천안으로 개정하고 inbox `decided`, 과금·데이터 삭제·개인정보·보안은 `[?]`·`parked`).
- 변경이 사실상 새 도메인 규모면 create-ssot를 제안한다.

## 3. 적용
- 수정(✎)은 결정 라인 교체, 추가(+)는 새 번호, 철회는 지우지 말고 [x]로 상태만 변경.
- rev+1, chg 1줄(FORMAT rev 표기: ✎는 이전 값을 `old→new`로, -는 없어진 것을 남긴다). 인용줄·플로우·제약도 동기화.

**최종 점검** — 확인 요청 전에 한 줄씩 통과시킨다. SSOT에는 지금 지켜야 하는 규칙만 남는다. 요청·대화의 흔적은 태스크 파일(1회용)에는 있어도 되지만 SSOT에는 절대 남기지 않는다.
- 한 결정이 독립적으로 이해·검증되는 정책 단위인가 — 따로 바뀔 수 있는 정책이 섞였으면 쪼갠다. 신호: ` ← ` 두 개 이상, ` · ` 세 덩어리 이상, 한 줄 700자 초과.
- 조건이 많으면 줄을 합치지 말고 결정 블록(2칸 들여쓴 하위 항목·표)으로 편다 — 줄바꿈을 없애는 것은 간결화가 아니다.
- 남겨야 할 것이 다 남았는가 — 호환성, 실패 조건, 보안·과금·데이터 보존, 수치와 단위, 부정 표현(no·never·only), 트레이드오프의 ← 이유.
- 빼야 할 것이 없는가 — 요청 경위("user asked / as discussed"), 승인자·날짜, 인터뷰 순서, 과거 화면·과거 버그 해명, 폐기된 방식의 상세, 미사여구. 날짜는 측정 출처(`measured YYMMDD`)일 때만 남는다.
- 범위를 정하는 제외는 [o] 부정형 한 줄이고, [x]는 더 이상 유효하지 않은 결정뿐인가 — [x]는 왜 논의됐는지 설명하지 않는다.
- 코드나 다른 SSOT가 정본인 상세를 옮겨 적지 않았는가 — 참조(→<ID>-n, 경로)로 대체. 새로 쓰는 참조에는 종류를 붙인다: 그것 없이 이 규칙을 적용할 수 없으면 `→!`, 규칙 자체가 거기 있으면 `→=`, 배경이면 `→~`. 프로젝트 FORMAT에 이 표기가 없으면(옛 FORMAT) `→`만 쓰고 next에 FORMAT 이관을 남긴다.
- 섹션이 FORMAT 골격(decisions·flow·constraints·chg)뿐인가 — discussion·notes·context·background 같은 섹션은 금지. 내용이 결정이면 decisions로 흡수, 아니면 삭제.
- chg는 `- rN YYMMDD 요약` 한 줄씩인가 — 변경 경위 서술 금지, ✎는 old→new만.
- `<...>` 자리표시·빈 (opt) 섹션이 없는가.

## 4. 마감
- STATE: ssot rev 갱신 + pending에 델타 추가(`AUTH-2✎ AUTH-5+` — 단 tasked=0이면 `all` 유지) + [?] 수 갱신, 영향권에 doing 태스크가 있으면 log에 경고 1줄, next에 `create-task <ID>` / log 1줄.
- ideation에서 시작했다면 [전환 마감 절차](../create-ssot/references/ideation.md)를 수행한다.
- 보고(level별): 바뀐 결정, 파급 범위, 다음 단계.
