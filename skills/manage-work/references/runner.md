# 실행기 연결

작업 목록·배정·리뷰 승인·완료의 기준은 haeram runtime이다. 실행기는 에이전트를 시작하고 결과를 전달한다. 같은 clone의 worktree 사이에서 사용하며, 원격 clone 간 조정은 제공하지 않는다.

## 일반 터미널: work run

사용자가 여러 태스크의 지속 실행을 요청했을 때 사용한다. Codex·Claude CLI용 기본 어댑터가 포함돼 있다. `work doctor`로 설치·필수 옵션 지원과 Orca runtime 접근 여부를 확인한다. CLI 로그인·요금·모델 접근 권한은 검사하지 않으며, doctor와 dry-run은 모델을 호출하지 않는다. 실행기는 리뷰·검증 통과 후 작업 묶음 브랜치까지 자동 통합한다. 묶음에 `--push <branch>`가 저장돼 있으면 통합마다 그 브랜치로 push한다(원격이 앞서 있으면 후보에서 먼저 합친다). 없으면 묶음 브랜치까지만 반영한다. land 반영은 조정자가 `complete` 뒤 `vibe push`로 한다.

```bash
npx haeram-spec-creator work start feature --workers 4 --reviewers 1 --max-pending 8 --json
npx haeram-spec-creator work doctor --json
npx haeram-spec-creator work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --dry-run --json
npx haeram-spec-creator work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --json
```

기존 그룹은 기록된 한도를 사용하고, 한도 기록이 없는 그룹은 4/1/8을 사용한다.

### 검증 단계
- `--task-verify`(선택): 태스크마다 호스트가 제출 커밋에 실행하는 빠른 검사(lint·타입 검사 등). 워커는 별도로 자기 태스크가 추가·수정·영향을 준 테스트만 실행한다. 전체 스위트를 여기에 넣으면 태스크마다 전체 테스트가 돌아 단계 구분의 의미가 없다.
- `--verify`(필수): 단위(lane 또는 lane 없는 태스크)를 통합할 때마다 merge 후보에서 한 번 실행한다. 기본은 빠른 통합 검사이며 통합/e2e·전체 스위트는 넣지 않는다.
- `--group-verify`: 기본 통합/e2e·전체 스위트 관문이다. 모든 단위가 통합되면 조정자 소유 CLI 하나가 묶음 브랜치에서 한 번 실행하고 검증 커밋을 기록한다(`work board`의 `verified`). 생략하면 나중에 `work finish`로 실행한다.
- 각 옵션은 반복할 수 있고 명령당 상한은 1시간이다(`--verify-timeout-ms`). 명령은 ARCH의 단계별 verify 결정에서 가져온다. 생략하면 `work start`/`work configure`로 묶음에 저장한 명령을 쓴다.
- 같은 트리에서 이미 통과한 명령은 다시 돌리지 않는다(`HAERAM_*`를 읽는 명령은 그 값까지 같아야 한다). 기록에는 `cached`로 남는다. 단위·묶음 검증은 clone 단위 heavy 락을 잡고 하나씩 실행된다 — `vibe check --heavy`로 돌리는 실험과도 겹치지 않는다.
- 명령에는 `HAERAM_TIER`(task|unit|group), `HAERAM_DIFF_BASE`(태스크=이전 단계 커밋, 재제출=고친 대상 커밋, 단위=통합 전 상위 커밋, 묶음=묶음 시작 커밋), `HAERAM_TASK`·`HAERAM_TASKS`가 전달된다. 예: `pnpm vitest related --run $(git diff --name-only "$HAERAM_DIFF_BASE" HEAD)`로 호스트가 영향받는 테스트를 직접 실행한다. 빈 선택이 통과로 끝나지 않게 명령을 구성한다.

### lane
lane 단위는 한 worker 슬롯과 한 작업 공간을 끝까지 사용한다. 실행기는 태스크 하나씩 에이전트를 실행하고, 제출이 다음 `taskId`를 돌려주면 같은 슬롯·공간에 이어서 배정한다. 다음 태스크·수정 요청·답을 받은 결정 요청은 같은 세션을 이어서(resume) 실행한다 — 연속 4회까지, 그 뒤에는 새 세션. 세션 ID는 실행이 끝나기 전에 기록되므로(Claude는 `--session-id`로 미리 정하고, Codex는 첫 이벤트의 thread ID) timeout으로 끊긴 실행도 이어 갈 수 있다. 워커에게는 `work brief --attempt <id>`와 같은 `brief`(묶음 브랜치의 고정 커밋 기준, 내용은 stdin `brief` 항목)를 넘긴다 — STATE·FORMAT·ARCH 전체를 다시 읽지 않게 한다. 기본 어댑터는 brief를 JSON 대신 마크다운으로 프롬프트에 싣는다. 세션 루프의 세션은 lane 전체를 구현한 뒤 한 번 제출한다. 리뷰와 통합은 lane 전체에 한 번이다. stdin의 `tasks`는 단위 전체, `taskId`는 이번에 구현할 태스크다. worker/review 작업 공간과 통합 후보는 필요한 환경이 설치되지 않았을 수 있다. 작업자가 환경 준비를 할 수 있도록 지시하고 검증 명령에도 필요한 준비를 포함한다.

`--provider auto`가 기본이며 호환되는 Codex, Claude 순으로 선택한다. Orca 설치 여부로 실행 방식을 바꾸지 않는다. reviewer-provider를 생략하면 worker와 같은 도구를 사용한다. `--model`·`--reviewer-model`을 생략하면 각 CLI의 설정을 사용한다. 같은 도구의 리뷰어는 명시한 worker 모델을 상속하고, 다른 도구의 리뷰어는 모델을 따로 지정하지 않으면 그 CLI 기본값을 사용한다. 임의로 모델을 추정하거나 설치·로그인하지 않는다.

### 단일 도구와 혼합 워커

```sh
npx haeram-spec-creator work start feature --workers 6 --reviewers 1 --max-pending 12 --json
# Codex만: --provider codex, Claude만: --provider claude
npx haeram-spec-creator work run --work feature --providers codex,claude --verify 'npm run lint' --json
```

providers 목록은 슬롯에 순환 배정한다. 6개 슬롯과 `codex,claude`는 각각 3개, `codex,claude,claude`는 Codex 2개·Claude 4개다. 워커 6개에 리뷰어는 별도다. 각 슬롯은 단위 완료 뒤 다음 의존성 충족 단위를 가져간다. 태스크 30개를 꼭 5개씩 고정 분배하지 않으며, dep·touches·리뷰 적체가 있으면 실제 동시 실행 수는 줄어든다.

각 도구의 모델을 지정하려면 adapter 파일을 사용한다. workers 배열 역시 슬롯에 순환 배정한다.

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

모델을 생략하면 해당 CLI 설정을 사용한다. 혼합 실행에서는 리뷰어 모델을 워커에서 상속하지 않고, reviewerProvider를 생략하면 목록의 첫 도구를 사용한다. `--provider`와 `--providers`는 함께 지정하지 않는다. 혼합 실행의 `--model`은 거부하며 adapter의 각 workers 항목에 지정한다. `--adapter`와 provider/model CLI 옵션도 함께 지정하지 않는다.

기본 어댑터는 새 세션에 배포된 implement-task/review-task 본문과 배정 정보를 전달하고, 이어 쓰는 세션에는 새 정보(다음 태스크, correction, 조정자 메모)만 보낸다. Codex는 worker에 workspace-write, reviewer에 read-only sandbox를 지정하고 JSON schema와 최종 결과 파일을 사용한다. Claude는 worker에 acceptEdits, reviewer에 plan 권한 모드와 역할별 도구 목록을 지정하고 structured_output을 읽는다. 기존 인증·권한 정책을 사용하며 권한을 건너뛰는 옵션은 사용하지 않는다. 워커가 도는 새 worktree는 한 번도 신뢰한 적 없는 폴더라서 `claude -p`는 프로젝트 `.claude/settings.json`의 `permissions.allow`를 적용하지 않는다. 워커가 실행해야 할 명령은 `work start/configure --allow-tool 'Bash(pnpm run *)'`로 묶음에 저장하면 워커의 `--allowedTools`에 더해진다. `vibe preflight --probe '<명령>' --allow-tool ...`이 같은 조건의 새 worktree에서 실제 헤드리스 워커로 그 명령을 실행해 보고 권한 거부를 미리 알려 준다. 호스트의 `--verify` 명령은 별도로 실행된다. CLI 출력 형식이 맞지 않거나 종료 코드가 실패면 완료로 취급하지 않는다. 규약 근거: [Codex 비대화형 실행](https://developers.openai.com/codex/noninteractive/), [Claude headless 실행](https://code.claude.com/docs/en/headless).

기본 어댑터의 워커는 코드와 자신의 태스크만 편집하고 커밋하지 않는다. 호스트가 시작 시 깨끗한 작업 공간과 HEAD를 기록하고, 종료 시 acceptance·계약·SSOT·spec 변경 범위를 검사한 뒤 커밋한다(`committing`). 이어 검증·제출한다. 예상 밖 HEAD 변경이나 계약 위반은 blocked로 남기며 변경을 되돌리지 않는다. sandbox의 공용 Git 디렉토리 쓰기 권한을 넓히지 않아도 된다.

기본값은 작업별 timeout 1시간, 전체 dispatch 200회, 태스크별·역할별 실행 3회다(lane은 태스크마다 센다). `--timeout-ms`·`--max-dispatches`·`--max-task-runs`로 지정할 수 있다. JSON 설정도 가능하다: `{"provider":"codex","reviewerProvider":"claude","maxTaskRuns":3}`를 파일에 저장하고 `--adapter <file>`로 전달한다. provider/model CLI 옵션과 adapter 파일은 함께 지정하지 않는다.

## 읽기 전용 탐색: work scout

네이티브 하위 세션이 없는 오케스트레이터(맡김·헤드리스·Codex)가 탐색을 맡길 때 쓴다. 채운 탐색 프롬프트 파일로 읽기 전용 세션 하나를 띄우고(Claude plan 모드·Codex read-only, 기본 15분) 제안 JSON(`summary`·`proposals[]`)과 토큰 사용량만 돌려준다. 실행기 진행 로그는 결과에 싣지 않는다. 묶음·runtime과 무관하며 배정·승인을 만들지 않는다.

```bash
npx haeram-spec-creator work scout --prompt-file <filled scout prompt> --provider claude --json
```

## 다른 실행기의 command 어댑터

다른 도구는 다음 JSON 파일을 `--adapter /absolute/path/adapter.json`으로 연결한다:

```json
{
  "command": "node",
  "args": ["/absolute/path/my-agent-adapter.mjs"],
  "timeoutMs": 3600000,
  "maxDispatches": 200,
  "maxTaskRuns": 3
}
```

command는 셸을 거치지 않고 실행한다. 상대 command 경로는 설정 파일 기준, args의 경로는 절대 경로 사용을 권장한다. 매 작업마다 지정 workspace에서 새 프로세스를 실행하며, 동일 세션 유지 여부는 어댑터가 결정한다. 모델과 reasoning 설정도 어댑터가 맡는다. 워커 4개는 동시 실행 슬롯 수이며 항상 같은 대화 세션 4개를 뜻하지 않는다.

stdin은 JSON 객체 한 줄이다:
- `schemaVersion:1`, `dispatchId`, `role:worker|reviewer`, `slot`, `group`, `attempt`, `taskId`(이번 태스크), `tasks`(단위 전체), `lane`, `workspace`, `groupBranch`.
- `instruction`: 실행 역할과 완료 절차. command 어댑터의 worker는 commit까지, reviewer는 결과 JSON 반환까지 수행한다. 기본 어댑터에서는 worker 커밋도 호스트가 담당한다. submit/review-finish는 runner 소유이므로 중복 호출하지 않는다.
- `verify`: 단위 통합 검증 명령 배열, `taskVerify`: 태스크 제출 때 호스트가 실행할 명령 배열(빈 배열 가능). `cliCommand`: 현재 패키지 CLI의 실행 파일과 절대 경로 인자 배열. 여기에 `boardCommand`를 이어 붙여 최신 상태를 조회한다.
- `correction`: 수정 요청을 재배정할 때 이전 리뷰와 findings; 없으면 null.
- `mode`: `autopilot`이면 아무도 질문에 답하지 않는다. `resume`: 이어 쓸 세션 ID(없으면 null), `sessionFile`: 새 세션 ID를 알게 되는 즉시 써 둘 파일. `directive`: 조정자 메모나 timeout 후 이어 가기 안내(`note`). `allowTools`: 워커가 묻지 않고 실행할 도구 규칙. `brief`: 태스크·결정 원문 블록(필수 의존·전역 규칙 포함)·flow·constraints·history·출처(경로·rev·sha256)·issues·검증 명령. `risk`: 리뷰어에게 넘기는 위험 이유.
- `review`: 리뷰 배정 시 id, submissionId, commit, baseCommit, workspace, owner. 없으면 null.

stdout은 최종 JSON 객체 하나만 출력하고 진행 로그는 stderr로 보낸다. 실행 도구의 JSONL/마크다운 출력은 어댑터에서 아래 형식으로 변환한다. raw CLI 출력을 그대로 연결해 이 규약을 만족한다고 가정하지 않는다.

```json
{"outcome":"completed","summary":"Implemented and committed the task."}
```

워커가 막히면 `{"outcome":"blocked","summary":"Reason and required decision."}`. 기획 결정만이 문제라면 `"decision":{"question":"...","options":["..."],"recommendation":"..."}`를 더한다 — 실행기는 진행분을 WIP 커밋으로 남기고 결정 요청으로 기록한 뒤 다른 단위를 계속한다(단위당 3회까지). 기본 어댑터의 결과 schema에는 decision이 항상 있고, 결정이 필요 없으면 빈 값이다. completed여도 runner가 실제 커밋·acceptance·spec 변경 범위와 검증 명령을 다시 검사한다.

리뷰어는 review-task의 JSON 형식(`verdict`, `summary`, `findings`)을 반환한다. 코드가 바뀌면 재제출이 필요하다. 상위 브랜치가 바뀌어도 바뀐 파일이 제출물의 변경·SSOT와 겹치지 않으면 승인이 유지되고, 겹치면 재리뷰한다. 합친 결과는 통합 검증이 다시 확인한다.

runner는 빈 슬롯을 채우고 수정 요청을 우선 배정하며 리뷰 대기열을 처리한다. 대기 중 모델 호출은 하지 않는다. 살아 있는 자식 프로세스의 heartbeat는 10초마다 기록하지만 에이전트의 의미 있는 진행을 보장하지는 않는다. 장시간 작업자는 board를 다시 읽고 정책 변경을 판단해야 한다.

완료 시 `outcome:completed`(`--group-verify`를 지정했다면 그 검증까지 통과해야 한다, 결과는 `finish`). 더 진행할 수 없으면 `needs-attention`과 남은 작업을 반환한다(`remaining`에 태스크와 attempt ID 포함). 횟수 한도는 `dispatch-limit`, 종료 신호/heartbeat 실패는 `interrupted`. maxTaskRuns는 한 번의 run 안에서 태스크별·역할별 최대 실행 횟수이며 재실행 전에 반복 실패 원인을 확인한다. 자동 통합 실패와 재시도 횟수는 attempt가 아니라 제출물(`submissionId`, 없으면 제출 commit)별로 기억한다. 같은 제출물의 비일시적 실패는 같은 run에서 다시 시도하지 않지만, 고쳐서 재제출·재승인하면 같은 attempt도 다시 통합한다. Claude·Codex와 command 어댑터 모두에 적용된다.

### 맡김(autopilot)

`work run --autopilot`은 사람이 없다는 전제로 돈다.
- 결정 요청만 남으면 조정자의 답을 기다린다(모델 호출 없음, 기본 15분=900000ms, 명시적인 `--decision-wait-ms` 우선, 지나면 `decision-wait`로 끝남). 대기를 시작하거나 대상이 바뀌면 attempt ID·태스크·질문·요청 시각·대기 시작·기한을 stderr와 runtime 이력에 남긴다. 함께 모드는 사용자가 결정하도록 대기 없이 반환한다.
- 승인됐지만 통합하지 못한 제출물이 남으면 결정 대기로 숨기지 않는다. 새 제출물은 다시 통합하고, 같은 제출물이 이미 실패해 더 진행할 수 없으면 즉시 `needs-attention`으로 끝내고 `remaining`에 그 attempt를 남긴다.
- 조정자의 `decide` 처리는 start-vibe [조정자 절차](../../start-vibe/references/coordinator.md) 3절을 따른다. 조정자는 단위·리뷰를 맡지 않는다.
- timeout이면 끊기 전에 작업 공간을 `refs/haeram/checkpoints/<attempt>`로 스냅샷하고(30분마다도, `--checkpoint-ms`) 진행분을 `WIP` 커밋으로 남긴 뒤, 같은 세션으로 한 번 더 이어 간다(태스크 실행 횟수 한도 안에서). `--push`가 있는 묶음은 스냅샷을 `wip/<attempt 8자>`로도 push한다.
- 계획 커밋이나 다른 통합이 검증 도중 상위 브랜치를 옮긴 통합은 제출물마다 최대 3회 시도한다. 재제출하면 이 횟수도 새로 센다.
- macOS에서는 실행기 수명 동안 `caffeinate -w`로 절전을 막는다(`HAERAM_NO_AWAKE=1`이면 끔).

### 진행 저장

runtime은 상태와 이력을 한 번의 원자적 교체로 저장한다. heartbeat는 이력을 늘리지 않는다. `work history --work feature --task T001 --json`은 태스크의 배정·도구·슬롯·실행·리뷰·재시도 변화를 보여준다. `work board`의 summary는 총량·완료·남은 일·실행·리뷰·blocked 수를 반환한다.

태스크가 통합될 때마다 STATE의 `## work` 요약과 `spec/work/feature.json`을 함께 저장하고, runner는 정상 완료·한도 도달·처리한 종료 신호 후 마지막 기록을 커밋한다. 상세 JSON에는 전체 이력, 워커별 도구/모델, 제출·리뷰·완료 commit 근거가 남는다. 명령 출력·PID·workspace 절대 경로·heartbeat는 문서에 내보내지 않는다. 저장 파일의 sourceCommit은 체크포인트를 만든 기준 커밋이며 파일 자신이 포함된 커밋의 SHA가 아니다. 통합 후보에는 적용 후 상태를 기록하므로 해당 태스크의 최종 integratedCommit과 통합 검사 시각은 다음 체크포인트에서 보충된다.

실시간 배정의 정본은 runtime이고 STATE는 체크포인트다. 수동 실행은 `work sync --work feature --json`으로 저장한다. sync 커밋은 STATE와 실행 기록만 바꾸므로 승인을 무효화하지 않는다. runner 실행 중 수동 sync는 거부한다. 미커밋 기획 변경이 있으면 원본을 보존하며 저장 실패를 반환한다. runner 결과의 snapshotError와 failures를 확인하고 원인을 해결한 뒤 sync한다. 강제 종료로 runner의 종료 처리가 실행되지 않았다면 기존 복구 절차로 runner·워커 종료를 확인한 뒤 sync한다. 중단된 sync 예약은 프로세스 종료 확인 후 `work recover --work feature`로 해제한다.

Git에 저장된 체크포인트는 다른 clone에도 남는다. runtime이 없는 새 clone의 `work history`는 저장된 JSON을 읽고 scope:snapshot을 반환한다. 실행 소유권을 복원하거나 과거 워커를 자동 재개하지 않는다. 기록이 이미 있는 묶음 이름은 새 clone에서도 start로 재사용할 수 없으며 새 이름으로 시작해 과거 이력을 보존한다.

## Orca 또는 다른 coordinator

가장 단순한 연결은 **세션 루프**다. 오케스트레이터는 저장소에서 에이전트 N개를 "implement-task로 남은 태스크를 구현해줘"로 띄우기만 한다. 각 에이전트는 `work next --owner <고유 label> --wait 540`을 반복하며 응답의 `action`(implement·review·blocked·wait·complete·stalled)과 `instruction`을 따른다. 배정·리뷰 배분·통합·묶음 검증은 CLI runtime이 결정하고, 통합과 finish는 백그라운드 CLI 프로세스가 실행한다(`<git-common-dir>/haeram/v1/logs/<묶음>.log`).

- 활성 묶음이 없으면 첫 에이전트의 `next --start`가 만든다. 같은 커밋에서 시작한 에이전트는 같은 묶음에 합류한다. 검증 단계 명령은 start/configure로 묶음에 저장해 둔다.
- 오케스트레이터는 `wait`·timeout으로 끝난 에이전트를 다시 띄우고, `complete`·`stalled`면 멈춘다. 에이전트마다 owner label을 다르게 하고, 다시 띄울 때 같은 label을 쓰면 진행 중이던 단위를 이어받는다.
- 리뷰는 자기 제출물이 아닌 에이전트가 맡는다. 에이전트가 하나뿐이면 `needs-reviewer`가 돌아오므로 리뷰용 에이전트를 하나 더 띄운다.

[Orca 공식 orchestration 문서](https://www.onorca.dev/docs/cli/orchestration)와 설치된 CLI의 `orca skills get orchestration --full`로 실제 버전의 명령을 확인한다. Orca pane/task/dispatch를 자동으로 생성·연결하는 전용 어댑터는 아직 포함하지 않는다.

`work doctor`는 PATH의 orca/orca-dev/orca-ide와 macOS 앱에 포함된 CLI를 검사한다. 앱만 설치해도 `/Applications/Orca.app/Contents/Resources/bin/orca`를 찾을 수 있고, 터미널에서 `orca`로 쓰려면 Settings → General → Orca CLI에서 등록한다([공식 안내](https://www.onorca.dev/docs/troubleshooting)). 다른 설치 경로는 `ORCA_CLI_COMMAND` 환경 변수로 실행 파일 경로를 지정한다. 앱 실행·PATH 수정·Orca 작업 생성은 doctor가 수행하지 않는다.

coordinator가 직접 역할을 나누려면 같은 CLI를 단계별로 호출한다: 빈 worker 슬롯은 `work next`, worker 완료는 `work submit`(lane 전체를 끝낸 뒤 한 번, 또는 태스크마다 — 남은 태스크가 있으면 다음 `taskId`를 같은 공간에서 계속), 빈 reviewer 슬롯은 `work review-claim`, 리뷰 완료는 `work review-finish`. approved 통합과 finish는 next가 백그라운드로 시작하거나 coordinator가 `work integrate`/`work finish`로 실행한다. 알림은 중복될 수 있으므로 runtime의 attempt/review 상태로 처리 여부를 확인하고, 재시작 후에도 runtime을 먼저 읽는다. Orca의 task/dispatch ID는 실행 추적용으로만 매핑하고 의존성 충족·선점·승인·통합을 두 시스템에서 따로 결정하지 않는다. 원격 실행기는 파일을 공유하지 않는 다른 clone을 같은 로컬 그룹에 연결할 수 없다.

## 중단과 복구

Ctrl-C/종료 신호는 runner가 시작한 자식 프로세스만 중단하고 파일·기록을 보존한다. 강제 종료 뒤에는 runner와 기록된 자식 PID가 모두 종료됐는지 확인하고 `work runner-recover --work <group>`를 실행한다. PID 기록 전 중단처럼 확인이 불가능한 경우 자동 회수하지 않는다.

진행 중 검증·통합 명령이 남았다면 `work recover --attempt <id>`, 남은 리뷰 선점은 리뷰어 종료 확인 후 `work review-release --review <id>`. 작업자의 미완료 변경은 검토하고 `work update --attempt <id> --status doing`으로 명시적으로 재개한다. runtime JSON을 직접 고치거나 timeout만으로 다른 작업자의 소유권을 빼앗지 않는다.

runner는 모든 자식을 멈춘 뒤 통합·해제된 단위만 정리한다(spec/SETTINGS.md `prune-branches`, 결과의 `pruned`). 합쳐지지 않은 커밋이나 미커밋 변경이 있는 공간, 막힌 단위, 묶음 브랜치는 실패 원인 조사와 최종 검토를 위해 남긴다. 설정이 false면 정리하지 않으며, 그때는 작업자 종료를 확인한 뒤 `work cleanup`으로 정리한다.
