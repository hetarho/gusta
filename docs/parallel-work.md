# 병렬 작업

[README](../README.ko.md) · [개발 흐름](workflow.md) · [브랜치·검증](branching.md) · [오래 맡기기](autopilot.md) · **병렬 작업** · [자가 개선](self-improve.md) · [CLI](cli.md)

## 혼자 여러 AI 작업 진행하기

특정 실행기는 필요 없습니다. 일반 터미널에서 Git worktree를 직접 만들거나, Orca 등 외부 도구가 만든 공간을 그대로 사용할 수 있습니다. 작은 단독 작업은 기존 스킬 흐름을 유지하고, 여러 태스크를 묶어 진행할 때 `gusta-manage-work`를 사용합니다.

```text
로그인 개편을 작업 묶음으로 시작하고, 독립적인 태스크는 worktree로 나눠 진행해줘.
완료된 결과는 작업 묶음 브랜치에 검증해서 통합해줘.
```

에이전트는 기본 `auto`로 작업 공간을 선택합니다. 매번 작업 공간 방식을 고를 필요는 없습니다.

| workspace 옵션 | 동작 |
|---|---|
| `auto` (기본) | start는 기존 linked worktree를 기획 공간으로 연결하거나 새 기획 공간을 생성합니다. claim은 미배정 linked worktree를 연결하거나 새 worker 공간을 생성합니다. |
| `current` | 현재 checkout과 브랜치를 사용합니다. 기획 공간을 워커와 공유하는 배정은 거부합니다. |
| `new` | 별도 브랜치와 worktree를 생성합니다. |

새 작업 공간은 기본적으로 저장소 옆 `.gusta-worktrees/` 아래에 생성합니다. `--path`로 바꿀 수 있습니다. 이름·분기 기준을 지정하려면 start에 `--branch`·`--base`를 사용합니다. 자동 생성이 실패하면 경로와 원인을 보고하며 현재 checkout을 전환하거나 같은 폴더에서 병렬 쓰기를 시작하지 않습니다. Git이 없으면 기존 단독 흐름을 사용합니다.

다음은 CLI로 직접 진행하는 예입니다. `login`, `T042`, 경로, 검증 명령은 프로젝트에 맞게 바꿉니다. 시작 전 계획을 커밋하고, 생성 후 반환된 경로에서 작업합니다.

```bash
# 상위 작업 브랜치와 기획 공간 생성/연결
npx @haeram/gusta work start login --json

# 어디서 실행해도 상위 브랜치 기준의 진행 상황 조회
npx @haeram/gusta work board --work login --json

# 독립 태스크마다 실행: 반환된 workspace와 id를 해당 작업자에게 전달
npx @haeram/gusta work claim T042 --work login --owner agent-a --json

# 워커는 코드와 자기 태스크의 acceptance/result를 작성하고 커밋
# 실제 실행 ID를 변수에 넣은 뒤 검증·제출 (예: npm 프로젝트)
ATTEMPT_ID='claim이 반환한 id'
# --verify는 선택: 이 태스크의 영향 단위 테스트만 (최종 통합/e2e는 조정자 finish 관문)
npx @haeram/gusta work submit --attempt "$ATTEMPT_ID" --verify 'npx vitest run src/login' --json

# 리뷰어가 고정된 제출물을 선점하고 gusta-review-task로 검토
npx @haeram/gusta work review-claim --work login --attempt "$ATTEMPT_ID" --owner reviewer --json
REVIEW_ID='review-claim이 반환한 id'
# 실제 리뷰 결과를 저장소 밖 JSON 파일에 작성한 뒤 기록
npx @haeram/gusta work review-finish --review "$REVIEW_ID" --result-file /tmp/review-result.json --json

# 승인된 변경을 별도 후보에서 재검증하고 상위 브랜치에 반영
# 후보 worktree에는 의존성이 없으므로 필요한 설치도 명시
npx @haeram/gusta work integrate --attempt "$ATTEMPT_ID" --verify 'npm ci && npm run lint' --json

# 모든 단위가 통합되면 묶음 전체 검증을 한 번 실행하고 검증 커밋을 기록
npx @haeram/gusta work finish --work login --verify 'npm ci && npm run ci' --json

# 작업자가 종료한 뒤 공간 정리
npx @haeram/gusta work cleanup --attempt "$ATTEMPT_ID" --json
```

상태 흐름은 `doing → ready → reviewing → approved → integrated`입니다. 수정 요청은 `changes_requested → doing → ready`로 재검증·재리뷰합니다. `ready`는 워커 검증을 마친 리뷰 대기 상태이고, `integrated`가 되어야 태스크 파일이 `done/`으로 이동하고 후속 의존성이 열립니다.

`work start`(또는 `work configure`)에 `--push main`처럼 push 브랜치를 주면 **통합된 단위마다 그 브랜치로 바로 반영하고 push합니다** — 원격이 앞서 있으면 후보에서 먼저 합친 뒤 단위 검증을 돌립니다. 막힌 단위 하나가 끝난 단위들을 붙잡지 않고, 진행이 원격에 바로 보입니다. `--push`가 없으면 CLI는 로컬 작업 브랜치까지만 통합하고 main 반영·PR·push는 프로젝트의 기존 흐름을 따릅니다.

리뷰는 기본적으로 위험한 단위만 받습니다(`--review risky`). 변경 300줄 초과(`--review-lines`), touches 밖 변경이나 touches 미선언, `--review-path`로 지정한 계약 경로 변경, 테스트 파일 변경 없음, 수정 요청·통합 실패 이력, 실행 중 추천안으로 내린 잠정 결정이 걸린 태스크 — 하나라도 해당하면 리뷰, 아니면 정책 승인 후 통합 검증만 합니다. 전부 리뷰하려면 `--review all`. 수정 후 재제출은 고친 커밋부터의 변경만 태스크 단계에 넘깁니다. explore 태스크와 그 후속은 묶음에 배정하지 않습니다.

진행 중 기록과 상태 변화 이력은 `<git-common-dir>/gusta/v1/state.json`에 저장됩니다. 같은 clone의 worktree들이 공유하고 runtime 자체는 Git에 커밋하지 않습니다. 태스크 통합과 실행기 종료 시 `spec/work/<묶음>.json` 상세 기록 및 `STATE.md`의 작업 묶음 요약을 Git에 저장합니다. CLI는 원자적 예약으로 동일 태스크 및 동일 작업 공간의 이중 배정을 막습니다. 워커는 STATE·SSOT를 바꾸지 않으며, 기획 변경·채번은 하나의 기획 공간에서 진행합니다.

검증 명령은 사용자가 지정한 `--verify`를 셸에서 순서대로 실행합니다(여러 번 지정 가능, 명령별 기본 1시간 제한, `--verify-timeout-ms`로 변경). ARCH에 정의된 실제 검사와 필요한 환경 준비를 넣어야 합니다. 워커 HEAD가 변경되거나 검사가 미커밋 변경을 만들면 제출이 실패합니다. 통합은 별도 후보에서 수행하며, 충돌·검증 실패·상위 브랜치 이동이 있으면 후보를 보존합니다. 검증은 지정한 명령의 성공을 보장하며, 어떤 테스트가 충분한지는 프로젝트의 acceptance/ARCH가 정합니다.

중단·정리 명령도 제공합니다.

```bash
npx @haeram/gusta work status --json              # 현재 작업·소유권 요약
npx @haeram/gusta work status --work login --details --json # 필요한 묶음의 상세 이력
npx @haeram/gusta work update --attempt "$ATTEMPT_ID" --status blocked --reason 'API contract needs a planning decision'
npx @haeram/gusta work update --attempt "$ATTEMPT_ID" --status doing
npx @haeram/gusta work release --attempt "$ATTEMPT_ID" --reason 'worker stopped'
npx @haeram/gusta work recover --attempt "$ATTEMPT_ID"
npx @haeram/gusta work recover --work login
npx @haeram/gusta work --help
```

`release` 전에 기존 작업자를 종료해야 하며 heartbeat가 오래됐다는 이유만으로 선점을 빼앗지 않습니다. `recover`는 중단된 검증·통합·정리를 조정하고, `cleanup`은 미커밋·미추적 파일이 남은 공간을 보존합니다. 락 회수·외부 worktree·실패 후보 처리는 [작업 묶음 절차](../skills/gusta-manage-work/references/workflow.md)에 있습니다.

`context --json`은 Git/worktree와 현재 작업 모드를 보여 줍니다. 일반 `board`는 현재 checkout의 파일만 읽는 조회 명령이고, `work board`가 작업 묶음의 기준 커밋과 공유 실행 기록을 함께 보여 줍니다. 보드의 claimable은 조회 시점의 후보이며 선점 자체는 claim이 수행합니다. JSON의 `schemaVersion`은 1입니다.

작업 묶음의 원자적 선점은 같은 로컬 clone 안에서 동작합니다. 다른 기기(clone)와의 중복은 SETTINGS push가 켜져 있으면 `/gusta-start`가 막습니다 — 세션은 STATE `## active` 행과 doing tag를 먼저 push해 선점하고, 다른 기기는 시작할 때 그 행과 `wip/<tag>` 스냅샷으로 진행 중인 일을 알아채고 그 태스크를 건너뜁니다. fan-out 경쟁 구현은 포함하지 않습니다. 자동 실행은 아래의 기본 실행기 또는 command 어댑터로 연결합니다. 기획 공간의 수동 Git 작업은 CLI 예약을 따르지 않으므로 통합 중 같은 checkout에서 다른 변경을 실행하지 않아야 합니다. 기존 프로젝트의 `spec/FORMAT.md`·`STATE.md`는 install로 자동 이관되지 않으며, 작업 묶음은 기존 task 골격을 이용하는 선택 기능입니다. 다른 clone에도 Git에 저장된 태스크·실행 이력 체크포인트가 남지만 현재 프로세스·선점 소유권과 명령 출력 로그는 전파되지 않습니다.

### 줄기(lane)로 나누고 단계별로 검증하기

병렬 묶음은 **기반 → 줄기 → 통합**으로 분해합니다. 여러 줄기가 함께 쓰는 공통 계약을 기반 태스크로 먼저 만들고, 독립적인 흐름은 태스크 인용줄에 `lane:<이름>`을 붙여 줄기로 묶고, 줄기 결과를 잇는 태스크는 lane 없이 각 줄기에 dep을 겁니다.

```text
T001 (기반) → lane:a [T002 → T003 → T004]
            → lane:b [T005 → T006 → T007]  → T011 (통합)
            → lane:c [T008 → T009 → T010]
```

- 줄기 하나가 배정·리뷰·통합의 단위입니다. 한 작업자가 한 worktree에서 줄기의 태스크를 순서대로 구현하며, 줄기 안의 dep은 통합을 기다리지 않습니다. 줄기의 마지막 태스크까지 구현한 뒤 `submit`을 한 번 하면 완료된 태스크 전부가 기록되고 리뷰 대기(`ready`)가 됩니다. 태스크마다 제출해도 되며, 그때는 같은 공간에 다음 `taskId`를 돌려줍니다.
- 줄기는 바깥 dep이 모두 통합된 뒤에만 시작하므로 줄기 도중에 다른 줄기를 기다리며 멈추지 않습니다. 두 줄기가 서로의 태스크를 기다리면(T009(c)→T005(b), T006(b)→T009(c)) `lint`와 `work board`가 `lane 순환` 오류를 내고 배정을 거부합니다. 공통 선행은 기반으로, 소비 태스크는 통합 단계로 옮기거나 줄기를 합칩니다.
- 검증은 세 단계입니다. **태스크**: 그 태스크가 추가·수정·영향을 준 테스트만 실행합니다. **단위**: 줄기마다 통합할 때 빠른 검사만 실행합니다. **묶음**: 모든 통합 뒤 최종 검증을 한 번 실행합니다. 명령은 `work start`(또는 `work configure`)의 `--task-verify`·`--verify`·`--group-verify`로 묶음에 저장하고, 각 명령에는 `GUSTA_TIER`·`GUSTA_DIFF_BASE`·`GUSTA_TASK(S)`가 전달됩니다. 예를 들어 태스크 단계를 `pnpm vitest related --run $(git diff --name-only "$GUSTA_DIFF_BASE" HEAD)`로 두면 호스트가 영향받는 테스트를 직접 실행합니다.
- 상위 브랜치가 바뀌어도 바뀐 파일이 제출물의 변경이나 SSOT와 겹치지 않으면 리뷰 승인이 유지되고, 겹치면 재리뷰합니다. 줄기 여러 개를 연달아 통합해도 재리뷰가 반복되지 않습니다.

### 세션 여러 개로 진행하기 (터미널·Orca)

세션을 여러 개 열고 각각 `/gusta-start`(또는 "남은 태스크 해줘")를 실행하면 같은 루프가 알아서 일을 나눕니다. 태스크에 `lane:`이 있거나 활성 묶음이 있으면 gusta-start가 부른 gusta-implement-task가 `work next --owner <세션 이름> --wait 540`을 반복합니다.

```text
세션 A: 기반 T001 구현 → 제출 ─────────────────→ 줄기 a 구현 ...
세션 B: (대기) ───────→ T001 리뷰·승인 → (통합 대기) → 줄기 b 구현 ...
CLI   :                               └ 백그라운드 통합(빠른 검사)
```

- next는 자기 단위 → 수정 요청 → 다른 세션 제출물 리뷰 → 다음 단위 순으로 `action`(`implement`·`review`·`blocked`·`wait`·`complete`·`stalled`)을 돌려줍니다. 받을 일이 없으면 모델 호출 없이 기다립니다.
- 승인된 단위의 통합과 마지막 묶음 검증은 CLI가 백그라운드 프로세스로 실행하므로 세션은 구현과 리뷰에만 집중합니다. 통합이 실패하면 그 줄기의 작업자에게 수정 요청으로 돌아갑니다.
- 활성 묶음이 없으면 첫 세션의 `next --start`가 만들고, 같은 커밋에서 시작한 다른 세션은 그 묶음에 합류합니다.
- 자기 작업은 스스로 승인할 수 없습니다. 세션이 하나뿐이면 `needs-reviewer`가 돌아오므로 세션을 하나 더 열거나 리뷰 서브에이전트를 씁니다.
- Orca 같은 오케스트레이터는 이 요청을 받은 에이전트 N개를 유지하고, `wait`·timeout으로 끝난 에이전트만 다시 띄우면 됩니다. 배정·리뷰·통합 판단은 CLI가 합니다.

설계 배경은 [협업 설계 검토](history/worktree-collaboration-review.md)에 기록합니다.

## 워커 4개와 리뷰어 1개로 대기 작업 계속 처리하기

`STATE.next`는 사람이 재개할 때 볼 안내입니다. 개별 에이전트의 배정은 공유 runtime이 관리합니다. `claim-next`는 의존성이 충족된 단위(줄기 하나 또는 lane 없는 태스크 하나) 중 후속 작업을 많이 여는 단위, 오래된 ID 순으로 하나를 선택하고 원자적으로 선점합니다. 동시에 요청해도 같은 태스크를 배정하지 않습니다. `next`는 resume과 claim-next를 합치고 `--wait`로 대기할 수 있습니다.

```bash
npx @haeram/gusta work start feature --workers 4 --reviewers 1 --max-pending 8 --json
npx @haeram/gusta work claim-next --work feature --owner worker-a --json
npx @haeram/gusta work resume --work feature --owner worker-a --json
npx @haeram/gusta work next --work feature --owner worker-a --wait 540 --json
```

수정 요청이 있으면 resume로 먼저 처리합니다. 리뷰 대기가 max-pending에 도달하면 새 배정을 멈춥니다. 태스크 인용줄에 선택 필드 `touches:src/auth/ prisma/schema.prisma`를 적으면 겹치는 영역은 통합/해제될 때까지 직렬화합니다. 생략은 영향 범위가 알려지지 않았다는 뜻입니다. claimable은 보드의 후보 표시이며, 실제 배정은 용량·적체·신선도를 다시 검사합니다.

`work run`은 설치된 Codex·Claude CLI로 빈 워커 슬롯 보충, 줄기의 다음 태스크를 같은 공간에 이어 배정, 완료 후 검증·리뷰, 수정 재배정, 승인 후 직렬 통합, 묶음 완료 검증까지 수행합니다. 단계 명령은 [줄기 절](#줄기lane로-나누고-단계별로-검증하기)과 같습니다. 작업자와 리뷰어의 도구를 다르게 지정할 수 있습니다.

```bash
npx @haeram/gusta work doctor --json
npx @haeram/gusta work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --dry-run --json
npx @haeram/gusta work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --json
```

doctor와 dry-run은 모델을 호출하지 않습니다. `--autopilot`이면 사람이 없다는 전제로 돕니다 — 기획 결정이 필요한 워커는 결정 요청을 남기고 다른 단위가 계속되며, 조정자 세션(`work next --coordinator --autopilot`)이 잠정 결정해 `work update --status doing --note`로 재개하면 실행기가 기획 브랜치를 합치고 **같은 세션**을 이어 실행합니다. 같은 lane의 다음 태스크와 수정도 세션을 이어 쓰고, 워커에게는 태스크·인용 결정·검증 명령을 묶은 브리핑(`work brief`)을 넘깁니다. timeout 전에는 작업 공간을 스냅샷하고 진행분을 커밋해 이어 가며, macOS에서는 실행 중 절전을 막습니다. 새 worktree에는 프로젝트의 권한 허용 목록이 적용되지 않으므로 워커가 실행할 명령은 `--allow-tool`로 묶음에 저장합니다. provider를 생략하면 호환되는 Codex, Claude 순으로 선택하며, reviewer-provider를 생략하면 같은 도구를 사용합니다. 모델은 각 CLI 기본 설정을 사용하거나 `--model`·`--reviewer-model`로 지정합니다. CLI 로그인과 모델 접근 권한은 별도 준비가 필요합니다. 기본 어댑터의 워커는 파일을 편집하고, 호스트가 계약·변경 범위를 검사한 뒤 커밋·검증·제출합니다.

다른 실행기는 `--adapter <json-file>`로 연결할 수 있습니다. [실행 설정과 Orca 연결 방법](../skills/gusta-manage-work/references/runner.md)에 설정 예·출력 규약·권한·복구 절차가 있습니다. Orca에서는 coordinator가 같은 선점·리뷰 CLI를 호출할 수 있습니다. doctor는 macOS Orca 앱에 포함된 CLI도 찾아 확인하지만 Orca pane/task/dispatch 자동 생성 어댑터는 아직 포함하지 않습니다.

### 태스크 30개를 워커 6개로 실행하기

```sh
npx @haeram/gusta work start feature --workers 6 --reviewers 1 --max-pending 12 --json
# Claude만 실행하려면 --provider claude, Codex만 실행하려면 --provider codex
npx @haeram/gusta work run --work feature --providers codex,claude --verify 'npm run lint' --group-verify 'npm test' --json
```

혼합 목록은 슬롯에 반복 배정합니다. `codex,claude`는 각각 3개, `codex,claude,claude`는 Codex 2개와 Claude 4개가 됩니다. 모델을 생략하면 각 CLI의 설정을 사용하며, 도구별 모델은 [adapter workers 설정](../skills/gusta-manage-work/references/runner.md#단일-도구와-혼합-워커)에 지정합니다. 리뷰어는 워커 6개와 별도로 실행됩니다.

태스크를 미리 5개씩 묶지 않고 빈 슬롯이 다음 가능한 단위(lane이면 줄기 전체)를 가져갑니다. 작업 시간 차이로 일부 슬롯이 더 많은 일을 처리할 수 있고, 의존성·예상 변경 경로·리뷰 적체 때문에 동시 실행 수가 줄어들 수 있습니다.

```sh
npx @haeram/gusta work board --work feature --json
npx @haeram/gusta work history --work feature --task T001 --json
# 수동으로 실행했다면 작업 명령이 멈춘 체크포인트에서 Git에 저장
npx @haeram/gusta work sync --work feature --json
```

보드의 `summary`는 총량·완료·남은 일·실행·리뷰·blocked 수를 보여 줍니다. STATE의 선택적 `## work` 표는 같은 요약과 상세 JSON 링크를 저장합니다. 완료 태스크의 acceptance·검증 근거는 `tasks/done/`, 배정·실행 도구·수정 요청·재시도 이력은 `spec/work/feature.json`에 남습니다. STATE는 마지막 저장 시점의 체크포인트이고 실행 중 최신 상태는 보드에서 확인합니다.

실행기는 통합할 때마다 기록을 저장하고 정상 완료·한도 도달·처리한 종료 신호 뒤 최종 기록을 커밋합니다. 저장에 실패하면 결과의 `snapshotError`와 `failures`에 원인을 남깁니다. 미커밋 기획 변경을 정리한 뒤 `work sync`로 다시 저장할 수 있습니다. 실행 중 수동 sync는 거부합니다. sync 커밋은 STATE와 실행 기록만 바꾸므로 리뷰 승인을 무효화하지 않습니다. 새 clone에서도 `work history`로 저장된 이력을 조회할 수 있지만 과거 워커의 실행 권한을 복원하지는 않습니다.

리뷰는 제출 커밋에 묶입니다. P1/P2 finding이 있으면 승인할 수 없고, 코드 변경은 재제출이 필요합니다. 합친 결과는 통합 검증이 다시 확인합니다. 이 리뷰는 기존 gusta-review-code의 사용자 채택형 개선 제안과 별도로 동작합니다.

runner는 대기 중 모델을 반복 호출하지 않고 프로세스 완료를 기다립니다. 작업자가 긴 작업 중 최신 정책을 읽는 절차는 스킬에서 수행하며, heartbeat만으로 에이전트의 문맥이 자동 갱신되지는 않습니다. 전부 통합하면 completed, 더 진행할 수 없는 작업이 남으면 needs-attention과 목록을 반환합니다. 재시도/실행 횟수 제한과 중단 복구를 지원합니다. 자동 cleanup은 하지 않으며, 대상 브랜치 반영·push는 묶음에 `--push <branch>`가 있을 때만 통합 단위마다 합니다.
