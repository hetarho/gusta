---
name: review-task
description: >-
  작업 묶음에 제출된 태스크 커밋을 독립적으로 검토하고 승인 또는 수정 요청을 기록한다.
  "제출 작업 리뷰 / 리뷰 대기열 처리 / 워커 결과 검토"에 사용한다.
  저장소 전반의 개선 제안과 사용자 채택은 review-code로 진행한다.
---

# review-task — 제출 태스크 리뷰

**역할: 제출물 리뷰어.** acceptance·현재 SSOT·ARCH 기준으로 제출된 변경을 검토한다. 코드를 수정하거나 기획 결정을 만들지 않는다. 스스로 구현한 작업을 같은 작업자 역할로 승인하지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

아래 `work ...`는 `npx haeram-spec-creator work ...`의 축약이다. 실행기나 세션 루프(`work next`의 `action:review`)가 review ID·commit·baseCommit·workspace를 제공했다면 그 배정을 사용하고 중복 선점하지 않는다. 세션 루프에서는 리뷰를 마친 뒤 루프로 돌아간다.

## 1. 리뷰 선점
- 수동 세션은 `work review-claim --work <group> --owner <reviewer> --json`. 특정 제출물은 `--attempt <id>`. 계속 리뷰하는 세션은 `--wait 540`을 붙여 모델 호출 없이 제출을 기다린다(셸 도구 timeout을 더 길게). `complete`면 종료, `stalled`·`timeout`이면 reason을 전달한다. 반복적인 모델 호출로 빈 큐를 확인하지 않는다.
- 반환된 workspace는 제출 커밋에 고정된 별도 checkout이다. `work status`의 currentReview와 전달된 review ID를 확인한다. 작성자 worktree나 기획 공간에서 파일을 수정하지 않는다.
- 긴 리뷰에서는 `work review-update --review <id>`로 heartbeat를 기록한다. 중단 시 작업자가 종료된 뒤 `work review-release --review <id>`로 선점을 해제한다.

## 2. 변경 검토
- risky 정책 묶음은 위험한 단위만 리뷰로 온다. attempt의 `risk.reasons`(변경량, touches 밖 변경, 계약 경로, 테스트 없음, 재작업, 맡김의 잠정 결정)를 먼저 확인하고 그 이유부터 검토한다.
- 리뷰 단위는 배정의 `tasks` 전체다. lane이면 여러 태스크가 한 제출물이다 — 각 태스크 전체(acceptance·result 포함), 관련 SSOT 결정(`vibe brief <tasks…> --ref <baseCommit>`이 상위 기준의 결정 블록을 한 번에 준다), ARCH 검증 기준을 읽는다. 태스크별 변경은 attempt의 steps 커밋 사이 diff로 나눠 볼 수 있다. 상위 기준은 `git show <baseCommit>:spec/...`로 확인한다. 제출물의 전체 변화는 `git diff <baseCommit>...<commit>`로 조사하고, 두 기준의 차이와 현재 상위 코드와의 상호작용도 검토한다. 브랜치 이름이 가리키는 가변 HEAD로 리뷰 대상을 바꾸지 않는다.
- 태스크마다 acceptance 충족, 잘못된 동작·누락된 경계 조건, 회귀 가능성, 테스트 근거를 확인하고, lane이면 뒤 태스크가 앞 태스크의 계약을 깨지 않는지도 본다. 이미 있는 helper·타입의 재정의, 설정이 있는데 숫자로 쓴 값, 읽히지 않는 설정·export, 바깥 세계와 묶여 단위 테스트로 검증되지 않는 새 로직도 finding이다. 워커는 변경 영향 테스트만 돌리므로 영향 범위 판단이 빠진 곳을 finding으로 남긴다. finding의 where나 message에 해당 태스크 ID를 적는다. 실행기가 전달한 검증 기록도 확인한다. 테스트 성공만으로 승인하지 않는다. 추가 재현은 격리된 환경의 빠른 검사만 사용하고 리뷰 checkout을 변경하지 않는다. 통합/e2e·전체 스위트는 조정자 소유 최종 관문으로 넘기고 리뷰 세션에서 브라우저를 띄우지 않는다(사용자가 별도로 명시한 재현만 예외).
- P1=정확성·보안 또는 주요 기능을 막는 결함, P2=수정이 필요한 계약 위반·회귀·검증 공백, P3=선택 개선. P1/P2는 changes_requested다. 선택 개선만으로 관련 없는 리팩터링을 강제하지 않는다. 기획 판단이 없으면 결정하지 말고 해당 공백과 인계 대상을 finding에 적는다.

## 3. 결과
JSON 형식은 다음과 같다. findings는 승인 시 빈 배열일 수 있고, 수정 요청 시 재현 조건·문제·필요한 수정 또는 검증을 구체적으로 적는다.

```json
{"verdict":"changes_requested","summary":"Retry drops the idempotency key.","findings":[{"priority":"P1","where":"src/payment.ts:42","message":"On timeout, retry omits the original key and can charge twice. Preserve the key and add a timeout regression test."}]}
```

- 수동 실행은 저장소 밖 파일에 JSON을 저장하고 `work review-finish --review <id> --result-file <path> --json`. runner가 결과 제출을 담당한다면 JSON만 반환하고 review-finish를 호출하지 않는다.
- CLI는 리뷰 ID·제출 ID·커밋·상위 기준을 다시 검사한다. 리뷰 중 다른 단위가 통합돼도 바뀐 파일이 제출물과 겹치지 않으면 결과가 유지된다. 겹치는 변경으로 결과가 거부되면 새 배정으로 재리뷰한다. 오래된 결과를 새 ID에 복사하지 않는다.
- approved 이후 통합 검증과 done 처리는 manage-work/runner가 담당한다. STATE next·태스크 파일·done 아카이브를 직접 갱신하지 않는다. novice에게는 가능해진 동작과 수정 이유, expert에게는 finding·커밋·승인 여부를 간결하게 보고한다.
