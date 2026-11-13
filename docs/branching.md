# 브랜치 전략과 검증

[README](../README.ko.md) · [개발 흐름](workflow.md) · **브랜치·검증** · [오래 맡기기](autopilot.md) · [병렬 작업](parallel-work.md) · [자가 개선](self-improve.md) · [CLI](cli.md)

## 브랜치 전략

끝난 작업이 어디로 가는지는 스킬에 고정돼 있지 않고 `spec/SETTINGS.md`가 정합니다. 정해지지 않았으면(`land: ?`) 어느 스킬을 부르든 먼저 `/gusta-init`이 묻습니다. `/gusta-start`가 맡긴 실행은 묻지 않고 현재 브랜치에 커밋만 한 뒤 결정함에 남깁니다. 설정은 `/gusta-preference`로 보고 바꿉니다.

| 키 | 값 | 뜻 |
|---|---|---|
| `land` | `?` · `current` · 브랜치 | gusta-start 세션·자가 개선(gusta-self-improve·gusta-self-improve-remote)·작업 묶음이 끝나면 병합될 브랜치 |
| `land-via` | `merge`(기본) · `pr` | land에 직접 병합하거나, 작업 브랜치를 올려 PR |
| `push` | `false`(기본) · `true` | land를 원격에도 올릴지 (push마다 원격 CI) |
| `deploy` | `-`(기본) · 브랜치 | "배포해줘"(`vibe deploy`)가 land로 fast-forward할 브랜치 |
| `plan` | `?` · `-` · 브랜치 | 태스크 번호·SSOT rev를 매기는 기획 브랜치 (미정이면 land) |
| `version` | `?` · `off` · `auto` | 운영 브랜치가 전진할 때 CLI가 버전을 올릴지 ([자동 버전](#자동-버전)) |

`/gusta-init`은 **개발(통합) 브랜치를 운영하는지** 하나를 묻습니다. 기본 브랜치 이름은 실제 브랜치와 `origin/HEAD`에서 읽으며(아래 `main`·`develop`은 예), 통합 브랜치로 쓸 브랜치가 없으면 `develop`을 새로 만드는 안을 추천합니다.

```text
아니오               land: main     · deploy: -      끝난 작업이 기본 브랜치에 바로 반영
예                   land: develop  · deploy: main   develop에 모았다가 "배포해줘" → main을 develop으로 fast-forward
그 밖: PR            land: main     · land-via: pr
그 밖: 커밋만         land: current
```

구현은 항상 보호된 land·deploy·plan·기본 브랜치 밖의 하위 브랜치에서 합니다. `/gusta-start`와 두 self-improve 경로는 `vibe session open`이 만든 전용 linked worktree/세션 브랜치를 쓰며, 원래 checkout과 사용자 변경은 그대로 둡니다. 결과를 ready로 제출한 뒤 공유 통합 묶음의 한 소유자가 고정 후보를 검수하고 SETTINGS대로 반영합니다. 밖에서 land가 바뀌면 자동 병합·전체 검수 초기화 대신 보류·재조정합니다. PR 전략이면 검증된 후보 브랜치로 PR을 엽니다. `vibe deploy`는 deploy 브랜치를 land의 검증된 커밋으로 fast-forward만 하고, deploy에 land에 없는 커밋(핫픽스 등)이 있으면 거절합니다. 그 커밋을 land에 합쳐 검증한 뒤 다시 배포합니다.

기획 문서는 예외입니다. `plan` 브랜치에서 `vibe plan-sync`로 최신을 합친 뒤 기획하고, spec/만 담은 기획 커밋을 `vibe plan-push`로 그 브랜치에 바로 올립니다(태스크 ID 충돌이면 거절). 명령 목록은 [CLI](cli.md#cli-명령)에 있습니다.

### 자동 버전

`version: auto`면 CLI가 **운영 브랜치**(`deploy`가 정해져 있으면 그 브랜치, 아니면 `land`)를 전진시킬 때마다 버전을 올립니다. `/gusta-init`이 한 번 묻고, 미정(`?`)과 `off`는 버전을 건드리지 않습니다. 버전이 바뀌면 배포하는 CI가 있는 프로젝트에서는 반영이 곧 릴리스입니다.

- **언제**: `deploy`가 없으면 `vibe push`가 land를 전진시킬 때(원격 push·로컬 병합 모두), 있으면 `vibe deploy` 때입니다. 검증을 통과한 커밋 위에 `chore: bump version to X.Y.Z` 커밋 하나를 얹습니다. deploy에서는 그 커밋을 land에 먼저 올린 뒤(push가 켜져 있으면 원격 land에 push) deploy를 fast-forward합니다 — land에 없는 커밋이 deploy에 생기면 다른 기기의 배포가 거절되기 때문입니다. 공동 통합의 기준 land가 바뀌면 보류해 후보를 재조정하고 필요한 영향 검사만 갱신합니다. 버전 계산 때문에 전체 검수를 자동 반복하지 않으며, 실패한 반영에 버전 커밋을 남기지 않습니다.
- **얼마나**: 모델이 아니라 Git만 보고 정합니다 — 동시에 도는 세션이 같은 답을 내고, push 시점에 모델을 부르지 않습니다. 반영할 범위에서 사람이 버전을 바꿨으면 그대로 둡니다(major는 이렇게 사람만 올립니다). 현재 버전이 정해진 뒤 `spec/ssot/`에 새로 확정된(`[o]`) 결정 ID가 있으면 minor, 아니면 patch입니다(그때 없었거나 `[?]`였던 결정이 `[o]`가 된 경우 — 열린 `[?]`·기각 `[x]`는 세지 않습니다). STATE·태스크·보고서만 바뀐 반영은 릴리스로 치지 않습니다.
- **무엇을**: 저장소 루트 `package.json`의 `version`과, 추적 중이면 `package-lock.json`의 같은 값만 고칩니다. 그 값 말고는 한 바이트도 바꾸지 않고 git 태그도 만들지 않습니다. `X.Y.Z`가 아닌 버전(프리릴리스 등)은 올리지 않습니다.
- **올리지 않는 경우**: `land-via: pr`(병합 시점을 CLI가 쥐지 않음), deploy 없이 land가 `current`·미정, 지원하는 매니페스트 없음. CLI가 land를 옮기지 않는 반영(land에서 직접 작업하며 push가 꺼진 경우, 작업 묶음 `--push`의 단위별 push)에서도 오르지 않습니다. `vibe push`·`vibe deploy` 결과의 `version`이 올린 내용(`from`·`to`·`level`)이나 건너뛴 이유(`skipped`)를 알려 줍니다.

## 조정 브랜치

누가 어디서 무엇을 하고 있는지는 코드 브랜치의 `spec/STATE.md`가 아니라 **조정 전용 브랜치**의 `SESSIONS.md` 한 파일에 있습니다. `/gusta-init`은 이 설정을 묻지 않고 기본값을 씁니다.

| 키 | 값 | 뜻 |
|---|---|---|
| `coord` | 브랜치 이름 (기본 `gusta`) | 조정 브랜치 — 코드 브랜치로 쓰지 않습니다 |
| `coord-push` | `true`(기본) · `false` | 사건마다 조정 브랜치를 원격에 올릴지 (`false`면 이 clone 안에서만) |

- **무엇이 올라가나**: 실행 중 세션과 그 선점(`active` — tag·기기·모드·시작/최근 시각·하는 태스크·브랜치·커밋·선택적 session 참가 ID), 결정함(`inbox`), 끝났지만 아직 land에 들어가지 않은 태스크(`unlanded` — 다른 세션이 다시 집지 않습니다), 활동 기록(`log`, 최신 20줄). 코드와 spec 문서는 실리지 않습니다. STATE에는 cfg·SSOT 현황·태스크 보드·next가 남습니다.
- **왜 작업 브랜치에 병합하지 않나**: 세션 기록이 코드 브랜치에 있으면 push해야 다른 기기에 보이고(push마다 코드 CI), 다른 worktree는 병합 전까지 보지 못해 같은 태스크를 둘이 잡으며, 병합·rebase 때마다 서로의 줄이 충돌합니다. 조정 브랜치는 코드와 히스토리를 공유하지 않는 orphan 브랜치라 checkout·병합·rebase하지 않고, CLI만 Git plumbing으로 읽고 씁니다(HEAD·index·작업 트리는 그대로). 같은 clone의 worktree는 같은 ref를 보므로 선점이 즉시 보이고 둘 중 하나만 성공합니다. 스킬도 이 파일을 직접 고치지 않고 `vibe beat`·`claim`·`task`·`inbox`·`log`로만 기록합니다.
- **push 시점**: 원격이 있고 `coord-push`가 켜져 있으면 사건마다 — 선점·해제, 결정함 추가·해소, 태스크 완료, land 반영, 체크포인트, 세션 시작·끝 — CLI가 원격과 합친 뒤 이 브랜치만 올립니다. SETTINGS `push`와 무관하고 모델 턴을 쓰지 않습니다. 그래서 다른 기기에서 "저 브랜치에서 진행 중인데 아직 push 안 됨"이 보입니다(`vibe status`의 `others[].pushed`). log 한 줄은 다음 사건과 함께 올라가고, 시각만 바뀐 생존 신호는 행이 30분 넘게 묵었을 때만 올립니다(`vibe loop` 호스트는 단위가 조용해도 30분마다 올려 다른 기기가 오래된 세션으로 보지 않게 합니다). push가 실패해도 작업을 막지 않습니다 — 로컬 기록은 유지되고(`unpublished`) 다음 사건에 다시 올립니다. 인증·시간 초과·네트워크 실패 뒤 10분은 원격을 부르지 않습니다(backoff: 사건마다 시간 초과를 기다리지 않게. `vibe status`의 `coordination.push.backoff`와 preflight `coord-push`에 이유와 다시 시도할 시각). 오래된 선점을 가져가면 그 세션 행을 남기고 log에 `released stale <tag> from T###`을 적습니다. 같은 태스크를 두 기기가 잡으면 먼저 올린 쪽이 이기고 진 쪽은 선점이 풀립니다(`lost`).
- **빈 원격**: 원격에 브랜치가 하나도 없으면 올리지 않습니다 — 처음 올라간 브랜치가 호스팅의 기본 브랜치가 되기 때문입니다. 코드 브랜치가 올라간 뒤부터 올립니다.
- **원격 CI·미리보기 배포**: 코드가 없는 브랜치지만, 모든 브랜치의 push에 반응하는 CI·브랜치별 미리보기 배포·웹훅이 있으면 사건마다 돌 수 있습니다. 이 브랜치를 거르는 필터(워크플로의 브랜치 조건, 배포 서비스의 무시 규칙 등)는 대상 프로젝트 몫입니다.
- **이름 충돌**: 같은 이름의 브랜치가 이미 코드를 담고 있으면 CLI는 읽지도 덮어쓰지도 않고 거절합니다(land·deploy·plan과 같은 이름도). `gusta/feature`처럼 그 이름 아래 브랜치가 있어 ref를 만들 수 없을 때도 재시도 없이 같은 해법을 알리고, 맡김 preflight의 `coord-push`는 쓸 수 있는지(ref 이름·checkout 여부·Git 사용자 정보)를 미리 봅니다. `/gusta-preference`로 `coord`를 다른 이름으로 바꿉니다. SETTINGS는 브랜치마다 따로 있으므로 모든 브랜치·기기에서 같은 이름이어야 하고, 이 clone이 처음 쓴 이름과 다른 checkout에서는 추측하지 않고 멈춥니다.
- **기존 프로젝트**: `gusta migrate`(`/gusta-update`)가 STATE의 `active`·`inbox`·`log`를 조정 브랜치로 옮깁니다. 이관 전에는 읽기가 옛 섹션을 합쳐 보여 주고(`vibe status`의 `coordination.legacy`) 쓰기는 조정 브랜치에만 합니다. Git이 없는 대상만 STATE 섹션을 그대로 씁니다.
- **혼합 버전 주의**: 한 프로젝트의 모든 기기·worktree를 함께 올리세요. active의 선택적 아홉째 session은 안정된 참가 ID이며, 옛 여섯/여덟 칸 행도 읽지만 ID가 없으면 공동 마감을 막습니다. tag·host·브랜치·커밋이 같거나 doing이 비었다고 ready로 추정하지 않습니다. 원격 불명·미발행·stale도 완료/소유권 탈취의 근거가 아닙니다.

## 검증과 push

- **태스크마다**: 변경 영향 단위 테스트와 1분 안에 끝나는 빠른 검사만, 커밋 직전에 한 번 돌립니다(같은 트리는 캐시). 테스트는 스크립트 이름이 아니라 격리 범위·의존성으로 분류하고, 실행하지 않은 통합/e2e는 result limits에 남겨 마감 관문에 넘깁니다. `vibe check --tier task`는 ARCH batch 단계에만 있는 명령(전체 스위트)을 거절하고, 5분 넘는 태스크 검사에는 `slow`·`hint`를 붙입니다(사용자가 별도 실행을 명시하면 `--allow-final`). 명령별 시간은 runtime `timings.json`에 남아, 평균 60초가 넘는 명령은 `vibe status`의 `taskChecks.slow`와 loop 보고서에 나오고 loop가 끝날 때 batch로 옮기자는 inbox `suggest`가 한 번 남습니다 — 옮길지는 사람이 정합니다.
- **마감 관문**: 등록된 참여 세션이 모두 ready이면 한 소유자가 참여자·제출 SHA·land 기준·격리 후보를 고정해 전체 결정론적 검수를 한 번 합니다. 새 세션은 다음 묶음으로 갑니다. 실패 뒤에는 실패·영향·미실행을 확인하고 유효한 성공은 재사용합니다. clone 락은 원격 공유 소유권의 대체물이 아니며, 원격을 확인할 수 없으면 조용히 로컬 마감으로 바꾸지 않습니다. 기존 누적 실패·마감·회복 상한은 유지합니다.
- **반영**: 공유 소유자가 검증된 고정 후보만 SETTINGS대로 반영합니다. 필수 integration-stage agent AC가 남으면 waiting-agent로 후보·기존 검수 증거를 보존하고, 도구가 있는 host가 실제 관찰을 기록한 뒤 전체 검수를 반복하지 않고 재개합니다. 같은 후보의 CI는 한 번 기다리고, 조회할 수 없으면 unchecked와 확인할 SHA/URL을 남깁니다. 세션 종료가 각자의 전체 검사·push를 뜻하지 않습니다.
- 단계는 ARCH의 task/batch/CI와 실제 의존성으로 정합니다. task는 작은 영향 검사, batch는 공동 고정 후보의 전체 결정론적 검수, 최소 자동 브라우저 E2E·선언한 지원 호환 검사는 CI입니다. computer-use agent AC로 대체한 자동 범위를 제거·축소하고, worker가 적은 중복 이유로 두 방법을 함께 실행하지 않습니다. `/gusta-update`는 실제 테스트·스크립트·설정·시간과 중복 비용을 필수 감사합니다. 세부 절차는 [공유 검증 계약](../skills/gusta-start/references/verification.md)에 있습니다.

```bash
npx @haeram/gusta vibe check --tier task --diff-base <task-start-sha> -- pnpm run typecheck
npx @haeram/gusta vibe integration ready --tag <tag>
npx @haeram/gusta vibe integration finish --tag <tag>
```
