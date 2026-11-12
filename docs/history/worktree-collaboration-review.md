# Worktree·AI 협업 확장 검토

상태: 초기 검토 및 후속 구현 기록. 현재 기능은 「현재 구현 범위」와 README를 기준으로 한다. 36개 항목 표는 최초 검토 목록이며, 후속 결정이 아래에 반영돼 있다.

## 제품 방향

주 타겟은 **혼자 개발하면서 여러 AI 작업을 병렬로 진행하는 사용자**다. 사용자는 혼자 한 checkout에서 시작하고, 필요할 때 여러 worktree와 에이전트에서도 같은 스펙·태스크·검증 기록을 이용한다. haeram-spec-creator는 작업의 근거, 의존성, 배정, 검증 및 통합 완료의 의미를 정의한다. 사람과 AI 모두 같은 작업 인계 규칙을 사용할 수 있게 하되, 다중 사용자 권한이나 원격 조정 서버를 첫 버전의 전제로 삼지 않는다.

사용자는 작업 공간 관리의 구체적인 방식을 구현 판단에 위임했다. 외부 도구가 제공한 worktree를 수용하고, 직접 생성·정리하는 흐름도 설계에 포함한다. 생성할 수 없는 환경에서는 실행 방식을 조정하되, 작업 공간 격리가 안 된 상태에서 병렬 쓰기를 계속하지 않는다. 다음 절의 작업 묶음 브랜치와 상태 전달 방식은 사용자 제안을 바탕으로 구체화한 **채택한 설계**다. 구현 범위와 남은 제약은 「현재 구현 범위」를 따른다.

검토한 Orca는 공개된 stablyai/Orca 문서 기준이다. 사용자가 의도한 제품의 URL이 다르면 도구별 어댑터 범위는 재확인한다. Orca는 일반 Git worktree를 사용하고, 외부 worktree를 표시할 수 있으며, 이슈에서 유래한 브랜치명도 지원한다. 따라서 첫 연동은 Git 메타데이터와 안정적인 CLI/JSON 인터페이스면 충분하다. 특정 명령·디렉토리·브랜치 접두사를 제품 계약으로 고정할 이유는 없다. [Orca worktree 문서](https://www.onorca.dev/docs/model/worktrees)

## 작업 묶음 브랜치 제안

사용자 제안: 큰 작업을 시작할 때 상위 브랜치를 만들고 그 브랜치에서 하위 worktree를 분기한다. 작업 상태를 계속 전달하고 결과를 상위 브랜치에 모은다.

권장 흐름:

```text
기존 기준 브랜치 (main 등)
  └─ work/login-renewal          작업 묶음의 기획·통합 기준
       ├─ task/T042              AI A의 별도 worktree
       ├─ task/T043              AI B의 별도 worktree
       └─ task/T044              필요할 때 생성

태스크 결과 → work/login-renewal에서 통합·검증 → 기존 기준 브랜치에 최종 반영
```

이름은 예시이며 branch의 상하 관계는 제품이 기록하는 관계다. Git이 부모 브랜치의 변경을 자식 브랜치에 자동 전파하지는 않는다. 작업 묶음은 여러 태스크를 조정할 때 만들고 기존 feature branch를 연결할 수도 있다. 단순한 수정 하나마다 별도 브랜치 계층을 요구하지 않는다.

- 작업 묶음별로 기획·채번·통합 기록의 작성자를 하나로 둔다. 꼭 상시 실행되는 별도 AI일 필요는 없고, 사용자의 주 세션이나 직렬화된 CLI가 맡을 수 있다.
- 하위 작업의 통합 대상은 작업 묶음 브랜치다. 권장 완료 기준은 워커 검증 완료 → 작업 묶음에 통합·검증되어 task done → 작업 묶음이 기존 기준 브랜치에 최종 반영되는 별도 단계다. 후속 태스크가 시작할 때는 해당 의존 결과를 포함하는 커밋에서 분기하거나 자신의 checkout에 반영했는지 확인한다.
- 작업 상태 **관측**과 구현 기준 **갱신**을 구분한다. 중앙 진행 상황은 묶음의 기획 인덱스와 실행 기록에서 조회한다. 최신 정책/코드를 작업 중 checkout에 실제로 반영하는 것은 시작·의존 결과 반영·재개·제출 시점 등 명시적인 경계에서 수행한다.
- 같은 clone에서는 `git show work/login-renewal:spec/STATE.md`처럼 다른 브랜치의 커밋된 문서를 checkout 변경 없이 읽을 수 있다. 실제 CLI는 ref를 한 번 commit SHA로 고정해 관련 문서를 같은 커밋에서 읽는다. 진행 중 선점은 공통 Git 디렉토리의 실행 기록에서 확인한다. SSOT가 바뀌었으면 적용 여부를 판단해야 하며, 중앙 문서를 읽었다는 사실만으로 로컬 구현 기준이 갱신되지는 않는다.
- 모든 워커가 STATE 전체를 계속 cherry-pick하는 방식은 기본 동기화 수단으로 삼지 않는다. cherry-pick은 변경을 현재 branch에 적용하고 통상 새 커밋을 만든다. 같은 상태 필드에 대한 상충 변경, 워커의 미완료 변경과 충돌, 코드 없이 done 상태만 전달하는 문제를 별도로 해결해야 한다. [Git cherry-pick](https://git-scm.com/docs/git-cherry-pick)
- 같은 clone의 worktree끼리는 로컬 ref와 object를 공유하므로 상태를 조회하려고 원격 push할 필요가 없다. push는 원격 백업·PR·다른 머신 공유에 사용한다. 다른 clone의 사람/AI가 참여하면 fetch 주기와 공유 선점의 권위 있는 저장소를 추가로 정의해야 한다. [Git worktree](https://git-scm.com/docs/git-worktree)

작업 공간 선택은 기존 배정 재사용 → 지원되는 경우 자체 생성 → 격리가 불가능하면 병렬 실행을 시작하지 않고 안전한 단일 작업 흐름으로 전환하는 순서다. 실패 후에는 생성 도중 남은 branch·worktree·배정을 확인하고 작업 상태를 기록한다. 이미 실행 중인 다른 워커가 있다면 그 checkout을 재사용하는 식으로 우회하지 않는다.

정리는 자체 생성한 worktree 중 통합이 확인되고 실행 중인 작업·미커밋/미추적 변경이 없는 대상에 한정한다. 외부 생성 worktree는 해당 도구의 lifecycle을 존중한다. 정리 실패 시 보존하고 사유를 보고하며, 강제 삭제로 완료를 가장하지 않는다. Git이 반환하는 성공/실패만으로 제품 수준의 소유권·작업 보존 조건을 대신할 수는 없다.

개발 우선순위는 이 흐름을 중심으로 재정렬한다. 아래 36개 표는 최초 검토 목록이며, 상위 브랜치와 자체 작업 공간 지원에 관한 이 절의 후속 방향을 우선한다. 명시적인 CLI 요청으로 작업 묶음에 로컬 통합한다. 원격 push와 main 반영은 기존 프로젝트 흐름을 따른다.

## 원안에서 채택할 것과 수정할 것

| 원안 | 판정 | 적용 방향 |
|---|---|---|
| 영속 문서와 실행 중 조정 상태 분리 | 강하게 동의 | 문서의 진실과 lease·heartbeat의 진실을 분리하되, 로컬 조정 저장소의 적용 범위를 명시한다. |
| STATE는 worktree에서 살 수 없다 | 표현 수정 | 브랜치별 스펙 인덱스로는 유효하다. 공유 관제탑이라는 약속이 잘못됐다. `cfg`·`tasked`·기획 인덱스까지 일괄 삭제할 필요는 없다. |
| git-common-dir에 조정 상태 저장 | 같은 clone에서는 동의 | linked worktree끼리만 공유한다. 별도 clone·다른 호스트·격리된 컨테이너까지 공유하지는 않는다. |
| 파일에서 태스크 보드 파생 | 강하게 동의 | 먼저 checkout별 읽기 전용 보드를 제공한다. 전역 보드는 기준 ref와 runtime overlay를 정한 후 만든다. |
| 선점 = worktree 생성 | 분리 필요 | `claim/adopt`와 `workspace create`는 독립 동작. 외부 배정을 수용하는 기능이 우선이다. |
| task/T042 브랜치면 이어받기 | 소유권 근거로 부적합 | 태스크·attempt·owner·worktree의 명시적 binding 필요. 브랜치명은 검색 힌트에 한정한다. |
| doing 기록 후 재확인으로 선점 | 현재도 안전하지 않음 | A 기록→A 확인→B 기록→B 확인이면 둘 다 성공한다. 실제 경쟁 제어는 코드의 원자적 연산이 맡아야 한다. |
| depends_on 추가 | 중복 | 이미 `dep`과 참조 검사가 존재한다. 누락된 순환 검사와 파일/STATE 일치 검사를 보강한다. |
| touches가 다르면 자유롭게 병렬 | 과한 보장 | 예상 수정 경로는 충돌 경고의 힌트다. API 계약·DB·포트·테스트 계정의 충돌은 별도다. |
| worker done 후 통합 | 상태 의미 결정 필요 | 구현 완료와 기준 브랜치 통합 완료를 분리해야 의존 태스크가 안전하게 시작한다. |
| rebase→검증→fast-forward로 한 커밋 | Git 의미 수정 | fast-forward는 브랜치 포인터 이동이며 하나의 커밋을 만들지 않는다. squash·merge·rebase 선택과 메타데이터 커밋 정책은 별개다. |
| blocked(spec)에서 SSOT에 [?] 직접 추가 | 역할·전파 수정 | 워커는 문제와 근거를 인계한다. 기획자의 SSOT 변경, 사용자 결정, 워커 checkout 갱신까지 연결해야 한다. |
| 메시지 버스 없이 파일 상태로 협업 | 초기에는 동의 | 파일은 프로토콜 저장 형식이 될 수 있지만 다른 브랜치의 파일은 즉시 보이지 않는다. 전달·관측·재개 규칙이 별도로 필요하다. |
| 통합 후 worktree와 claim 삭제 | 조건부 | 외부 도구 소유 worktree는 해당 도구의 lifecycle 정책을 따른다. 미추적 파일·리뷰 증거 보존도 필요하다. |

Git은 linked worktree별 HEAD/index와 공통 저장소 메타데이터를 구분한다. `.git`이 디렉토리라는 가정을 버리고 Git이 보고하는 경로를 사용해야 한다. detached HEAD worktree도 가능하므로 worktree와 브랜치는 일대일 동의어가 아니다. [Git worktree](https://git-scm.com/docs/git-worktree), [Git rev-parse](https://git-scm.com/docs/git-rev-parse)

## 현재 구현 범위

- 외부 도구와 독립된 `manage-work` 스킬 및 `work` CLI. `auto/current/new` 선택과 자동 환경 인식. 작업 묶음의 생성/연결, 태스크 worktree 생성/연결, 상태 조회를 지원한다.
- 같은 clone의 Git common dir에 버전 있는 runtime을 저장한다. 짧은 파일 락과 원자적 JSON 교체로 task/workspace를 예약하고 실행마다 새 attempt ID를 발급한다. 생성·검증 같은 긴 동작은 기록 락 밖에서 실행한다.
- `work board`는 상위 브랜치의 특정 커밋에 고정한 태스크와 runtime을 합쳐 표시한다. 일반 board는 계속 checkout별 읽기 전용 조회다.
- `work submit`은 커밋된 worker의 acceptance·계약·SSOT 일치를 확인하고 명시한 검사 명령을 실행해 ready를 기록한다. `work integrate`는 별도 후보에서 merge·done 아카이브·STATE 갱신·spec 검사·커밋·검증을 수행한 뒤, 기준이 변하지 않은 기획 공간에 fast-forward한다.
- `work update/release/cleanup/recover/unlock`으로 blocked/heartbeat, 선점 해제, 자체 생성 worker 정리, 외부 worktree의 배정 해제, 중단된 명령 복구를 지원한다. 임의의 TTL 회수·force 삭제·원격 push는 없다.
- 스킬 11개가 공통 배정 규칙을 사용한다. 워커는 자신의 task acceptance/result 외 spec을 쓰지 않고, 기획·채번·STATE 변경은 기획 공간에서 직렬로 수행한다. 기존 단독 작업의 STATE 골격은 유지한다.
- 기존 dep 표기를 유지하면서 참조·순환·자기참조·중복 ID·STATE/file 불일치를 검사한다.
- claim-next·수정 우선 resume·독립 review-task와 고정 커밋 승인으로 워커/리뷰어 큐를 처리한다. `work run`은 Codex/Claude 기본 어댑터 또는 command 어댑터로 실행·검증·리뷰·통합을 반복한다.

현재 지원 범위는 같은 로컬 clone이다. 별도 clone/원격 조정, 경쟁 fan-out, 자동 main 반영은 후속 확장이다. 브랜치와 실패 후보는 복구를 위해 남을 수 있다. Orca 앱에 포함된 CLI와 runtime은 doctor로 확인하며, 실제 task/dispatch 실행·종료 API 연동은 포함하지 않고 일반 Git worktree 계약으로 연결한다.

보드는 여러 데이터 소스를 읽는 관측 결과이며 선점을 대신하지 않는다. 최신 정책 적용은 워커의 명시적 동기화·재검증을 요구한다. 코드 파일에 대한 일반 Git/에디터 동작은 로컬 배정 프로토콜을 우회할 수 있으므로, 기획 공간에 쓰기 담당을 하나로 유지한다.

## 데이터 경계

| 층 | 제안하는 정본 | 변경 주체와 성질 |
|---|---|---|
| 정책 | Git의 `spec/ssot/`와 기획 인덱스 | 기획 담당이 정책 변경·rev·소화 이력을 관리한다. 워커는 인계 요청을 만든다. |
| 작업 의도 | Git의 `spec/tasks/` | 영속 task ID·acceptance·dep·SSOT base. 생성/재분해는 기획 checkout에서 직렬화한다. |
| 실행 시도 | 같은 clone의 `<git-common-dir>/haeram/` | attempt ID, task binding, owner token, workspace, heartbeat, 실행 상태. Git에 커밋하지 않는다. |
| 검증 및 인계 | task/attempt별 검증 기록 | 정확한 commit/tree, 실행한 검사, 한계, blocker, 리뷰 대상. 필요한 증거만 Git에 보존한다. |
| 통합 | 명시한 target ref의 도달 가능성과 통합 기록 | 대상 ref의 통합자 한 명 또는 기존 PR/merge queue가 관리한다. |
| 표시 | 보드 | 명시한 기준 ref의 작업 의도 + 실행 시도 overlay + 통합 증거에서 파생한다. |

단일 태스크와 단일 실행 시도는 다르다. T042의 재시도, 세션 재개, Claude/Codex 비교 실행은 각각 attempt일 수 있다. 영속 태스크에 세션 UUID·heartbeat까지 넣으면 branch마다 다른 값이 커밋돼 충돌한다. 반대로 검증 결과를 전부 `.git`에만 두면 clone·CI·PR에서 근거를 잃는다.

`base:AUTH@3`은 정책 개정 번호이므로 유지한다. 향후 실행 기록의 `startCommit`, `targetRef`, `targetCommit`, `verifiedCommit`은 별개 필드다. 시작 커밋만으로 현재 target과의 관계를 판단할 수는 없으며, 실제 Git graph도 확인해야 한다.

공유 runtime의 첫 구현은 CLI만 쓰게 하고 스킬이 JSON을 직접 편집하지 않도록 한다. claim은 태스크 단위 원자적 생성, 소유권 변경은 owner token/세대 확인, 갱신은 중간 JSON이 노출되지 않도록 원자적 교체가 필요하다. 긴 테스트나 worktree 생성 중 저장소 전체 락을 유지하지 않는다. 만료된 heartbeat는 회수 후보를 뜻할 뿐, 기존 워커가 멈췄음을 보장하지 않는다.

## 결정이 필요한 항목 36개

권장값은 다음 구현을 위한 제안이며 이미 확정된 제품 정책은 아니다. 1–8을 먼저 정하면 첫 협업 모드의 범위가 정해진다.

| # | 쟁점 | 권장 출발점 | 선택의 영향 |
|---|---|---|---|
| 1 | 협업 범위: 같은 clone인가, 여러 머신·clone인가 | 1차는 같은 머신의 같은 clone | 다중 호스트까지 포함하면 `.git` 파일만으로는 배정 원자성을 만들 수 없다. |
| 2 | 실행 환경의 책임 | 채택: 자동 감지 + 자체 생성/정리 + 외부 checkout 수용 | worktree 생성기를 내장할지는 별도 옵션이 된다. Orca 실행 모델을 복제할 필요가 없다. |
| 3 | 기본 사용자 경험 | 단독 모드는 지금처럼, 협업 모드는 명시적 opt-in | worktree가 있다고 곧 다중 에이전트는 아니다. 혼자 쓰는 사용자에게 통합 절차를 강제하지 않는다. |
| 4 | 통합 대상 | 프로젝트 설정 또는 실행 인자로 명시 | `main`, 원격 기본 브랜치, 현재 브랜치를 자동으로 같은 것으로 보지 않는다. |
| 5 | done의 의미 | 협업 모드에서는 기준 ref 통합을 최종 완료로 정의 | worker 완료에는 별도 ready/verified 개념이 필요하고 기존 done의 이관 기준도 필요하다. |
| 6 | merge 권한과 전략 | 채택: 명시적인 CLI로 묶음 내 통합, main/PR은 기존 흐름 | 로컬 통합자와 GitHub merge queue 중 누가 마지막 권한자인지 정해야 한다. |
| 7 | 기획·SSOT·태스크 채번 담당 | 한 planning checkout에서 직렬 처리 | 워커 병렬화부터 지원한다. 기획 병렬화는 별도의 ID/정책 충돌 해결이 필요하다. |
| 8 | 기존 프로젝트 이관 | 버전 있는 포맷 + 명시적 migration, 미리보기 제공 | 설치 스킬만 갱신해도 기존 spec 문서가 저절로 바뀌지는 않는다. |
| 9 | branch명과 task binding | branch와 독립된 명시적 task/attempt binding | 이슈 유래 브랜치명·사용자 이름·detached checkout을 지원할 수 있다. |
| 10 | worktree 하나에 작업 몇 개를 둘지 | 동시 쓰기 attempt 하나, 순차 재사용 허용 | task별 락만 있으면 서로 다른 task가 같은 checkout을 동시에 쓸 수 있어 workspace 검사도 필요하다. |
| 11 | 소유자 식별과 세션 재개 | 화면 tag와 별개인 무작위 owner/attempt ID | 기존 2–4자 tag나 PID만으로는 충돌·재시작·PID 재사용을 구분할 수 없다. |
| 12 | stale claim 회수 | 우선 명시적 회수, 자동 회수는 보류 | TTL 경과만으로 회수하면 잠자던 워커가 살아나 동시 쓰기할 수 있다. |
| 13 | heartbeat 주기와 공급자 | 외부 실행기가 있다면 heartbeat 제공, 없으면 명시적 갱신 | 스킬 프롬프트만으로 타이머나 백그라운드 프로세스 생존을 보장할 수 없다. |
| 14 | 중단 중간 상태·손상 복구 | 버전 있는 record와 진단/복구 명령 | mkdir 성공 후 JSON 쓰기 전 죽음, rename 실패, 삭제된 worktree를 처리해야 한다. |
| 15 | 락의 저장 방식 | 로컬 파일 backend부터, 작은 API로 격리 | 단순 mkdir만 쓸지 SQLite 등을 쓸지는 장애 복구·플랫폼 요구를 보고 정한다. |
| 16 | 오래된 워커의 쓰기 차단 | owner 세대 확인 + 통합 시 재검증 | fencing은 협조하는 CLI 동작을 차단한다. 일반 에디터의 코드 파일 쓰기까지 막는다고 보장할 수 없다. |
| 17 | task ID 장기 전략 | 당장은 기존 T### + 생성 직렬화 | 기획까지 병렬화하려면 중앙 할당 또는 영속 UUID와 표시 번호 분리가 필요하다. |
| 18 | 전역 보드의 기준 | 명시한 planning/target ref + runtime overlay | 호출자의 오래된 branch를 기준으로 하면 다른 작업을 누락한다. 모든 worktree의 파일을 무작정 합쳐도 충돌한다. |
| 19 | STATE에서 유지할 내용 | cfg·기획 인덱스 유지, tasks/next/log의 역할 재설계 | tasks 표만 없애도 모든 워커가 같은 next/log를 쓰면 충돌은 계속된다. |
| 20 | rev/tasked의 소유권 | 기획 기준 ref에서만 업데이트 | 각 worker가 자기 rev를 최신이라고 보면 신선도 검사가 무의미해진다. |
| 21 | 진행 중 정책 변경 | blocker 인계→기획 변경→영향 판정→명시적 동기화 | 다른 branch에 `[?]`를 써 두는 것만으로 기획자에게 전달되거나 워커가 새 정책을 읽지는 않는다. |
| 22 | dep 충족 시점 | 기본은 target에 통합 후 | stacked branch 실행을 허용하면 의존 결과의 정확한 commit과 재검증 규칙도 필요하다. |
| 23 | touches 문법과 강제 수준 | 처음에는 선택적 경로 예측과 경고 | globs·대소문자·이동 파일·새 파일·generated file 포함 규칙을 정해야 한다. 하드락으로 쓰면 오탐이 많다. |
| 24 | 경로 밖의 공유 자원 | 필요할 때 `resources` 같은 별도 계약 | DB migration·공유 dev DB·포트·테스트 계정·외부 staging은 파일 겹침만으로 판정 불가다. |
| 25 | 워커가 예상 범위를 벗어날 때 | scope 변경을 기록하고 재배정 필요를 판단 | 자동 중단인지 경고인지, 다른 워커와 겹쳤을 때 누가 조정할지 필요하다. |
| 26 | blocker 분류와 라우팅 | spec/dep/merge/env + reason + 기대 응답 | 새 st 문자열에 모든 이유를 넣기보다 실행 상태와 blocker 데이터를 분리하는 편이 확장하기 쉽다. |
| 27 | 리뷰 대상을 고정하는 방법 | branch명과 함께 정확한 commit/tree 기록 | 리뷰 중 코드가 바뀌면 기존 finding/승인을 어떤 범위까지 재사용할지 정해야 한다. |
| 28 | 리뷰어의 수정 권한 | 원본 정책대로 finding 제안, 별도 기록 저장 | 같은 worker checkout에 리뷰 문서를 쓰는 것도 동시 쓰기다. 리뷰용 checkout/기록 위치가 필요하다. |
| 29 | 자동 승인 범위 | 기획 결정·finding 채택은 기존 사용자 정책 유지 | 사용자가 승인 정책을 확장하기 전에는 agent 간 합의를 사용자 채택으로 대체하지 않는다. |
| 30 | 검증 증거 | 검사한 전체 commit SHA와 dirty 여부 또는 tree digest | 미커밋 변경 위에서 검사하고 HEAD만 적으면 실제 검사한 코드를 재현할 수 없다. |
| 31 | 통합 중 target이 이동하면 | 후보 재생성·검증, 반영 시 target 일치 확인 | 검사와 merge 사이의 경쟁이 있다. target별 통합 직렬화 또는 merge queue가 필요하다. |
| 32 | 충돌 해결 위치 | 별도 integration checkout을 우선 검토 | 워커가 작업 중인 branch를 통합자가 rebase하면 워커의 파일·검증 기준이 바뀐다. |
| 33 | blocked 이후 재개 | 같은 태스크의 새 attempt와 이전 증거 보존 | 이전 claim을 계속 유지할지, 인계 뒤 해제할지에 따라 대기열·회수 방식이 달라진다. |
| 34 | fan-out 비교 | task 하나에 여러 isolated attempts, 채택 하나 | 기본 exclusive claim의 예외다. 동일 task 다중 attempt를 처음부터 표현할 수는 있게 한다. |
| 35 | cleanup과 기록 보존 | 생성한 주체가 정리, unmerged/dirty 상태 확인 | 외부 worktree를 자동 삭제하지 않는다. runtime 정리와 검증 이력 보존은 별도다. |
| 36 | 배포·CLI·포맷 호환성 | 포맷/runtime schema 버전과 최소 CLI 버전 연결 | 서로 다른 npx 캐시·설치 스킬 버전이 같은 runtime을 만져도 되는지 정해야 한다. |

추가 구현 제약: 지원할 Git/OS 버전, submodule·bare clone에서 생성한 linked worktree, worktree 이동·삭제·prune, JSON 출력 안정성, 런타임 절대 경로의 외부 노출 범위는 각 기능의 지원 범위와 테스트에 명시해야 한다. 원격·컨테이너 환경은 common-dir 문자열이 같다는 이유만으로 같은 저장소라고 판단해서는 안 된다.

## 단계별 제안과 완료 기준

| 단계 | 작업 | 완료 기준 |
|---|---|---|
| A — 이번 변경 | 환경 발견, 로컬 파생 보드, 기존 dep 검사, 스킬 설명 정정 | 실제 linked worktree·detached·non-Git fixture에서 조회·범위 구분·의존성 오류 검출을 검증한다. |
| B — 협업 계약 | 위 1–8 결정, 포맷 버전과 migration 설계, legacy/협업 모드 구분 | task·attempt·verified·integrated·target·planning owner 의미가 한 문서에서 일치한다. |
| C — 최소 협업 | 공유 claim/adopt/release/inspect, 명시적 binding, board overlay, 모든 스킬의 쓰기 경로 전환 | 두 프로세스가 같은 task 또는 checkout을 선점하면 한 쪽만 성공. 중단·재개·잘못된 owner·손상된 record 테스트 통과. |
| D — 검증과 통합 인계 | worker ready 기록, commit 기반 리뷰, 통합 후보 검증, 기존 PR/merge 흐름 연결 | target 이동·충돌·검증 실패 시 integrated로 표시되지 않고, 다른 작업의 dep도 충족시키지 않는다. |
| E — 도구 어댑터 | 실제 사용하는 Orca의 배정·완료·재개 경로에 CLI 연결 | 외부 생성·임의 브랜치·수동 정리에서도 binding과 보드가 일관된다. |
| F — 확장 | touches/resources 경고, 구조화 blocker, fan-out, 필요하면 원격 backend | 각각 독립된 요구와 실패 복구 계약을 갖고, 단독 사용 흐름의 부담을 늘리지 않는다. |

후속 결정으로 같은 clone의 로컬 작업 묶음, 묶음 브랜치 통합 시 태스크 완료, 기존 main/PR 흐름 유지가 채택됐다. 초기 A–D의 핵심 경로를 구현했고, 외부 도구는 Git worktree로 연결한다. E의 도구별 API 연동과 F의 원격·경쟁 실행은 실제 수요에 따라 확장한다.


## 지속 실행과 제출물 리뷰 확장

- STATE next는 사람/기획 세션 재개 안내로 유지. 50개 등의 작업 목록은 그룹 브랜치, 워커별 실행·리뷰 큐는 공통 Git runtime이 담당한다.
- claim-next는 snapshot 기준 후보에서 원자적으로 선택·예약한다. 후속 의존 태스크 수와 ID 순서를 사용하고 선택 touches 경로가 겹치면 직렬화한다.
- 기본 workers=4, reviewers=1, max-pending=8. 수정 요청을 우선 재배정하고 리뷰 적체 시 새 작업을 줄인다. 항상 슬롯을 채우거나 최적 일정을 보장하지 않는다.
- 제출→리뷰 선점→승인/수정 요청→통합으로 전이한다. 승인에 submission ID와 worker/target commit을 고정한다. 타깃 이동 시 무관한 변경도 재리뷰하는 보수적 초기 정책이다.
- review-task를 추가하고 기존 review-code의 개선 제안·사용자 채택 절차는 유지한다.
- work run은 Codex/Claude 기본 어댑터 또는 JSON stdio command 어댑터로 실제 프로세스를 실행하고 완료 후 보충·리뷰·직렬 통합한다. 기본 provider auto는 호환되는 Codex, Claude 순으로 선택하며 reviewer-provider로 역할을 나눌 수 있다. 모델은 명시한 값이나 각 CLI 설정을 사용한다. doctor와 dry-run은 모델 호출 없이 도구·설정을 확인한다. Orca 설치 여부로 실행 모드를 바꾸지 않으며 coordinator는 같은 CLI 프로토콜을 직접 사용할 수 있다.
- 기본 어댑터는 워커에게 파일 편집을 맡기고 호스트가 시작 HEAD·acceptance·계약·spec 변경 범위를 확인한 뒤 커밋·제출한다. 리뷰어는 고정 snapshot을 읽는다. 이 흐름과 중단 시 자식 프로세스 종료는 가짜 provider CLI를 사용하는 통합 테스트로 검증한다. 실제 모델 실행 성공이나 인증 상태를 CLI 감지만으로 보장하지 않는다.
- 이번 범위에 포함하지 않은 것: Orca 전용 실행 어댑터, 원격 clone 간 상태 공유, 코드 의미를 분석한 무관한 변경의 재리뷰 생략, 자동 워크스페이스 삭제. 스킬 문구만으로 실제 실행기가 연결됐다고 보고하지 않는다.
