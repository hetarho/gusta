# 오래 맡기기

[README](../README.ko.md) · [개발 흐름](workflow.md) · [브랜치·검증](branching.md) · **오래 맡기기** · [병렬 작업](parallel-work.md) · [자가 개선](self-improve.md) · [CLI](cli.md)

맡김 모드의 결정·주차 규칙은 [개발 흐름의 모드 표](workflow.md#gusta-start로-시작하기)를, 검증·반영 규칙은 [검증과 push](branching.md#검증과-push)를 따릅니다.

## 오래 맡기기 — `vibe loop`

```bash
npx @haeram/gusta vibe loop --tag k3f9 --provider claude --dry-run --json
npx @haeram/gusta vibe loop --tag k3f9 --provider codex --max-units 30 --max-hours 8 --json
# 이 태스크(와 이번 실행이 그것을 위해 만든 태스크)만
npx @haeram/gusta vibe loop --tag k3f9 --provider claude --tasks 'T012 T013 T014' --json
# 실행 중 변경: 현재 단위를 끝낸 같은 호스트가 적용합니다. pending은 적용 완료가 아닙니다.
npx @haeram/gusta vibe loop --tag k3f9 --configure --push-each-unit --wait-ms 30000 --json
npx @haeram/gusta vibe loop --tag k3f9 --status --json
# 현재 단위와 마감 검증을 끝낸 뒤 정지
npx @haeram/gusta vibe loop --tag k3f9 --stop-after-unit --json
# 즉시 취소(실행 중 단위도 종료, 새 마감 검증·push 없음)
npx @haeram/gusta vibe loop --tag k3f9 --stop --json
```

반복기는 preflight·active·보고서를 한 번 준비한 뒤 태스크 하나, 기획 한 조각(SSOT+gusta-create-task), inbox 정리마다 새 세션을 시작합니다. 시간 한도의 마지막 구간은 **마감 관문 전용**입니다 — 그 구간에 들어서면 새 단위를 시작하지 않고(`reason: final-window`, 단위의 상한도 이 구간 시작까지라 실행 중이던 단위가 구간을 먹지 않습니다) 모은 코드 전체를 한 번 검증한 뒤 push·CI까지 진행합니다. 관문이 실패하면 근거를 담은 수정 태스크를 만들어 그 구간 안에서 고치고 다시 검증합니다. 누적 실패 관문 상한은 기본 3회(`--max-gate-attempts`, 2~5)이며 성공해도 실패 횟수를 초기화하지 않습니다. 두 번째 실패 뒤에는 같은 전체 명령 계획을 끝까지 관찰한 실패 명령 집합이 엄격히 줄어든 경우에만 추가 회복합니다. 명시적으로 완전성을 보증한 검사 어댑터는 테스트 ID를 비교할 수 있지만 일반 로그의 실패 개수는 진단 자료입니다. 새 실패·불명확한 결과·시간 부족이면 자동 회복을 끝내고 전체 시도·누적 실패/상한·남은 수정 태스크·push 여부를 반환합니다. 구간 길이는 실측입니다: `vibe check --tier batch`·`work finish`·`vibe design verify`가 기록한 전체 검증 시간×2 + 최근 단위 시간 + (push 브랜치가 있으면) CI 대기 시간. 아직 한 번도 측정되지 않았을 때만 max-hours의 20%를 쓰고, 측정은 단위 경계마다 다시 읽습니다. `--final-reserve-hours`로 직접 정할 수 있습니다.

### 단위 상한과 이어가기

**단위 상한은 멈춘 세션을 끊는 장치이지 실행의 끝이 아닙니다.** 단위 하나는 `--timeout-ms`(기본 1시간)까지, explore 태스크는 timebox+30분까지 돕니다(남은 작업 시간에 timebox가 들어가지 않으면 그 태스크는 건너뛰고, 그것만 남으면 `explore-no-time`으로 마감합니다). 상한이나 출력 한도로 끊긴 단위, 실패한 단위가 남긴 미커밋 변경은 로컬 ref(`refs/gusta/units/<tag>/…`, push 안 함)에 스냅샷한 뒤 그 경로만 HEAD로 되돌리고, 새 세션이 그 스냅샷에서 이어갑니다. 같은 태스크가 다시 끊기면 한 단위에 맞게 쪼개는 기획 단위를 돌리고, 쪼갠 뒤에도 끊기면 inbox에 parked로 남기고 다른 태스크로 넘어갑니다. 변경 없이 끊긴 단위만 실패로 세며(2회 연속이면 `session-failures`로 정지), 실패로 멈춰도 앞 단위들이 커밋한 코드는 마감 관문을 거쳐 push됩니다. 이어받은 태스크가 끝나면 스냅샷 ref를 지우고, 남은 ref는 보고서 next에 적습니다.

**태스크 완료는 단위의 보고가 아니라 spec 마감으로 셉니다** — `tasks/done/`에 `done@날짜`로 옮겨지고 STATE 행이 사라졌으며 새 lint 오류가 없어야 합니다. 어기면(손으로 닫은 태스크 포함) 고치는 단위를 한 번 주고 다시 어기면 parked로 넘기며, spec lint 오류나 미해결 마감 거절이 있으면 최종 반영하지 않고 마감은 실패로 끝납니다. 명시적 WIP 원격 인계는 가능하며, 시작 대화는 수리·주차 근거를 받아 후속 처리합니다.

`--tasks 'T### …'`는 그 태스크만 합니다. 범위 밖 선행 태스크가 끝나지 않았으면 시작하지 않고, 이번 실행이 범위 태스크를 위해 만든 태스크(쪼갠 후속·선행·관문 수정)는 범위에 들어갑니다. 범위가 끝나면 `scope-done`으로 마감 관문을 돌고 멈춥니다. STATE next 줄의 형식이나 갱신에 기대지 않습니다.

### 시간과 캐시

어디서 시간이 갔는지도 남깁니다. 단위마다 걸린 시간·그 안의 `vibe check` 시간·토큰 수를 기록하고, `loop.json`·결과 JSON의 `time`과 마감 보고서 checks의 한 줄(`- time: 5h00m — implementation 2h30m/2 (model 2h00m, task checks 30m), planning 40m/1, gate 30m, CI 6m, host 9m; slowest T### 1h30m`)로 구현·기획·태스크 검사·마감 관문·CI·호스트 몫을 나눠 보여 줍니다. 다음 속도 개선은 이 숫자에서 고릅니다(`vibe check`를 거치지 않은 명령은 모델 시간에 포함됩니다).

단위마다 새 세션이어도 프롬프트 캐시를 버리지 않습니다. 시스템 프롬프트·도구 정의처럼 세션끼리 같은 앞부분은 새 세션의 첫 요청에서도 캐시에서 읽힙니다(실측: 새 헤드리스 세션 첫 요청에서 약 18K 토큰 캐시 읽기). 새로 쓰는 것은 단위마다 다른 스킬 본문·브리핑·태스크뿐입니다. 반대로 한 대화를 오래 이어 쓰면 매 턴 쌓인 맥락 전체를 다시 읽고, 캐시가 만료(Claude Code는 1시간)된 뒤에는 그 전체를 2배 값으로 다시 씁니다. 시작한 대화는 오케스트레이터로 남아 실행기의 종료 영수증을 받고, 사용자 목표가 남았으면 새 하위 단위/일반 스킬로 이어갑니다. 실행기의 자동 회복 상한은 사용자 작업의 완료가 아닙니다. 이전 시도 이력과 사용자의 원래 마감·전체 예산·검증·권한을 유지하고, 같은 실행기를 새 예산으로 무작정 재시작하지 않습니다. CLI 결함은 보고서에 남겨 나중에 패키지에서 고칩니다. 작업이 끝난 뒤 사용자가 돌아올 때는 새 대화에서 `/gusta-start`로 시작할 수 있습니다 — 필요한 상태는 보고서·결정함·`loop.json`에 있습니다. 캐시를 살려 두려고 빈 요청을 보내지는 않습니다. 실제 비율은 `- time:` 줄의 `cache read` 값으로 확인합니다.

### 실행·제어·알림

`.git/gusta/v1/loops/<tag>/loop.json`에 상태·로그·세션 ID·정지 파일 경로를 남깁니다. 보통 foreground 실행을 도구/하네스 완료 대기로 기다립니다. `--detach`는 부모 터미널과 분리하므로, 시작 대화로 실제 완료 이벤트와 후속 실행을 돌려주는 연결이 있을 때만 사용합니다. 연결이 없으면 자동 후속/채팅 통지를 약속하지 않습니다. macOS에서는 caffeinate를 사용합니다. STOP 표식은 재시작 전에 직접 지웁니다. headless 세션 권한은 SETTINGS `permission-mode`(기본 `bypass`)를 따르고 메인 checkout에서 실측합니다. `acceptEdits`로 두었다면 필요한 명령을 `--allow-tool 'Bash(pnpm *)'`처럼 추가합니다. `--permission-mode`는 그 실행에만 적용됩니다.

마감 시각은 `--deadline '<ISO with Z or offset>'`, 마감 전 예약 길이는 `--final-reserve-hours <hours>`로 각각 정합니다. 실행 중에도 `--configure`에 이 옵션을 넘겨 같은 호스트에 적용하고 receipt의 실제 deadline·workDeadline·예약 값을 확인합니다. pending이나 push 주기 변경만으로 마감이 설정됐다고 말하지 않습니다. 실행 중에는 `--status`로 heartbeat·요청/적용 설정·운영 오류를 보고, `--configure --push-each-unit|--no-push-each-unit`로 단위별 push를 바꿉니다 — 현재 단위가 끝난 뒤 같은 호스트에 적용되며 receipt의 `status:applied`로 확인합니다(pending은 적용 전). SETTINGS push가 false이면 이 옵션도 원격 게시를 켜지 않습니다. `--stop`·SIGINT·SIGTERM은 즉시 취소라 새 마감 검증·push를 시작하지 않고, `--stop-after-unit`은 현재 단위와 마감 관문까지 마친 뒤 멈춥니다. 호스트는 자기가 쓴 보고서와 자기 active 행만 정리합니다. 성공을 보고한 단위 뒤에 그 밖의 변경이 남으면 사람의 편집일 수 있으니 보존한 채 다음 단위와 게시를 멈춥니다(끝내지 못한 단위의 변경은 위처럼 스냅샷으로 넘깁니다). 종료된 호스트는 `--recover-metadata`로 정리합니다(모델·push·재시작 없음). 시작 때 알림 연결 여부를 표시합니다. `--notify-command`가 없으면 로컬 outbox만 남으며 사용자에게 자동 통지되지 않습니다. 훅 성공도 사용자 수신 증거는 아닙니다. 시작 대화는 종료 영수증의 실제 검증·반영·원격 WIP 보존·미완료 상태를 확인해 보고합니다. 독립 감시자·알림(`--notify-command`: 실패·판단 대기·종료 요약)·복구 계약은 [loop 제어 계약](../skills/gusta-start/references/loop-control.md)에 있습니다.

맡김의 결정·주차 규칙은 [모드 표](workflow.md#gusta-start로-시작하기)와 같습니다. 구현이 판단 문제로 막히면 기획 한 조각으로 해소해 재개하고, CI 실패는 근거를 담은 수정 태스크로 만들어 다음 단위로 먼저 실행합니다. 시간·단위·반복 실패 한도에 닿으면 `loop.json`과 보고서에 우선 재개할 태스크를 남깁니다.

## 결정 브리핑 — `vibe brief`

구현 세션은 SSOT 문서·STATE·FORMAT을 통째로 읽는 대신 **그 태스크가 기대는 결정 블록**을 한 번에 받습니다. 단독은 `vibe brief`, 작업 묶음 워커는 `work brief`(실행기가 자동 전달), `vibe loop`의 단위가 같은 조립기를 씁니다.

```bash
npx @haeram/gusta vibe brief T201 --summary       # 전체 크기·섹션별 블록 수·조회 경로
npx @haeram/gusta vibe brief T201 --section decisions --offset 0 --limit 10 --json
npx @haeram/gusta vibe brief T201 --section guidance --offset 0 --limit 10 --json # 조건부 검증 지침
npx @haeram/gusta vibe brief T201                 # 전체 원문(미커밋 포함), 마크다운
npx @haeram/gusta vibe brief T201 --ref HEAD      # 그 커밋만 기준
npx @haeram/gusta vibe brief AUTH-4               # 결정 하나 + 필수 의존 + 이 결정을 가리키는 곳(referrers)
npx @haeram/gusta vibe brief AUTH@3               # r3 이후 chg 줄과 바뀐 결정 (gusta-create-task 델타)
npx @haeram/gusta vibe brief T201 --deep --json   # 미분류 참조까지 끝까지, JSON
```

큰 브리핑은 `--summary`로 먼저 범위와 크기를 확인하고 `--section decisions|tasks --offset <n> --limit <n>`으로 완전한 블록을 나눠 읽습니다. 페이지는 전체 closure를 읽었다는 뜻이 아니며 coverage를 확인해 필요한 나머지 범위도 읽습니다. 기본 전체 출력과 실행기에 전달되는 필수 맥락은 줄이지 않습니다.

브리핑에는 태스크 본문, 인용 도메인의 현재 결정 원문 블록(cfg `brief: domain`, 기본) 또는 인용 결정만(`brief: cited`), 필수(`→!`)·정본(`→=`) 참조를 끝까지, 인용 결정을 가리키는 결정, 전역 규칙(cfg `always`, 없으면 ARCH 전체), 관련 도메인의 flow·constraints, 뒤처진 base 이후 chg, 관련 결정함 줄이 들어갑니다. 빠진 것은 `## not included`, 문제는 `## issues`(complete:no, 종료 코드 1)에 남고 크기 때문에 잘라내지 않습니다 — 마지막 `end … chars:N` 줄이 없으면 출력이 잘린 것입니다. 참조 표기(`→!`·`→=`·`→~`·`→`)는 [FORMAT](../skills/gusta-create-architecture/assets/FORMAT.md) Notation에 있고, 기존 `→`는 추측으로 분류하지 않고 결정을 고칠 때 하나씩 표시합니다.

**범위와 전역 규칙** (STATE cfg): `- brief: domain|cited`, `- always: ARCH-1 ARCH-4 SEC`(결정 ID나 도메인, `-`는 없음). 둘 다 없으면 `domain`·ARCH 전체입니다. `cited`는 훨씬 작지만 **태스크가 지켜야 할 결정을 빠짐없이 인용할 때만** 안전합니다 — 기존 태스크가 그렇지 않다면 `domain`으로 두세요. 측정과 한계는 [0.7.0 보고](history/0.7.0.md)에 있습니다.
