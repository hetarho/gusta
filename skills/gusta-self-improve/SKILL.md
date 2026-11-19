---
name: gusta-self-improve
description: >-
  로컬 지속 개선. 하위 세션의 개선 제안 중 승인한 것만 전용 브랜치에서 구현·리뷰해 공동 통합에 제출한다. "gusta-self-improve, PR 없이 개선, 로컬에서 알아서 개선"에 사용.
---

# gusta-self-improve — 제안 승인과 로컬 통합

**역할: 실행한 세션이 오케스트레이터.** 탐색 세션의 근거 있는 제안을 범위·비용·위험으로 승인하고, 구현·독립 리뷰를 배정해 전용 세션 브랜치에 모아 공동 통합에 제출한다. PR은 만들지 않는다. 워커의 코드를 대신 쓰거나 자기 구현을 승인하지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

## 1. 호출과 실행 준비
SETTINGS `usage-measurement`가 true인 시작 대화는 [사용량 절차](../gusta-start/references/usage.md)로 작업 전 기준선을 시작한다. 최상위 대화는 마감(할 일 없음·실패·주차 포함)에 Markdown 파일을 저장하고 최종 **채팅**에 summary·reportFile 링크를 전달한다(JSON artifact만으로 끝내지 않음, false면 실행하지 않음).

호출은 이번 범위의 동작 보존 개선을 채택해 로컬에 통합하라는 위임이다 — 후보마다 사람에게 묻지 않는다. 지속 정책이 있으면 범위·예산을 이어받고, 없으면 이번 범위·예산·권한을 review notes와 보고서에 기록한다. 호출만으로 상시 스케줄·큰 변화·원격 발행 권한이 생기지 않는다. 예산(시간)이 다 되면 새 채택을 멈추고 완료·남은 일·남은 일의 ETA를 한 메시지로 먼저 보고한다 — 기본은 이미 제출된 레인만 마치고, 그 이상은 사용자가 정한다.

- `vibe session open --kind self-improve --tag <tag> --json`으로 전용 worktree·세션 브랜치를 확보하고 반환 targetRoot에서만 기획·구현·보고한다. 호출한 checkout의 사용자 변경은 복사·stash·커밋하지 않는다.
- 하위 세션은 기본 탐색 2·구현 2·독립 리뷰 1(슬롯·부하에 맞춤). 네이티브 하위 세션 도구가 없거나 맡김이면 탐색은 `work scout`, 구현·리뷰는 `work run`으로 한다. 둘 다 없으면 제안 패킷까지 만들고 부족한 연결을 보고한다. 같은 대화에서 역할만 바꿔 하위 세션·독립 검토를 가장하지 않는다.
- 예산 기본: 실행 60분·하루 누적 120분·단일 명령 15분·문제 하나. 긴 명령·재시도·리뷰 비용까지 예약한다. 직접 호출은 일일 주기를 기다리지 않고 지금 한 사이클을 시작한다.
- [배정과 통합 절차](references/workflow.md)를 읽는다. hostManaged 단위·묶음 워커·리뷰어로 배정된 세션은 오케스트레이터를 새로 만들지 않고 그 배정만 마친다.

## 2. 하위 탐색 세션이 제안
실행 기록·느린 검사·재작업·변경 이력의 비용 상위 영역을 겹치지 않게 나눠 [탐색 프롬프트](assets/scout-prompt.md)로 배정한다. 오케스트레이터는 코드·로그를 직접 훑지 않고, 승인 전에 코딩·장기 측정·설정 변경을 시작하지 않는다.

결과는 오케스트레이터만 `spec/review/<slug>.md`의 finding·notes로 정리하고, 기존 태스크·PR·기각/실패 기록과 겹치거나 진행 중인 영역은 뺀다. 제안이 가리킨 원시 근거(줄·로그)를 직접 확인한 뒤에만 채택한다.

## 3. 오케스트레이터가 실행 승인
제안은 [?]로 시작하고, 오케스트레이터가 채택 [o]·기각 [x]·보류 [?]를 기록한다. 승인에는 제안 artifact·기준 HEAD·허용 touches·동작 보존 조건·측정 목표·검증 명령·시간 상한을 연결하고, inbox decided와 보고서에 위임/정책 근거와 이유를 남긴다.
- **채택**: 관측된 문제이고 기존 계약을 보존하며 비용·영향·되돌림이 제한된다. 겹치는 제안은 병합·직렬화한다. 근거가 부족하면 제한된 계측/탐색만 승인할 수 있다.
- **기각/보류**: 효과 불명확·중복·소유 충돌·예산 부족. 이유를 남기고 구현을 배정하지 않는다.
- **사람 판단**: 결과 의미·정밀도·공개 계약·저장 형식·필수 검증 범위 변경, 광범위/영향 불명, 되돌리기 어려운 일. 설계·근거·대안·권장 판단을 갖춰 parked로 보고하고 다른 허용 작업을 계속한다 — 스스로 승인하지 않는다.

채택한 finding만 gusta-create-task로 태스크화한다.

## 4. 구현·독립 리뷰
승인된 태스크만 [구현 배정 프롬프트](assets/worker-prompt.md)를 채워 gusta-implement-task로 보낸다. 측정은 [측정 절차](../gusta-self-improve-remote/references/measurement.md), 반복 실험은 [실험 루프와 도구](../gusta-self-improve-remote/references/experiments.md)를 쓰되 통합·완료 조건은 이 스킬을 따른다.

제출 커밋은 작성자와 다른 세션이 gusta-review-task로 검토한다(묶음은 `--review all`). P1/P2가 있으면 수정 후 재제출·재리뷰한다. 검토자가 없으면 제출 코드를 세션 브랜치에 통합하지 않는다.

## 5. 세션 결과 제출과 공동 마감
리뷰를 통과한 제출물은 세션 브랜치에 모아 ready로 제출하고, 검수·agent AC·반영은 [공유 검증 계약](../gusta-start/references/verification.md)과 SETTINGS land·land-via·push를 따른다. land 반영 뒤 `vibe prune`으로 정리한다. land가 current·미정이거나 원격 조정을 확인할 수 없으면 세션 결과·로컬 범위·미발행 상태를 보고한다.

[보고서 골격](../gusta-start/assets/report.md)에 done=승인 제안·태스크·통합 커밋, decided=선택/기각 이유, parked=사람 판단·권한·미통합, checks=실측/검증/agent acceptance/미실행/예산, next=다음 관찰·재개 지점을 남긴다. expert는 범위·수치·SHA·판정, mid는 개선 효과·비용·한계, novice는 달라질 작업 경험과 사람 판단부터. 스케줄러가 연결되지 않았으면 자동 재실행을 약속하지 않는다.
