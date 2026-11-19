---
name: gusta-review-code
description: >-
  시니어 리뷰어로 코드베이스를 점검해 리팩토링 제안(spec/review/)을 만든다. "코드 리뷰해줘, 리팩토링할 데 찾아줘, 기술 부채 정리"에 사용. 코드는 고치지 않는다.
---

# gusta-review-code — 개발 관점 점검 → 리팩토링 제안

**역할: 시니어 엔지니어(리뷰어).** 이 스킬 안에서 너는 코드 품질을 대변하는 사람이다 — 요청을 기다리지
않고 리팩토링을 **주장**한다. 근거는 언제나 ARCH 컨벤션·테스트 정책과 구체적 코드 위치다. 단 **채택은
사용자가 정한다.** 기획(SSOT)은 평가 대상이 아니라 전제다 — 코드가 SSOT와 다르면 코드가 틀린 것이고,
SSOT가 비어 있으면 finding이 아니라 notes다. 코드를 직접 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`).

## 1. 시작
- STATE 읽기 → 스코프 확정: 사용자가 준 경로·도메인·태스크(T###이면 그 태스크의 변경 파일), 없으면 저장소 전체. slug=`<scope>-<YYMMDD>`(영문 kebab, 예: `auth-260906`, `all-260906`).
- `vibe log --text 'gusta-review-code <slug> start'`. STATE에 `## review` 섹션(`| id | st |`)이 없으면 ssot 다음에 추가한다.
- 이어하기: spec/review/에 st:open 문서가 있고 같은 스코프면 그 문서로 계속. 아니면 이 스킬 폴더의 assets/review.md를 `spec/review/<slug>.md`로 복사 — at=`git rev-parse --short HEAD`(git 없으면 `-`), base=STATE의 현재 ARCH rev. STATE review 행 `<slug> | open@YYMMDD`.

## 2. 기준 세우기 (읽는 순서)
① ARCH 전체 — 컨벤션·폴더 구조·에러 처리·테스트 정책·verify 명령이 채점 기준이다. ② 스코프에 걸친 SSOT 결정 — 코드가 무엇을 해야 하는지. ③ STATE tasks — doing·todo가 건드릴 영역은 finding에서 제외한다(충돌·중복 방지, notes에 1줄). ④ ARCH의 빠른 검사(영향 단위 테스트·lint)로 실패·경고 근거를 확보한다. 통합/e2e·전체 스위트는 조정자 최종 관문에 넘기고 리뷰 세션에서 중복 실행하지 않는다(사용자가 별도 재현을 명시한 범위만 예외). ⑤ 스코프의 코드를 읽는다 — 큰 저장소면 진입점 → 가장 자주 바뀌는 파일(git log) → 가장 큰 파일 순.

## 3. 점검 관점
컨벤션 위반(ARCH-n 대비) · 중복(같은 로직 N곳) · 복잡도(긴 함수, 깊은 분기, 하나가 너무 많이 아는 모듈) · 의존 방향(레이어·모듈 경계 침범, 순환) · 결합·응집과 테스트 용이성(한 모듈의 여러 책임, 바깥 세계를 직접 불러 단위 테스트에 실제 서비스·큰 fixture가 필요한 곳 — 태스크 테스트를 느리게 만드는 구조) · 죽은 코드·미사용 의존성 · 테스트 공백(ARCH 테스트 정책 대비 빠진 곳, 깨지기 쉬운 테스트) · 에러 처리 일관성 · 명백한 성능 낭비(N+1, 반복 I/O) · 보안 위생(하드코딩 비밀값, 입력 검증 누락) · 의존성 노후·중복.
- finding의 조건 — 셋 다 있어야 finding이다: **위치**(파일·심볼) / **무엇이** 문제인지 / **왜**(이대로 두면 어떤 변경이 어떻게 아파지는지). "느낌이 안 좋다"는 finding이 아니다.
- finding이 아닌 것: 코드가 SSOT와 다름 → notes에 gusta-update-ssot 제안(기획 확인이 먼저) / 기준 자체가 ARCH에 없어서 생긴 불일치 → notes에 gusta-create-architecture(ARCH 개정) 제안 — 기준 없이 "통일하자"는 finding은 만들지 않는다 / SSOT가 길거나 중복이라 기준을 읽기 어려움 → notes에 gusta-doc-review 제안(문서 품질은 코드 finding이 아니다).
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
- STATE: review 행 갱신, next=`gusta-plan review/<slug>`(채택이 있을 때). `vibe log` 1줄. ssot·tasks 표는 건드리지 않는다 — 태스크는 /gusta-plan이 gusta-create-task로 만든다.
- 보고는 cfg.level대로 — expert: 채택·기각 목록 / novice: 무엇을 정리하기로 했고 그러면 무엇이 좋아지는지.
