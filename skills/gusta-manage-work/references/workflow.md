# 작업 묶음 조정

아래 `work ...`는 모두 `npx @haeram/gusta work ...`의 축약이다. runtime JSON을 직접 편집하지 않는다.

## 1. 작업 묶음 시작
- `work status --json`에 활성 묶음이 있으면 이어 쓴다. 사용자가 작은 수정만 요청했다면 작업 묶음을 강제하지 않는다.
- `work start <slug> --workspace auto --task-verify '<task 단계>' --verify '<단위 통합>' --group-verify '<결정론적 전체 검수>' --json`. 명령은 [검증 절차](../../gusta-start/references/verification.md)의 단계 매핑대로 ARCH에서 가져와 묶음에 저장한다 — 이후 submit·integrate·finish·run과 세션 루프가 기본값으로 쓰고, 바꿀 때는 `work configure`. 최소 자동 E2E와 지원 브라우저 호환 검사는 group-verify가 아니라 CI에 둔다. 영향받는 테스트만 고르는 task 명령은 [실행기 연결](runner.md)의 `GUSTA_DIFF_BASE` 예를 쓴다.
- `--workspace`: `auto`(기본 — 기존 linked worktree는 그 브랜치를 기획 공간으로, 일반 checkout은 `work/<slug>` 브랜치와 별도 기획 worktree를 만든다), `current`(지금 checkout의 feature branch), `new`(항상 분리). 분기 기준·이름·경로가 정해졌으면 `--base`·`--branch`·`--path`. 사용자에게 매번 모드를 묻지 않는다.
- `--push <branch>`는 사용자가 요청했을 때만 저장한다(통합마다 push·원격 CI가 돈다). `--review risky`(기본)는 위험한 단위만 리뷰로 보내고(`--review-path`·`--review-lines`로 조정, 기준은 gusta-start [조정자 절차](../../gusta-start/references/coordinator.md)) `--review all`은 전부 리뷰한다. `--allow-tool`은 헤드리스 워커가 묻지 않고 실행할 명령 규칙이다 — 새 worktree에는 프로젝트 허용 목록이 적용되지 않는다.
- 미커밋 변경은 새 worktree에 복사되지 않는다. 관련 기획을 먼저 정리하고 사용자가 허용한 범위로 커밋한다. 관련 없는 변경은 자동 stash·commit하지 않는다.
- 반환된 `path`에서 기획·채번한다: `vibe plan-sync` 후 spec/만 담은 기획 커밋 직후 `vibe plan-push`(채번 기준은 SETTINGS plan 브랜치, 거절되면 다시 채번). 한 묶음의 기획 공간에는 쓰기 담당을 하나만 둔다. 기획 커밋이 worker 배정의 기준이다.
- 태스크는 gusta-create-task의 [기반 → 줄기 → 통합](../../gusta-create-task/references/lanes.md) 구조로 분해한다. 배정 전에 `work board`의 `units`와 errors를 확인하고, `lane 순환`이 있으면 기획 공간에서 dep·lane을 먼저 고친다.
- explore 태스크와 그 후속은 묶음에 배정하지 않는다. next가 `main-session`을 돌려주면 메인 세션에서 단독으로 진행한다.
- Git 미지원·생성 실패면 남은 branch/path를 보고한다. 다른 작업자가 없는 안전한 단독 작업은 단독 흐름으로 진행할 수 있지만, 선점·격리 실패를 같은 폴더 병렬 쓰기로 우회하지 않는다.

## 2. 태스크 배정과 진행
- **세션 루프**: 여러 세션(터미널·Orca 패널)에 각각 "남은 태스크 구현해줘"를 요청하면 gusta-implement-task가 `work next --owner <label> --wait 540`을 반복하며 응답의 `action`(implement·review·blocked·wait·complete·stalled)과 `instruction`을 따른다. 승인된 단위의 통합과 마지막 묶음 검증은 CLI가 백그라운드로 하니 조정자가 따로 integrate하지 않는다. `needs-reviewer`면 리뷰용 세션을 하나 더 띄운다. idle 응답은 오류가 아니며 reason이 용량·리뷰 적체·의존 대기를 구분한다. 기본 workers=4, reviewers=1, max-pending=8이며 start 옵션으로 바꾼다.
- 직접 배정: `work board --work <slug> --json`의 `units`(lane 하나 또는 lane 없는 태스크 하나)와 `claimable`을 보고 `work claim T### --work <slug> --workspace auto --owner <label> --json`(lane 태스크면 lane 전체) 또는 `work claim-next --work <slug> --owner <label> --json`. 수정 요청은 `work resume --work <slug> --owner <label>`로 먼저 배정한다.
- 반환된 `id`(attempt)와 `workspace`를 작업자에게 넘긴다. 작업자는 그 경로에서 gusta-implement-task를 실행하고, lane이면 `tasks`를 순서대로 이어 구현한다. 현재 세션을 다른 작업자의 폴더로 옮겨 대신 쓰지 않는다.
- 상태는 `work update --attempt <id>`(heartbeat), `--status blocked --reason <reason>`, 해결 후 `--status doing`.
- 워커가 발견한 기획 문제는 reason/result로 넘겨 기획 공간에서 gusta-update-ssot/gusta-create-task로 처리한다. 진행 중 태스크의 계약은 임의로 바꾸지 않는다. 재분해가 필요하면 작업자를 중단하고 release한 뒤 기획을 갱신해 새 attempt로 배정한다.
- 최신 진행은 공유 보드에서 읽는다. STATE 전체를 cherry-pick하거나 상태를 보려고 push하지 않는다. 정책·의존 결과를 코드에 반영할 때는 워커의 변경을 보존한 뒤 기획 브랜치를 merge한다. 작업 중 워커를 외부에서 rebase하지 않는다.

## 3. 제출·리뷰·통합
- 워커는 자신의 태스크 인용줄을 그대로 두고 acceptance·result와 구현 코드를 커밋한 뒤 `work submit --attempt <id> [--verify '<task 단계>'] --json`으로 제출한다. lane은 마지막 태스크까지 구현한 뒤 한 번 submit한다(남은 태스크가 있으면 `doing`과 다음 `taskId`가 돌아온다). STATE의 doing/done이나 아카이브 이동은 하지 않는다.
- gusta-review-task가 `work review-claim --work <slug> --owner <reviewer>`(대기하는 리뷰 세션은 `--wait 540`)로 제출물을 선점해 반환된 고정 커밋·상위 기준으로 리뷰하고, `work review-finish --review <id> --result-file <세션 임시 폴더의 JSON 경로>`로 끝낸다. 수정 요청은 resume→구현→submit→재리뷰한다.
- 세션 루프 밖에서는 조정자가 승인된 제출물에 `work integrate --attempt <id> --json`을 실행한다(저장된 단위 명령, `--verify`로 덮어쓰기). 외부 서비스·공유 DB가 필요한 검증은 프로젝트의 격리 규칙을 따른다. 충돌·실패 후보는 보존되니 원인은 JSON details에서 확인한다.
- 모든 단위가 통합되면 `work finish --work <slug> --json`이 결정론적 전체 검수를 한 번 하고 검증 커밋을 남긴다. `work board`의 `verified`가 `current:false`면 이후 코드가 바뀐 것이니 다시 finish한다.
- 묶음이 끝나면(`complete`) 응답의 `landFrom`(기획 공간)에서 `vibe push --target <landFrom> --verified-commit <검증 SHA>`로 SETTINGS land에 반영한다. merge·PR·push 방식은 land-via·push가 정한다.

## 4. 정리·복구
- 작업자가 종료된 뒤 `work cleanup --attempt <id>`. 조정을 마칠 때 `vibe prune`을 한 번 실행하고 보존된 항목과 이유(`kept`)를 보고한다.
- 중단한 워커의 선점을 해제하려면 `work release --attempt <id> --reason <reason>`(파일 보존). 새 시도에는 새 attempt ID를 쓰며 이전 ID로 새 실행을 갱신하지 않는다.
- 검증/통합/정리 CLI가 중단됐다면 프로세스 종료를 확인하고 `work recover --attempt <id>`. 생성 중 중단된 기획 공간은 `work recover --work <slug>`.
- 짧은 runtime 쓰기 락이 남았으면 `work status`의 lock ID로 `work unlock --lock-id <id>`. 불완전한 lock/recovery 디렉토리나 손상된 JSON은 보존하고 진단 내용을 보고한다. `--force` 삭제나 무조건 초기화로 우회하지 않는다.
- 보고: novice에게는 완료·진행·막힌 일과 다음 행동을 설명한다. expert에게는 묶음 브랜치, attempt, 검증 커밋, 통합 결과, 보존한 경로를 간결하게 보고한다.

## 5. 계속 작업하는 워커와 대기 리뷰어
- gusta-start가 맡긴 실행이면 `work run --autopilot`과 조정자 루프로 한다 — gusta-start의 [조정자 절차](../../gusta-start/references/coordinator.md).
- 여러 태스크를 계속 처리하도록 요청받았으면 [실행기 연결](runner.md)대로 `work run`을 쓴다. Orca·수동 오케스트레이터 연결도 같은 파일의 'Orca 또는 다른 coordinator'다. Orca coordinator와 로컬 runner가 같은 워커 슬롯을 동시에 관리하지 않게 한다.
- 빈 작업 슬롯은 의존성이나 리뷰 적체 때문에 정상일 수 있다. 오래 비면 줄기 사이 dep(한 줄기 전체가 다른 줄기 통합을 기다림)이나 touches 겹침을 의심한다.
- 경위는 `work history --work <slug> [--task T###]`, 실행 중 최신 상태는 `work board --work <slug>`로 본다. 수동 실행은 작업 명령이 멈춘 체크포인트에서 `work sync --work <slug>`로 저장한다. 워커는 STATE를 직접 쓰지 않고, STATE next는 사람의 재개 안내 1~3줄이다.
