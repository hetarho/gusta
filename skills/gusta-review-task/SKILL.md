---
name: gusta-review-task
description: >-
  작업 묶음에 제출된 태스크 커밋을 독립 검토해 승인·수정 요청을 기록한다. "제출 작업 리뷰, 리뷰 대기열 처리"에 사용.
---

# gusta-review-task — 제출 태스크 리뷰

**역할: 제출물 리뷰어.** acceptance·현재 SSOT·ARCH 기준으로 제출된 변경을 읽기 전용으로 검토한다. 파일·Git·기획 결정을 바꾸지 않고, 스스로 구현한 제출물은 승인하지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

실행기나 `work next`(`action:review`)가 준 배정을 쓴다. 배정 없이 불렸으면 [수동 리뷰](references/manual.md)로 선점부터 한다.

## 1. 검토
- `risk.reasons`가 있으면 그 이유부터 본다.
- 리뷰 단위는 배정의 `tasks` 전체다. 태스크 전체(acceptance·result)와 관련 SSOT·ARCH 검증 기준은 `vibe brief <tasks…> --ref <baseCommit>`로 읽고, 변경은 `git diff <baseCommit>...<commit>`(태스크별은 attempt steps 커밋 사이)로 본다. 브랜치 이름의 가변 HEAD로 대상을 바꾸지 않는다.
- 태스크마다 acceptance 충족, 잘못된 동작·빠진 경계 조건, 회귀, 현재 상위 코드와의 상호작용, 테스트 근거를 본다(lane이면 뒤 태스크가 앞 계약을 깨는지도). 기존 helper·타입의 재정의, 설정 대신 쓴 숫자, 읽히지 않는 설정·export, 바깥 세계에 묶여 단위 테스트로 검증되지 않는 새 로직, 놓친 영향 범위도 finding이다.
- 테스트 성공만으로 승인하지 않는다. 재현은 격리된 빠른 검사만 한다 — 전체 검수·브라우저 E2E는 띄우지 않는다(사용자가 명시한 재현만 예외).
- agent AC는 실제 관찰·증거·정확한 후보·대체한 E2E 범위를 확인한다. 도구 없는 단위의 integration-stage not-run은 정직한 인계다(반복 실행을 요구하지 않고 pass로 보지도 않는다).
- 기존 증거로 검증되는 동작에 새 테스트를 요구하지 않고, 소스 문자열·구현 추종 테스트나 무관한 전체 검사 반복을 해결책으로 요구하지 않는다.

## 2. 결과
P1=정확성·보안 또는 주요 기능을 막는 결함, P2=수정이 필요한 계약 위반·회귀·검증 공백(P1/P2는 changes_requested), P3=선택 개선(그것만으로 무관한 리팩터링을 강제하지 않는다). 기획 판단이 필요하면 정하지 말고 공백과 인계 대상을 finding에 적는다. finding의 where나 message에 태스크 ID를, 수정 요청에는 재현 조건·문제·필요한 수정 또는 검증을 적는다(승인이면 findings는 빈 배열 가능).

```json
{"verdict":"changes_requested","summary":"Retry drops the idempotency key.","findings":[{"priority":"P1","where":"src/payment.ts:42","message":"On timeout, retry omits the original key and can charge twice. Preserve the key and add a timeout regression test."}]}
```

실행기가 결과 제출을 맡으면 JSON만 반환한다. 보고는 novice에게 가능해진 동작과 수정 이유, expert에게 finding·커밋·승인 여부를 간결하게.
