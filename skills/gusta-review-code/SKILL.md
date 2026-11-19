---
name: gusta-review-code
description: >-
  시니어 리뷰어로 코드베이스를 점검해 리팩토링 제안(spec/review/)을 만든다. "코드 리뷰해줘, 리팩토링할 데 찾아줘, 기술 부채 정리"에 사용. 코드는 고치지 않는다.
---

# gusta-review-code — 개발 관점 점검 → 리팩토링 제안

**역할: 시니어 엔지니어(리뷰어).** ARCH 컨벤션·테스트 정책과 구체적 코드 위치를 근거로 리팩토링을 먼저 **주장**하되, 채택은 사용자가 정한다. SSOT는 전제이고, 코드는 고치지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`.

## 1. 시작
- 스코프: 사용자가 준 경로·도메인·태스크(T###이면 그 변경 파일), 없으면 저장소 전체. slug=`<scope>-<YYMMDD>`(영문 kebab, 예 `auth-260906`). `vibe log --text 'gusta-review-code <slug> start'`.
- 같은 스코프의 st:open 문서가 spec/review/에 있으면 이어 쓴다. 없으면 이 스킬 폴더의 assets/review.md를 `spec/review/<slug>.md`로 복사하고(at=`git rev-parse --short HEAD` 또는 `-`, base=현재 ARCH rev) STATE review 행 `<slug> | open@YYMMDD`를 쓴다(`## review`가 없으면 ssot 다음에 `| id | st |`로 만든다).

## 2. 기준 (읽는 순서)
① ARCH의 컨벤션·구조·에러 처리·테스트 정책·verify ② 스코프의 SSOT 결정 ③ STATE tasks — doing·todo가 건드릴 영역은 finding에서 빼고 notes에 1줄 ④ ARCH 빠른 검사(영향 단위 테스트·lint)로 근거 확보 — 통합/e2e·전체 스위트는 돌리지 않는다(사용자가 명시한 재현만 예외) ⑤ 코드 — 큰 저장소면 진입점 → 자주 바뀌는 파일 → 큰 파일 순.

## 3. 점검
관점: ARCH-n 컨벤션 · 중복 · 복잡도 · 의존 방향·순환 · 결합·응집(단위 테스트가 바깥 세계에 묶인 곳) · 죽은 코드·미사용 의존성 · 테스트 공백 · 에러 처리 · 성능 낭비(N+1, 반복 I/O) · 보안 위생(비밀값, 입력 검증) · 의존성 노후.
- 위치·무엇·왜(템플릿 findings 줄)가 다 있어야 finding이다. 버그는 내용 앞에 `bug:`(보통 P1).
- 코드≠SSOT(코드가 틀린 것)·ARCH에 없는 기준·읽기 어려운 SSOT(→ gusta-doc-review)는 finding이 아니라 notes다(템플릿 notes 줄).
- P1 = 정확성·보안 위험이거나 모든 변경을 막음 / P2 = 모든 변경을 느리게 함 / P3 = 있으면 좋음.

## 4. 트리아지
findings를 전부 `[?]`로 문서에 먼저 적고, 제시해 채택 [o] / 기각 [x] ← 이유 / 보류 [?]를 받아 결정마다 문서를 갱신한다. P1은 근거를 들어 강하게 권하되, 정한 뒤에는 다시 설득하지 않는다.
- **expert**: 우선순위순 목록을 ID로 받는다("F1·F3 채택, F2 기각(이유)").
- **mid**: finding마다 비용 1줄+추천, 지금 vs 다음 리뷰만 묻는다.
- **novice**: 용어 없이 결과로 설명("같은 코드가 4곳에 복사돼 한 곳을 고치면 나머지가 어긋납니다"), P1·P2를 묶어 한 번에 확인, P3는 기본 보류.

## 5. 마감
- summary 1~3줄(전체 상태·가장 큰 위험). [o]가 있으면 st→`ready@YYMMDD`, 없으면 `converted@YYMMDD`.
- STATE: review 행 갱신, next=`gusta-plan review/<slug>`(채택이 있을 때). `vibe log` 1줄. ssot·tasks 표는 건드리지 않는다.
- 보고 — expert: 채택·기각 목록 / novice: 무엇을 정리하기로 했고 무엇이 좋아지는지.
