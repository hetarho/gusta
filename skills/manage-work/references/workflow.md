# 작업 묶음 조정

아래 `work ...`는 모두 `npx haeram-spec-creator work ...`의 축약이다. CLI가 `work`를 지원하는 버전인지 확인한다. 직접 runtime JSON을 편집하지 않는다. `--verify`는 ARCH의 실제 검증 명령을 셸로 실행한다.

## 1. 작업 묶음 시작
- 현재 `work status --json`에 활성 묶음이 있으면 이어 쓴다. 사용자가 작은 수정만 요청했다면 작업 묶음을 강제하지 않는다.
- `work start <slug> --workspace auto --task-verify '<태스크 단계>' --verify '<단위 통합>' --group-verify '<묶음 완료>' --json`. 검증 명령은 ARCH의 단계별 verify 결정(task→task-verify, 빠른 통합 검사→verify, 통합/e2e·전체 스위트→group-verify, CI는 최종 코드 push 뒤 vibe ci wait 한 번)에서 가져와 묶음에 저장한다 — 이후 submit·integrate·finish·run과 세션 루프가 기본값으로 쓴다. 바꿀 때는 `work configure`. 명령에는 `HAERAM_TIER`·`HAERAM_DIFF_BASE`·`HAERAM_TASK(S)`가 전달되므로 태스크 단계는 `git diff --name-only "$HAERAM_DIFF_BASE" HEAD`로 영향받는 테스트만 고르는 명령으로 둘 수 있다. 기본 auto는 기존 linked worktree의 브랜치를 기획 공간으로 연결하고, 일반 checkout에서는 `work/<slug>` 브랜치와 별도 기획 worktree를 만든다. 경로·브랜치 접두사로 Orca를 추정하지 않는다.
- `--push <branch>`는 사용자가 요청했을 때만 저장한다(통합마다 push·원격 CI가 돈다). 저장하면 통합된 단위마다 그 브랜치로 반영해 push한다 — 원격이 앞서 있으면 후보에서 먼저 합친다(STATE는 섹션 단위). 막힌 단위가 끝난 단위를 붙잡지 않고, 진행이 원격에 바로 보인다. `--review risky`(기본)는 위험한 단위만 리뷰로 보내고(`--review-path`·`--review-lines`로 조정, 기준은 start-vibe [조정자 절차](../../start-vibe/references/coordinator.md)) `--review all`은 전부 리뷰한다. `--allow-tool`은 헤드리스 워커가 묻지 않고 실행할 명령 규칙이다 — 새 worktree에는 프로젝트 허용 목록이 적용되지 않는다.
- explore 태스크와 그 후속은 묶음에 배정하지 않는다. 다른 단위가 끝나면 next가 `main-session`을 돌려주고, 메인 세션에서 단독으로 진행한다.
- 기존 일반 checkout의 feature branch를 연결하려면 `--workspace current`, 항상 분리하려면 `--workspace new`. 분기 기준·이름·경로가 지정됐다면 `--base`, `--branch`, `--path`를 사용한다. 사용자에게 매번 모드를 묻지 않는다.
- 미커밋 변경은 새 worktree에 복사되지 않는다. 관련 기획을 먼저 정리하고 사용자가 허용한 범위로 커밋한다. 관련 없는 변경은 자동 stash·commit하지 않는다.
- 반환된 `path`에서 기획·채번을 진행한다. 채번 기준은 묶음 브랜치가 아니라 SETTINGS plan 브랜치다 — 기획 전 `vibe plan-sync`로 합치고, spec/만 담은 기획 커밋 직후 `vibe plan-push`로 올린다. 그래서 여러 묶음·worktree가 동시에 기획해도 번호가 겹치지 않는다(먼저 올린 쪽이 이기고, 거절된 쪽이 다시 채번한다). 한 묶음의 기획 공간에는 쓰기 담당을 하나만 둔다. 기획 커밋이 worker 배정의 기준이다.
- 태스크는 create-task의 "기반 → 줄기 → 통합" 구조로 분해한다. 배정 전에 `work board`의 `units`와 errors를 확인한다 — `lane 순환`이 있으면 배정되지 않으므로 기획 공간에서 dep·lane을 먼저 고친다.
- Git 미지원·생성 실패 시 남은 branch/path를 보고한다. 다른 작업자가 없는 안전한 단독 작업은 기존 방식으로 진행할 수 있지만, 선점 실패나 격리 실패를 같은 폴더 병렬 쓰기로 우회하지 않는다.

## 2. 태스크 배정과 진행
- `work board --work <slug> --json`으로 상위 브랜치의 작업과 공유 실행 기록을 함께 읽는다. 배정 단위는 `units`다: lane 하나 또는 lane 없는 태스크 하나. `claimable`은 배정 후보이며 최종 선점은 claim의 원자적 검사로 결정된다.
- `work claim T### --work <slug> --workspace auto --owner <label> --json`. lane에 속한 태스크를 지정하면 그 lane 전체가 배정된다. 기획 공간에서 호출하면 새 worker worktree를 만든다. 미배정 linked worktree에서 호출하면 최신 상위 커밋 포함 여부를 확인하고 연결한다. 별도 공간이 필요하면 `--workspace new`.
- 자동 배정은 `work claim-next --work <slug> --owner <label> --json`. 바깥 후속이 많은 단위, 낮은 ID 순으로 원자적으로 선택한다. 수정 요청은 `work resume --work <slug> --owner <label>`로 먼저 배정한다.
- **세션 루프**: 여러 세션(터미널·Orca 패널)에 각각 "남은 태스크 구현해줘"를 요청하면 implement-task가 `work next --owner <label> --wait 540`을 반복한다. next는 자기 단위 → 수정 요청 → 리뷰(자기 제출물 제외) → 다음 단위 순으로 `action`을 돌려주고, 승인된 단위의 통합과 마지막 묶음 검증은 백그라운드 CLI로 시작한다. 그래서 첫 세션이 기반을 맡고, 다른 세션은 기다렸다 그 기반을 리뷰하고, 통합이 끝나면 각자 다른 줄기를 맡는다. 조정자 세션이 따로 integrate할 필요가 없다. 리뷰어가 없으면 `needs-reviewer`가 돌아온다. idle 응답은 오류가 아니며 reason으로 용량·리뷰 적체·의존 대기를 구분한다. 기본 workers=4, reviewers=1, max-pending=8이며 start 옵션으로 바꿀 수 있다.
- 반환된 `id`(attempt)와 `workspace`를 작업자에게 전달한다. 작업자는 그 경로에서 implement-task를 실행한다. lane 배정이면 같은 작업자가 `tasks`를 순서대로 이어 구현한다. 현재 세션을 다른 작업자의 폴더로 옮겨 대신 쓰지 않는다.
- 상태는 `work update --attempt <id>`(heartbeat), `--status blocked --reason <reason>`, 해결 후 `--status doing`. CLI는 background heartbeat를 실행하지 않으며 오래됐다는 이유만으로 선점을 자동 해제하지 않는다.
- 워커에서 발견한 기획 문제는 reason/result로 인계하고 기획 공간에서 update-ssot/create-task를 수행한다. 진행 중 태스크의 계약은 임의로 바꾸지 않는다. 재분해가 필요하면 작업자를 중단하고 release한 뒤 기획을 갱신하고 새 attempt로 배정한다.
- STATE 전체를 cherry-pick하거나 상태를 보려고 push하지 않는다. 최신 진행은 공유 보드에서 읽는다. 정책·의존 결과를 코드에 반영할 때는 워커의 변경을 보존한 뒤 기획 브랜치를 merge하고 새 기준으로 검증한다. 작업 중 워커를 외부에서 rebase하지 않는다.

## 3. 제출·통합
- 워커는 자신의 태스크 인용줄을 그대로 유지하고 acceptance·result와 구현 코드를 커밋한다. STATE의 doing/done이나 아카이브 이동은 하지 않는다.
- 검증은 세 단계다. **태스크**: 워커가 변경 영향 테스트를 실행하고 `work submit --attempt <id> [--verify '<태스크 단계 명령>'] --json`으로 제출한다(`--verify`는 선택·반복 가능, 전체 스위트는 넣지 않는다). **단위**: `work integrate --verify '<빠른 통합 검사>'`가 lane·태스크 단위 통합마다 실행한다(기본으로 통합/e2e·전체 스위트 금지). **묶음**: 모든 단위가 통합되면 `work finish --work <slug> --verify '<ARCH 전체 검증·CI 재현>' --json`이 한 번 실행하고 검증 커밋을 기록한다. 명령은 ARCH의 단계별 verify 결정에서 가져온다. 최종 관문은 조정자 소유 CLI 하나가 실행하며 워커·리뷰어는 중복 실행하지 않는다.
- lane은 마지막 태스크까지 구현한 뒤 한 번 submit하면 된다. submit은 앞에서부터 이어서 완료된 태스크를 모두 step으로 기록하고, 남은 태스크가 있으면 `doing`과 다음 `taskId`를 돌려준다(실행기는 태스크마다 새 에이전트를 쓰므로 태스크마다 제출한다). 마지막 태스크까지 포함한 submit에서 검사한 HEAD가 바뀌거나 미커밋 변경이 생기면 ready가 되지 않는다. `ready`는 워커 검증 완료이며 dep을 열지 않는다.
- `review-task`가 `work review-claim --work <slug> --owner <reviewer>`(대기하는 리뷰 세션은 `--wait 540`)로 제출물을 선점하고 반환된 고정 커밋·상위 기준으로 리뷰한다. 결과는 `work review-finish --review <id> --result-file <repo 밖 JSON 경로>`. 승인 없이 통합할 수 없으며 수정 요청은 resume→구현→submit→재리뷰한다.
- 세션 루프 밖에서는 조정자가 승인된 제출물에 `work integrate --attempt <id> --json`(저장된 단위 명령, `--verify`로 덮어쓰기 가능). 이 요청은 로컬 후보 생성·검증·상위 작업 브랜치 반영을 수행한다. 후보 worktree에는 의존성 설치나 환경 준비가 없으므로 필요하면 명시적인 검증 명령에 설치/준비도 포함한다. 외부 서비스·공유 DB가 필요한 검증은 프로젝트의 격리 규칙을 따른다.
- CLI는 별도 후보에서 merge, 단위의 모든 태스크 아카이브, STATE 행 제거, spec 검사, 커밋, 지정 검증을 수행한다. 검증 시간 상한은 명령당 1시간이며 `--verify-timeout-ms`로 바꾼다. 상위 checkout이 clean이고 기준이 그대로일 때만 fast-forward한다. 충돌/실패 후보는 보존하며 실제 원인은 JSON details에서 확인한다.
- 승인은 제출 커밋에 묶인다. 코드 변경은 재제출·재리뷰가 필요하고, 상위 커밋이 바뀌면 바뀐 파일이 그 단위의 변경·SSOT와 겹칠 때만 재리뷰한다. 승인됐다고 검증을 생략하지 않는다.
- 통합 후 태스크가 done이고 후속 dep이 열린다. `work finish`의 검증 커밋은 `work board`의 `verified`로 확인한다(`current:false`면 이후 코드가 바뀌었으니 다시 finish). `--push`가 있으면 통합·sync마다 그 브랜치로 push되고 결과는 `group.pushed`에 남는다(거부되면 다음 통합·sync가 원격을 합쳐 다시 push한다). `--push`가 없으면 `work integrate`는 로컬 묶음 브랜치까지만 반영한다. 묶음이 끝나면(`complete`) 응답의 `landFrom`(기획 공간)에서 `vibe push --target <landFrom> --verified-commit <검증 SHA>`로 SETTINGS land에 반영한다. merge·PR·push 방식은 land-via·push가 정한다.
- 같은 트리에서 통과한 검사는 다시 돌리지 않는다(검증 기록에 `cached`). 재제출은 고친 커밋부터의 변경만 `HAERAM_DIFF_BASE`로 넘긴다. 단위·묶음 검증은 clone 단위 heavy 락으로 하나씩 실행된다.

## 4. 정리·복구
- 작업자가 종료된 뒤 `work cleanup --attempt <id>`. 통합/해제된 실행만 정리하며 상위 브랜치에 없는 커밋·미커밋 변경은 보존한다. 외부 생성 공간은 폴더를 남기고 배정만 해제한다. spec/SETTINGS.md `prune-branches`(기본 true)면 자체 생성 공간을 ignored 산출물까지 지우고 합쳐진 단위 브랜치·체크포인트 ref·후보 공간도 지운다. false면 ignored 파일이 남은 공간과 브랜치를 보존한다.
- 실행기가 끝나면 CLI가 끝난 단위를 자동으로 정리한다. 조정을 마칠 때 `vibe prune`을 한 번 실행한다. 묶음 브랜치와 기획 공간은 남은 태스크가 없고 기준(base)·push 브랜치에 합쳐진 경우에만 지워진다. 보존된 항목과 이유는 결과의 `kept`로 보고한다.
- 중단한 워커의 선점을 해제하려면 `work release --attempt <id> --reason <reason>`. 파일은 보존된다. 새 시도에는 새 attempt ID를 쓰며, 이전 ID로 새 실행을 갱신하지 않는다.
- 검증/통합/정리 CLI가 중단됐다면 프로세스 종료를 확인하고 `work recover --attempt <id>`. 생성 중 중단된 기획 공간은 `work recover --work <slug>`. 후자는 예약한 브랜치/경로가 실제로 존재할 때 연결을 복구한다.
- 짧은 runtime 쓰기 락이 남았으면 `work status`의 lock ID로 `work unlock --lock-id <id>`. 살아있는 PID와 다른 호스트의 락은 회수하지 않는다. 불완전한 lock/recovery 디렉토리나 손상된 JSON은 보존하고 진단 내용을 보고한다. `--force` 삭제나 무조건 초기화로 우회하지 않는다.
- 보고: novice에게는 완료·진행·막힌 일과 다음 행동을 설명한다. expert에게는 묶음 브랜치, attempt, 검증 커밋, 통합 결과, 보존한 경로를 간결하게 보고한다.

## 5. 계속 작업하는 워커와 대기 리뷰어
- 사용자가 자리를 비우는 맡김 모드면 `work run --autopilot`으로 실행하고 조정자는 `work next --coordinator --autopilot` 루프로 결정 요청(`decide`)을 처리한다. 절차는 start-vibe의 [조정자 절차](../../start-vibe/references/coordinator.md).
- 여러 태스크를 계속 처리하도록 요청받았으면 [실행기 연결](runner.md)을 읽는다. `work doctor`와 `work run --dry-run`으로 도구·역할·한도를 확인한다. `work run`은 기본 Codex/Claude 또는 command 어댑터를 사용해 워커 보충, lane 다음 태스크 이어 배정, 수정 우선 재배정, 리뷰, 직렬 통합, 묶음 완료 검증을 진행한다. 실제 실행 전 단계별 검증 명령(`--task-verify` 선택, `--verify` 단위 통합, `--group-verify` 묶음 완료)을 지정하고, 검사·미리보기만으로 에이전트를 실행했다고 보고하지 않는다.
- Orca·수동 세션 오케스트레이터 연결은 [runner.md](runner.md)의 'Orca 또는 다른 coordinator'.
- Orca에서는 같은 CLI의 선점·리뷰 프로토콜을 사용하고 실행/완료 알림은 Orca가 맡게 할 수 있다. Orca coordinator와 로컬 runner가 같은 워커 슬롯을 동시에 관리하지 않게 한다.
- STATE next는 사람의 재개 안내 1~3줄이다. 에이전트별 배정은 runtime, 작업 목록은 상위 브랜치 태스크가 기준이다. 빈 작업 슬롯은 의존성이나 리뷰 적체 때문에 정상일 수 있다. 줄기가 서로를 기다리는 구조는 lint가 막으므로, 장시간 빈 슬롯은 줄기 사이 dep(한 줄기 전체가 다른 줄기 통합을 기다림)이나 touches 겹침을 의심한다.
- 실행 변화는 runtime 이력에 계속 누적된다. `work history --work <slug> [--task T###]`로 배정·실행·수정·완료 경위를 확인한다. 태스크 통합과 runner 종료 시 `spec/work/<slug>.json` 상세 기록과 STATE의 선택적 work 요약 표가 묶음 브랜치에 커밋된다. 실행 중 최신 상태는 `work board --work <slug>`로 확인한다. 수동 실행은 작업 명령이 멈춘 체크포인트에서 `work sync --work <slug>`로 저장한다. 워커가 STATE를 직접 쓰지 않는다.
