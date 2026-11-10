---
name: review-code
description: >-
  시니어 엔지니어(리뷰어) 역할로 코드베이스를 ARCH 컨벤션과 개발 관점에서 점검해 리팩토링 제안 문서
  (spec/review/)를 만든다. "코드 리뷰해줘 / 리팩토링할 데 찾아줘 / 기술 부채 정리하자 /
  코드 품질 점검 / 구조 개선할 곳 있어?" 일 때, 그리고 태스크를 몇 개 구현한 뒤 정리 시점에 사용.
  finding은 위치·문제·영향을 갖춰 우선순위(P1~P3)로 제안하고 채택은 사용자가 정한다. 코드는 고치지
  않는다 — 채택된 finding은 create-task가 태스크로 쪼개고 implement-task가 구현한다.
---

# review-code — 개발 관점 점검 → 리팩토링 제안

**역할: 시니어 엔지니어(리뷰어).** 이 스킬 안에서 너는 코드 품질을 대변하는 사람이다 — 요청을 기다리지
않고 리팩토링을 **주장**한다. 근거는 언제나 ARCH 컨벤션·테스트 정책과 구체적 코드 위치다. 단 **채택은
사용자가 정한다.** 기획(SSOT)은 평가 대상이 아니라 전제다 — 코드가 SSOT와 다르면 코드가 틀린 것이고,
SSOT가 비어 있으면 finding이 아니라 notes다. 코드를 직접 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

작업 묶음 워커에서 불렸으면 문서 쓰기는 `manage-work`가 반환한 group.path(기획·채번·문서 정리 위치)로 인계하고 워커 checkout의 STATE·SSOT는 바꾸지 않는다. 어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 FORMAT SETTINGS `plan`).

## 1. 시작
- STATE 읽기 → 스코프 확정: 사용자가 준 경로·도메인·태스크(T###이면 그 태스크의 변경 파일), 없으면 저장소 전체. slug=`<scope>-<YYMMDD>`(영문 kebab, 예: `auth-260906`, `all-260906`).
- log `- YYMMDD review-code <slug> start`. STATE에 `## review` 섹션(`| id | st |`)이 없으면 ssot 다음에 추가한다.
- 이어하기: spec/review/에 st:open 문서가 있고 같은 스코프면 그 문서로 계속. 아니면 이 스킬 폴더의 assets/review.md를 `spec/review/<slug>.md`로 복사 — at=`git rev-parse --short HEAD`(git 없으면 `-`), base=STATE의 현재 ARCH rev. STATE review 행 `<slug> | open@YYMMDD`.

## 2. 기준 세우기 (읽는 순서)
① ARCH 전체 — 컨벤션·폴더 구조·에러 처리·테스트 정책·verify 명령이 채점 기준이다. ② 스코프에 걸친 SSOT 결정 — 코드가 무엇을 해야 하는지. ③ STATE tasks — doing·todo가 건드릴 영역은 finding에서 제외한다(충돌·중복 방지, notes에 1줄). ④ ARCH의 빠른 검사(영향 단위 테스트·lint)로 실패·경고 근거를 확보한다. 통합/e2e·전체 스위트는 조정자 최종 관문에 넘기고 리뷰 세션에서 중복 실행하지 않는다(사용자가 별도 재현을 명시한 범위만 예외). ⑤ 스코프의 코드를 읽는다 — 큰 저장소면 진입점 → 가장 자주 바뀌는 파일(git log) → 가장 큰 파일 순.

## 3. 점검 관점
컨벤션 위반(ARCH-n 대비) · 중복(같은 로직 N곳) · 복잡도(긴 함수, 깊은 분기, 하나가 너무 많이 아는 모듈) · 의존 방향(레이어·모듈 경계 침범, 순환) · 결합·응집과 테스트 용이성(한 모듈의 여러 책임, 바깥 세계를 직접 불러 단위 테스트에 실제 서비스·큰 fixture가 필요한 곳 — 태스크 테스트를 느리게 만드는 구조) · 죽은 코드·미사용 의존성 · 테스트 공백(ARCH 테스트 정책 대비 빠진 곳, 깨지기 쉬운 테스트) · 에러 처리 일관성 · 명백한 성능 낭비(N+1, 반복 I/O) · 보안 위생(하드코딩 비밀값, 입력 검증 누락) · 의존성 노후·중복.
- finding의 조건 — 셋 다 있어야 finding이다: **위치**(파일·심볼) / **무엇이** 문제인지 / **왜**(이대로 두면 어떤 변경이 어떻게 아파지는지). "느낌이 안 좋다"는 finding이 아니다.
- finding이 아닌 것: 코드가 SSOT와 다름 → notes에 update-ssot 제안(기획 확인이 먼저) / 기준 자체가 ARCH에 없어서 생긴 불일치 → notes에 create-architecture(ARCH 개정) 제안 — 기준 없이 "통일하자"는 finding은 만들지 않는다 / SSOT가 길거나 중복이라 기준을 읽기 어려움 → notes에 doc-review 제안(문서 품질은 코드 finding이 아니다).
- 버그(기능이 틀림)는 finding으로 올리되 내용 앞에 `bug:`를 붙여 구분한다. 보통 P1이다.
- 우선순위: P1 = 정확성·보안 위험이거나 모든 변경을 막음 / P2 = 모든 변경을 느리게 함 / P3 = 있으면 좋음.

## 4. 제안과 트리아지
findings는 전부 `[?]`로 문서에 먼저 적는다(문서 먼저). 그 다음 사용자에게 제시하고 채택 [o] / 기각 [x] ← 이유 / 보류 [?]를 받는다. P1은 근거를 들어 강하게 권한다 — 하지만 사용자가 정한 뒤에는 다시 설득하지 않고 [x]와 이유를 남긴다(같은 제안을 다음 리뷰에서 반복하지 않기 위해).
- **expert**: 우선순위순 목록 그대로. "F1·F3 채택, F2 기각(이유)" 식으로 ID로 받는다.
- **mid**: finding마다 안 하면 생기는 비용 1줄 + 추천. 갈림길(지금 vs 다음 리뷰)만 묻는다.
- **novice**: 기술 용어 없이 결과로 설명("같은 코드가 4곳에 복사돼 있어서 한 곳을 고치면 나머지가 어긋납니다"). P1·P2를 채택 묶음으로 추천하고 한 번에 확인받는다("이 5개 정리하고 갈까요?"). P3는 기본 보류.
결정마다 문서를 즉시 갱신한다. 문서에 없는 합의는 없던 것이 된다.

## 5. 마감
- summary 1~3줄(전체 상태·가장 큰 위험) 확정. [o]가 하나라도 있으면 st→`ready@YYMMDD`, 하나도 없으면 바로 `converted@YYMMDD`.
- STATE: review 행 갱신, next=`create-task review/<slug>`(채택이 있을 때), log 1줄. ssot·tasks 표는 건드리지 않는다 — 태스크는 create-task가 만든다.
- 보고는 cfg.level대로 — expert: 채택·기각 목록 / novice: 무엇을 정리하기로 했고 그러면 무엇이 좋아지는지.
