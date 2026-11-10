# 작업 묶음의 배정과 세션 루프

## 1. 환경과 선택
- `npx haeram-spec-creator work status --json`으로 현재 배정을 확인한다. CLI가 없거나 `work`를 지원하지 않으면 기존 단독 흐름은 가능하지만 공유 선점을 흉내 내지 않는다.
- `mode:worker`이면 반환된 currentAttempt의 태스크와 workspace를 사용한다. `tasks`가 둘 이상이면 lane 배정이다 — `taskId`가 지금 구현할 태스크이고, 앞 태스크의 커밋 위에서 이어 간다. doing은 배정대로 구현하고 blocked는 원인 해소와 `work update --status doing` 이후 재개한다. changes_requested는 `work resume`로 수정 배정을 받는다. ready·reviewing·approved는 리뷰·통합 대기다. verifying/integrating/cleaning 중인 공간에 쓰지 않는다. integrated/released/failed라면 종료 기록을 보고 manage-work로 정리·재배정한다. 브랜치명으로 이어받을 태스크를 추정하지 않는다.
- `mode:reviewer`이면 구현하지 않고 review-task/manage-work로 인계한다.
- 배정이 없거나 끝난 워커 세션은 바로 종료하지 않고 아래 **세션 루프**로 다음 일을 받는다.
- `mode:group`이면 `manage-work`의 board→claim으로 작업자를 배정한다. `mode:single`이며 작은 단독 요청이면 SKILL.md 1절 단독 흐름을 사용한다. 사용자가 병렬 작업을 요청했다면 `manage-work`로 묶음을 만든다. Orca 등 특정 실행기를 요구하거나 매번 모드를 묻지 않는다.
- **작업 묶음 워커**: doing/blocked/heartbeat는 `work update --attempt <id>`로 기록한다(명령 앞에 `npx haeram-spec-creator`를 붙인다). 태스크 st·base·goal·acceptance 문구·impl notes·STATE·SSOT는 수정하지 않는다. 자신의 acceptance 체크와 result, 구현 코드만 바꾼다.

### 세션 루프 (여러 세션·오케스트레이터)
"남은 태스크 구현해줘"처럼 남은 일을 맡기는 요청이고, `work status`에 활성 작업 묶음이 있거나 todo 태스크에 `lane:`이 있으면 이 루프로 진행한다. ARCH가 단독 checkout 진행을 강제하면 따르지 않는다. 세션은 구현에 집중하고, 통합·묶음 검증은 CLI가 백그라운드에서 실행한다. 다른 세션이 있으면 같은 루프로 기반 → 줄기를 나눠 맡는다.
- owner는 세션마다 한 번 `<도구>-<영숫자 4자>`(예 `claude-k3f9`)로 정하고 끝까지 같은 값을 쓴다.
- 반복: `npx haeram-spec-creator work next --owner <owner> --wait 540 --json`. 활성 묶음이 없으면 `--start`와 ARCH 검증 단계의 명령(`--task-verify` 태스크 단계, `--verify` 단위 통합, `--group-verify` 묶음 완료)을 붙인다 — 같은 커밋에서 시작한 세션들은 같은 묶음에 합류한다. 셸 도구의 timeout은 대기 시간보다 길게 둔다.
- 응답의 `action`대로 하고 `instruction`을 따른다:
  - `implement`: `attempt.workspace`에서 `attempt.tasks`를 `attempt.taskId`부터 순서대로 이 스킬의 2~5단계(작업 묶음 워커 규칙)로 구현하고 태스크마다 커밋한다. lane의 마지막 태스크까지 끝낸 뒤 `work submit --attempt <id> --json`을 한 번 실행한다 — 저장된 태스크 단계 명령이 lane 변경 전체에 실행되고 `ready`가 된다. 응답이 `doing`이면 완료 기록이 빠진 태스크부터 이어 가고, `ready`면 루프로 돌아간다. `correction`이 있으면 그 findings부터 처리한다(통합 실패면 묶음 브랜치를 merge해 해결).
  - `review`: review-task로 `review.workspace`를 읽기 전용 검토하고 `work review-finish`를 실행한다.
  - `blocked`: 직접 고칠 수 있으면 고치고 `work update --attempt <id> --status doing` 후 다시 submit. 기획 판단이 필요하면 함께 모드는 보고하고 멈추고, 맡김 모드는 결정 요청(질문·선택지·추천)을 `work update --attempt <id> --status blocked --reason <요약> --decision-file <repo 밖 JSON>`으로 남기고 루프를 계속한다 — 조정자가 결정한 뒤 재개된다.
  - `wait`: 그대로 다시 호출한다(`reason:needs-reviewer`면 응답의 `instruction`대로).
  - `complete`: 응답 instruction대로 `landFrom`에서 `vibe push`로 SETTINGS land에 반영하고 묶음 브랜치·검증 커밋·반영 결과를 보고한다(묶음에 `--push`가 있으면 통합마다 이미 올라가 있다). land가 미정이면 함께 모드는 haeram-init으로 정하고, 맡김 모드는 inbox `parked`. `stalled`: 막힌 원인을 보고하고 멈춘다(맡김이면 inbox `parked` 후 다른 일). `main-session`: 남은 일이 explore 태스크와 그 후속뿐이다 — 묶음을 마치고 메인 세션에서 단독으로 진행한다.
- 루프에서는 `work integrate`·`work finish`를 직접 실행하지 않고, 다른 세션의 작업 공간에 쓰지 않는다.
