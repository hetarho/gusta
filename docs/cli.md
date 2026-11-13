# CLI와 설치

[README](../README.ko.md) · [개발 흐름](workflow.md) · [브랜치·검증](branching.md) · [오래 맡기기](autopilot.md) · [병렬 작업](parallel-work.md) · [자가 개선](self-improve.md) · **CLI**

## 직접 설치하기

### 기본: npx (권장 — Node 프로젝트가 아니어도 됩니다)

이 패키지는 스킬을 프로젝트의 `.claude/`·`.codex/`로 복사하는 방식이라, 설치가 끝나면 패키지 자체는 프로젝트에 남을 필요가 없습니다. `package.json` 없이도(Python, Flutter, Go …) 동작하고 `node_modules`도 만들지 않습니다.

```bash
cd my-project
npx @haeram/gusta@latest install   # 최초 설치와 이후 업데이트 모두 이 명령
npx @haeram/gusta@latest check     # 동기화 확인
```

`@latest`가 실행 때마다 최신 버전을 확인하므로 업데이트도 같은 명령을 다시 실행하면 됩니다. 직접 수정하지 않은 스킬 파일만 새 버전으로 갱신되고, 수정한 파일은 충돌로 알려 줍니다.

### 옵션: 개발 의존성으로 버전 고정

CI에서 `lint`를 돌리거나 스킬셋 버전 변경을 PR 리뷰로 관리하고 싶은 Node 프로젝트라면 의존성으로 고정할 수 있습니다.

```bash
npm install --save-dev @haeram/gusta   # pnpm add --save-dev @haeram/gusta
npx @haeram/gusta install
```

기본 설치 대상은 현재 프로젝트의 Claude Code와 Codex입니다.

```text
<project>/
├── .claude/skills/<skill-name>/...
├── .codex/skills/<skill-name>/...
└── .gusta-lock.json
```

잠금 파일에는 이 패키지가 설치한 파일과 해시만 기록합니다. 다른 스킬 폴더는 건드리지 않으며, 프로젝트에서 직접 수정한 파일과 충돌하면 설치를 중단합니다.

## CLI 명령

```bash
# 포함된 스킬 확인
npx @haeram/gusta list

# Claude Code와 Codex 양쪽에 설치
npx @haeram/gusta install

# 한 에이전트에만 설치
npx @haeram/gusta install --agent claude
npx @haeram/gusta install --agent codex

# 다른 프로젝트를 대상으로 설치
npx @haeram/gusta install --target ../my-project

# 파일을 바꾸지 않고 설치 계획 확인
npx @haeram/gusta install --dry-run

# 설치본이 현재 패키지와 같은지 확인 (SETTINGS agent-block이 true면 CLAUDE.md·AGENTS.md의 gusta 블록도)
npx @haeram/gusta check

# CLAUDE.md·AGENTS.md의 gusta 안내 블록: 마커 사이만 적용(SETTINGS agent-block이 true일 때만) · 상태만 보기 · 제거
npx @haeram/gusta agent-block
npx @haeram/gusta agent-block --check --json
npx @haeram/gusta agent-block --remove

# spec/ 문서가 FORMAT 불변식을 지키는지 검사 (ID·상태 형식, rev/tasked 정합, 참조 무결성, chg 연속성, SSOT 골격 밖 섹션·산문)
npx @haeram/gusta lint
npx @haeram/gusta lint --target ../my-project

# 의미 품질 신호(검토 후보)까지 전부 보기 — 기본은 앞 10건만 출력하고 종료 코드에는 영향이 없습니다
npx @haeram/gusta lint --hints

# 현재 Git/worktree 환경 조회 (외부 도구 연동용 JSON도 지원)
npx @haeram/gusta context --json

# 현재 checkout의 태스크 파일에서 읽기 전용 보드 파생
npx @haeram/gusta board
npx @haeram/gusta board --target ../my-worktree --json

# 충돌한 로컬 파일을 패키지 버전으로 명시적으로 교체
npx @haeram/gusta install --force

# 세션 도구 (gusta-sketch·gusta-start·gusta-design-mode)
npx @haeram/gusta vibe status --tag k3f9        # 다른 세션·기기(브랜치·커밋·push 여부)·남은 일·추천 경로
npx @haeram/gusta vibe brief T012                # 태스크가 기대는 결정 블록·전역 규칙·flow·constraints·stale base 이후 chg
npx @haeram/gusta vibe sketch serve tag-filter  # gusta-sketch 시안(.tmp/sketch/tag-filter/)을 127.0.0.1 포트 하나로 — 살아 있으면 재사용, 기본 8시간 뒤 종료
npx @haeram/gusta vibe sketch status            # 기록된 스케치 서버와 alive
npx @haeram/gusta vibe sketch stop tag-filter   # 스케치 서버 정지·기록 삭제 (--all은 전부)
npx @haeram/gusta vibe plan-sync                # 기획 브랜치(SETTINGS plan, 미정이면 land)의 최신을 합침 — 기획·채번 전
npx @haeram/gusta vibe plan-push                # spec/만 담은 기획 커밋을 기획 브랜치에 올림 (태스크 ID 충돌이면 거절)
npx @haeram/gusta vibe push                     # 끝난 작업을 SETTINGS land로 반영(push면 원격을 합친 뒤 push, 아니면 로컬 병합, pr이면 PR)
npx @haeram/gusta vibe deploy                   # '배포해줘': deploy 브랜치를 land로 fast-forward
                                                # 둘 다 결과에 version을 싣는다: SETTINGS version이 auto면 운영 브랜치가 전진할 때 올린 {from,to,level}, 아니면 {skipped: 이유}
npx @haeram/gusta vibe beat --tag k3f9 --mode autopilot  # 조정 브랜치에 이 세션 행 쓰기·갱신 (--doing T012|-, --end로 삭제) — 커밋할 것 없음
npx @haeram/gusta vibe task start T012 --tag k3f9  # 단독 선점: 조정 브랜치에서 먼저 잡고 태스크·STATE 행을 doing으로 (todo·dep 완료만, 남이 잡았으면 거절)
npx @haeram/gusta vibe task done T012 --tag k3f9   # done@날짜·tasks/done 이동·STATE 행·next, 조정 브랜치에 log·unlanded (미체크·빈 result면 거절, 커밋은 호출자)
npx @haeram/gusta vibe claim --tag a1b2 --task T001 # 조정 브랜치에서 선점만 (push 대상·깨끗한 트리 불필요). 거절이면 exit 1과 claim.owner·reason(claimed|unlanded)
npx @haeram/gusta vibe inbox add --kind decided --ref T012 --text '<question> → <choice> (alt: <a>)'  # 결정함 한 줄 (날짜는 CLI, 따옴표·|가 섞이면 --file <path>)
npx @haeram/gusta vibe inbox list --kind parked     # 결정함 보기 (--ref로 좁힘) — 줄마다 id
npx @haeram/gusta vibe inbox resolve --id <id> --log 'confirmed T012'  # owner가 확인한 줄 삭제 + log 한 줄 (--line·--file도)
npx @haeram/gusta vibe log --text 'fix settings: typo'  # 활동 기록 한 줄 (최신 20줄 유지, 본문 없으면 목록)
npx @haeram/gusta vibe checkpoint --tag k3f9    # 작업 트리 스냅샷을 wip/k3f9로 (현재 브랜치는 그대로)
npx @haeram/gusta vibe checkpoint --tag k3f9 --handoff --next 'continue pending verification' --json
npx @haeram/gusta vibe design start --tag d7 --scope "landing hero"  # 이 checkout만 디자인 중으로 (STATE·다른 worktree는 그대로)
npx @haeram/gusta vibe design verify            # 디자인 마감: ARCH task·batch 명령 전부를 미커밋 트리에서
npx @haeram/gusta vibe design end               # 디자인 중 표시 해제 — 이어서 커밋 하나
npx @haeram/gusta vibe check --tier task -- pnpm exec vitest related --run src/a.ts   # 태스크 커밋 직전 한 번: 명령별 시간을 timings.json에 남긴다
npx @haeram/gusta vibe check --tier batch --tag k3f9 -- pnpm run test:e2e   # 같은 트리에서 통과한 검사는 생략, 무거운 검사는 하나씩, 세션마다 실패 3회 상한
npx @haeram/gusta vibe check --reset-gate --tag k3f9   # 사람이 그 세션의 관문 실패 기록을 지워 상한을 푼다 (맡김은 쓰지 않음)
npx @haeram/gusta vibe preflight --probe-workspace current --probe 'pnpm run test' --allow-tool 'Bash(pnpm run *)'
```

batch/group 관문(`vibe check --tier batch|group`)은 세션마다(`--tag`, 없으면 현재 브랜치) 실패한 라운드를 runtime `gates.json`에 셉니다. 한 트리에서 돈 명령들은 한 라운드이고, 같은 명령을 다시 돌리거나 트리가 바뀌면 새 라운드입니다. 캐시 적중은 세지 않고 성공해도 초기화하지 않으며, 12시간 동안 관문이 없으면 새로 셉니다. 결과의 `gate`는 `{key, attempts, failures, cap, left}`이고, 실패하면 `next`에 실패한 명령·로그, 고친 부분만 `--tier task --diff-base <관문 커밋>`으로 먼저 확인하라는 안내, 남은 시도가 실립니다. 실패 3회에 닿으면 다음 관문은 명령을 돌리지 않고 exit 1과 `{refused: 'gate-cap', attempts, failures, cap, lastFailure, next}`로 거절합니다 — 남은 실패를 보고서와 `vibe inbox add --kind parked`로 남기고 멈추라는 뜻입니다. `vibe loop`의 관문은 같은 기록에 남지만 자기 상한(`--max-gate-attempts`)으로 판정하고, `vibe design verify`는 세지 않습니다. 상한은 사람만 `--reset-gate`로 풉니다.

원격에서 이어갈 현재 상태만 요청하면 `checkpoint --handoff`를 씁니다. 최종 검증·병합·수정 없이 WIP 브랜치를 원격에 보존하고, 최종 반영용 SETTINGS push가 꺼져 있어도 인계 push를 시도합니다. 결과의 원격 브랜치·커밋·`verification.status: unverified`·다음 작업을 함께 전달합니다.

세션 기록(`beat`·`claim`·`inbox`·`log`와 `task`의 선점·완료)은 `spec/STATE.md`가 아니라 [조정 브랜치](branching.md#조정-브랜치)(SETTINGS `coord`, 기본 `gusta`)의 `SESSIONS.md`에 쓰입니다. 이 기록은 커밋할 것이 없고(`task`가 고친 태스크 파일·STATE의 커밋만 호출자 몫), 원격이 있으면 CLI가 그 브랜치만 올립니다(SETTINGS `coord-push`, 기본 true — 실패해도 작업을 막지 않고 결과에 `unpublished`). 작업 묶음의 워커·리뷰어 checkout에서는 거절합니다. `vibe status`는 조정 브랜치를 원격과 맞춘 뒤 다음을 함께 돌려줍니다.

| 키 | 뜻 |
|---|---|
| `others[]` | 다른 세션의 행 — `branch`·`commit`과 `pushed`(그 커밋이 원격에 있는지, `false`면 아직 push 안 됨)·`stale` |
| `unlanded[]` | 끝났지만 아직 land에 들어가지 않은 태스크와 그것을 가진 브랜치·커밋 |
| `held[]` | `runnable`에서 뺀 태스크와 이유 — `claimed`(다른 세션이 진행 중)·`unlanded`·`landed`(land에는 이미 끝나 있음: 먼저 sync) |
| `taskChecks` | 이 clone의 태스크 단계 검사(`vibe check --tier task`, 명령마다 최근 10회 실측·캐시 적중 제외) — `runs`·`ms` 합계와 `slow`(평균 60초 초과·2회 이상인 `{command, runs, avgMs}`: 최종 관문으로 옮길 후보, 정하는 것은 사람). ARCH batch에만 있는 명령은 빠지고, 기록이 없으면 키가 없다 |
| `coordination` | `legacy`(이관 전 STATE에 남은 옛 섹션)·`lost`(다른 기기가 먼저 올려 풀린 선점)·`contested`·`push`(원격 반영 상태, 원격 실패 뒤 쉬는 중이면 `backoff`의 이유·다시 시도할 시각)·`error`(조정 브랜치를 쓸 수 없는 이유) |

`--force`는 로컬 수정 내용을 덮어쓸 수 있으므로 충돌 내용을 확인한 뒤 사용하세요.

그 밖의 명령은 주제별 문서에 있습니다: `vibe loop`·`vibe brief`는 [오래 맡기기](autopilot.md), `vibe check`·`vibe push`·`vibe ci wait`는 [브랜치·검증](branching.md), `vibe sketch`는 [개발 흐름의 gusta-sketch](workflow.md#구상하기--gusta-sketch), `vibe ab`는 [개발 흐름의 gusta-showcase](workflow.md#여러-안을-띄워-고르기--gusta-showcase), `work`는 [병렬 작업](parallel-work.md). 전체 옵션은 `npx @haeram/gusta vibe --help`·`npx @haeram/gusta work --help`로 봅니다.

## 기존 프로젝트 이관

`/gusta-update`는 새 버전 확인 → 프로젝트 규칙 조사 → 설치·구조 이관 → 문서·설정·실제 실행 대조 → lint → 커밋을 수행합니다. 최신 버전이어도 조사를 생략하지 않습니다. 실제 정책 차이는 프레임워크 기본 절차에 맞추는 안과 원문·범위·영향을 보여 주고 괜찮은지 확인한 뒤 반영합니다.

`npx @haeram/gusta@latest upgrade-context --limit 1`은 항상 JSON으로 문서·지침·구현 후보 목록과 설정 출처를 돌려줍니다. 정책 일치 판정이나 본문 읽기를 대신하지 않습니다. 첫 결과의 snapshot·total로 `upgrade-context --snapshot <snapshot> --limit <total>`을 실행해 전체 JSON을 대상 프로젝트 밖 임시 파일에 저장하고, 네이티브 도구로 나눠 읽으면 큰 트리의 반복 스캔을 줄일 수 있습니다(total이 0이면 limit 1). 목록의 complete는 정책 검토 완료가 아닙니다. 실제 원문·참조·적용 범위와 소유권은 [프로젝트 규칙 대조](../skills/gusta-update/references/project-rules.md)대로 확인합니다. 직접 이관할 때는:

1. `npx @haeram/gusta@latest outdated`로 설치 버전·최신 버전·그 사이 변경(`changes`)을 봅니다. 그다음 `npx @haeram/gusta@latest install --dry-run` → `install` → `check`. 설치는 `.claude/skills`·`.codex/skills`만 바꾸고, 로컬에서 고친 스킬 파일은 충돌로 보고하며 `--force` 없이 덮어쓰지 않습니다. `spec/`은 건드리지 않습니다. SETTINGS `agent-block`이 true인 프로젝트는 `install` 뒤 `agent-block`으로 지침 파일의 gusta 블록도 갱신해야 `check`가 통과합니다.
2. `lint`로 기존 문서를 검사합니다. 새 검사는 기존 문서를 오류로 만들지 않고 경고·검토 후보로 알립니다.
3. `npx @haeram/gusta@latest migrate --dry-run` → `migrate`로 구조 변경을 이관합니다(예: STATE cfg push·plan → `spec/SETTINGS.md`, STATE의 `active`·`inbox`·`log` → 조정 브랜치의 `SESSIONS.md` — 결과 `sessions`에 옮긴 섹션과 커밋). 여러 번, 여러 checkout에서 실행해도 결과가 같습니다 — 조정 브랜치 히스토리에 한 번이라도 있던 inbox·log 줄은 다시 옮기지 않고(그 뒤 해소된 줄이 되살아나지 않게), 조정 브랜치가 이미 있으면 옛 active 행은 버립니다(세션이 다시 등록합니다. 결과 `sessions.dropped`). `coord` 이름(기본 `gusta`)의 코드 브랜치가 이미 있으면 거절하므로 `vibe settings --set coord=<다른 이름>` 뒤 다시 실행합니다. 옛 버전 CLI와 새 버전은 서로의 선점을 보지 못하니 한 프로젝트의 모든 기기를 함께 올립니다. 의미 판단이 필요한 `spec/FORMAT.md`는 자동으로 덮어쓰지 않습니다. 결과의 `format.missing`(새 패키지 줄)과 `format.extra`(프로젝트에만 있는 줄)를 보고, 새 줄은 옮기고 프로젝트가 고친 규칙은 남깁니다. `unset`이 있으면 `/gusta-init`으로 정합니다. FORMAT에 옮기기 전까지 스킬은 프로젝트 FORMAT에 없는 표기(예: `→!`·`→=`·`→~`)를 쓰지 않습니다.
4. 버전별 이관 항목은 [CHANGELOG](../CHANGELOG.md)에 있습니다.
