# 실행기 연결

`work run`은 같은 clone의 worktree 사이에서 워커·리뷰어 에이전트를 띄워 배정·리뷰·통합·묶음 검증을 모델 턴 없이 진행한다(원격 clone 간 조정은 없다). 작업 목록·배정·승인·완료 기록의 정본은 gusta runtime이고, 사용자 목표·마감·예산은 시작 대화가 소유한다 — 실행기가 끝나도 남은 목표를 확인하고 회복 가능한 문제는 원래 마감·전체 예산·검증 범위 안에서 새 하위 단위나 일반 스킬로 잇는다.

## 일반 터미널: work run

```bash
npx @haeram/gusta work doctor --json
npx @haeram/gusta work run --work feature --task-verify '<task 단계>' --verify '<단위 통합>' --group-verify '<결정론적 전체 검수>' --dry-run --json
npx @haeram/gusta work run --work feature --task-verify '<task 단계>' --verify '<단위 통합>' --group-verify '<결정론적 전체 검수>' --json
```

- `work doctor`·`--dry-run`은 모델을 부르지 않고 설치·옵션·한도를 확인한다(로그인·요금·모델 권한은 확인하지 않는다). 미리보기만으로 에이전트를 실행했다고 보고하지 않는다.
- 검증 명령은 [검증 절차](../../gusta-start/references/verification.md)의 단계 매핑대로 ARCH에서 가져온다: `--task-verify`(선택)는 태스크 제출 때 호스트가 도는 빠른 검사, `--verify`(필수)는 단위 통합마다의 빠른 통합 검사, `--group-verify`는 모든 단위 통합 뒤 결정론적 전체 검수 한 번이다(생략하면 나중에 `work finish`). 최소 자동 E2E와 지원 브라우저 호환 검사는 CI 몫이라 어느 옵션에도 넣지 않는다. 생략한 옵션은 묶음에 저장된 명령을 쓴다.
- 명령에는 `GUSTA_TIER`(task|unit|group)·`GUSTA_DIFF_BASE`·`GUSTA_TASK`·`GUSTA_TASKS`가 전달된다. 예: `pnpm vitest related --run $(git diff --name-only "$GUSTA_DIFF_BASE" HEAD)`로 영향받는 테스트만 돌린다. 빈 선택이 통과로 끝나지 않게 구성한다. 워커·통합 후보 공간에는 의존성이 없을 수 있으니 ARCH 검증 결정의 `prepare:`나 명령에 준비를 담는다.
- 한도: 작업별 timeout 1시간·전체 dispatch 200회·태스크별 역할별 실행 3회가 기본이고 `--timeout-ms`·`--max-dispatches`·`--max-task-runs`로 바꾼다. 반복 실패는 원인을 확인한 뒤 다시 실행한다.
- `--detach`는 시작 대화로 완료를 돌려주는 연결이 있을 때만 쓴다. 상태는 `work run --work <w> --status`(로그 경로·진행 중 dispatch), 멈춤은 `kill` 대신 `work run --work <w> --stop`이다. 진행은 attempt의 `dispatch.log` 경로(`work board`·`work status` JSON)를 `tail -f`로 본다.
- 결과: `completed`(`--group-verify`까지 통과), `needs-attention`(`remaining`의 태스크·attempt), `dispatch-limit`, `interrupted`, `usage-limit`(리셋 뒤 재실행), `needs-init`(→ /gusta-init), `decision-wait`. 결과의 `snapshotError`·`failures`를 확인한다.
- `--autopilot`: 결정 요청만 남으면 조정자의 답을 기다린다(`--decision-wait-ms`, 기본 15분). 처리는 gusta-start [조정자 절차](../../gusta-start/references/coordinator.md) 3절이다. `--autopilot` 없이 띄우면 결정 요청에서 바로 돌아와 사용자가 정한다.

### 도구·모델

기본(`--provider auto`)은 dispatch마다 태스크 `run:`을 SETTINGS `agents` 안에서 배정하고 한도·로그인 실패는 다음 조합으로 넘긴다. 실제 배정은 attempt의 `dispatch.route`·`workerRoute`에 남는다. 사용자가 도구를 고정할 때만 `--provider codex|claude`·`--providers`·`--reviewer-provider`를, 모델·에포트를 고정할 때만 `--model`·`--reviewer-model`·`--effort`를 넘긴다. 모델을 추정하거나 설치·로그인하지 않는다.

워커 권한은 SETTINGS `permission-mode`(그 실행만 `--permission-mode`)를 따르고 리뷰어는 항상 읽기 전용이다. acceptEdits에서는 새 worktree에 프로젝트 허용 목록이 적용되지 않으니, 워커가 실행할 명령은 `work start|configure --allow-tool 'Bash(pnpm run *)'`로 저장하고 `vibe preflight --probe '<명령>' --allow-tool ...`로 미리 실측한다.

### 단일 도구와 혼합 워커

```sh
npx @haeram/gusta work start feature --workers 6 --reviewers 1 --max-pending 12 --json
npx @haeram/gusta work run --work feature --providers codex,claude --verify '<단위 통합>' --json
```

providers 목록은 워커 슬롯에 순환 배정한다(6슬롯에 `codex,claude`면 3·3, `codex,claude,claude`면 Codex 2·Claude 4, 리뷰어는 별도). 도구별 모델은 adapter 파일의 `workers` 배열로 정하고 `--adapter <file>`로 넘긴다:

```json
{
  "workers": [
    { "provider": "codex", "model": "<codex-model>" },
    { "provider": "claude", "model": "<claude-model>" }
  ],
  "reviewerProvider": "claude",
  "reviewerModel": "<review-model>"
}
```

모델을 생략하면 그 도구 안에서 태스크 `run:`대로 고른다. 다른 실행기를 연결하는 어댑터는 [command 어댑터 규약](adapter.md)을 따른다.

## 읽기 전용 탐색: work scout

네이티브 하위 세션이 없는 오케스트레이터(맡김·헤드리스·Codex)가 탐색을 맡길 때 쓴다. 채운 탐색 프롬프트 파일로 읽기 전용 세션 하나를 띄우고 제안 JSON(`summary`·`proposals[]`)과 토큰 사용량만 받는다. 묶음·배정·승인과 무관하다.

```bash
npx @haeram/gusta work scout --prompt-file <filled scout prompt> --json   # 도구는 SETTINGS agents에서 CLI가 배정
```

## Orca 또는 다른 coordinator

가장 단순한 연결은 [세션 루프](workflow.md)다: 오케스트레이터는 에이전트 N개를 "gusta-implement-task로 남은 태스크를 구현해줘"로 띄우기만 한다. 에이전트마다 owner label을 다르게 하고, `wait`·timeout으로 끝난 에이전트는 같은 label로 다시 띄워 진행 중이던 단위를 잇게 하며, `complete`·`stalled`면 멈춘다. 검증 단계 명령은 start/configure로 묶음에 저장해 둔다.

coordinator가 역할을 직접 나누면 같은 CLI를 단계별로 부른다: 빈 worker 슬롯은 `work next`, worker 완료는 `work submit`, 빈 reviewer 슬롯은 `work review-claim`, 리뷰 완료는 `work review-finish`, 통합·finish는 `work integrate`/`work finish`(next가 백그라운드로 시작하기도 한다). 알림은 중복될 수 있으니 runtime의 attempt/review 상태로 처리 여부를 확인하고, 재시작 뒤에도 runtime을 먼저 읽는다. Orca의 task/dispatch ID는 추적용으로만 매핑하고 의존성·선점·승인·통합을 두 시스템에서 따로 결정하지 않는다.

Orca 명령은 [공식 orchestration 문서](https://www.onorca.dev/docs/cli/orchestration)와 설치된 CLI의 `orca skills get orchestration --full`로 실제 버전을 확인한다. `work doctor`가 orca를 못 찾으면 Orca Settings → General → Orca CLI에서 등록하거나([공식 안내](https://www.onorca.dev/docs/troubleshooting)) `ORCA_CLI_COMMAND`로 실행 파일 경로를 준다.

## 중단과 복구

- 강제 종료 뒤에는 runner와 기록된 자식 PID가 모두 끝났는지 확인하고 `work runner-recover --work <group>`. 확인할 수 없으면 회수하지 않는다.
- 진행 중 검증·통합 명령이 남았으면 `work recover --attempt <id>`, 남은 리뷰 선점은 리뷰어 종료를 확인한 뒤 `work review-release --review <id>`.
- 작업자의 미완료 변경은 검토하고 `work update --attempt <id> --status doing`으로 명시적으로 재개한다. runtime JSON을 직접 고치거나 timeout만으로 다른 작업자의 소유권을 빼앗지 않는다.
- 저장이 실패했으면(`snapshotError`) 원인을 해결하고 runner 종료를 확인한 뒤 `work sync --work <group> --json`. 중단된 sync 예약은 `work recover --work <group>`로 푼다.
