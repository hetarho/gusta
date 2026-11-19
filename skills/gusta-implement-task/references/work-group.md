# 작업 묶음의 배정과 세션 루프

`work ...`는 `npx @haeram/gusta work ...`(실행기 안에서는 cliCommand)의 축약이다.

## 1. 배정 확인
`work status --json`으로 배정을 본다. 명령이 실패하면 단독 흐름으로 진행하되 공유 선점을 흉내 내지 않는다.
- `mode:worker`: currentAttempt의 workspace에서 `taskId`를 구현한다. `tasks`가 둘 이상이면 lane이다 — 앞 태스크의 커밋 위에서 이어 간다. blocked는 원인을 풀고 `work update --attempt <id> --status doing` 뒤 재개, changes_requested는 `work resume`로 수정 배정을 받는다. ready·reviewing·approved는 대기다. verifying·integrating·cleaning 중인 공간에는 쓰지 않는다. integrated·released·failed면 gusta-manage-work로 정리·재배정한다. 브랜치명으로 이어받을 태스크를 추정하지 않는다. 배정이 없거나 끝났으면 2절 세션 루프로 다음 일을 받는다.
- `mode:reviewer`: 구현하지 않고 gusta-review-task로 넘긴다.
- `mode:group`: gusta-manage-work의 board→claim으로 배정한다. `mode:single`의 작은 요청은 SKILL.md 단독 흐름, 병렬 요청은 gusta-manage-work로 묶음을 만든다.
- 워커는 자신의 acceptance 체크·result·코드만 바꾸고, doing/blocked/heartbeat는 `work update --attempt <id>`로 기록한다.

## 2. 세션 루프
남은 태스크를 맡기는 요청에 활성 묶음이나 todo `lane:`이 있으면 이 루프로 진행한다(ARCH가 단독 checkout을 강제하면 단독 흐름).
- owner는 세션마다 한 번 `<도구>-<영숫자 4자>`(예 `claude-k3f9`)로 정해 끝까지 쓴다.
- `work next --owner <owner> --wait 540 --json`을 반복한다(셸 도구 timeout은 대기보다 길게). 활성 묶음이 없으면 `--start`와 ARCH 검증 단계 명령(`--task-verify` 태스크, `--verify` 단위 통합, `--group-verify` 묶음 완료)을 붙인다.
- 응답의 `action`대로 `instruction`을 따른다. `implement`는 SKILL.md 2~5절을 위 워커 규칙으로 따르고, 통합 실패 correction이면 묶음 브랜치를 merge해 푼다. inbox는 워커 공간이 아니라 세션을 시작한 checkout에서 쓴다.
- `work integrate`·`work finish`를 직접 실행하지 않고, 다른 세션의 작업 공간에 쓰지 않는다.
