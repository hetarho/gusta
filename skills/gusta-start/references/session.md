# 실행기 밖 세션

시작 때 묻지 않는다 — 1절의 실행 정보를 보여 주고 바로 시작한다. 결정함은 실행 중에 쌓이고, 사용자는 돌아와 `/gusta-start inbox 정리`로 승인 항목을 지우거나(`vibe inbox resolve --log`) 결정을 바꾸려면 /gusta-sketch로 간다. 열린 보고서는 to를 채운다.

이 대화가 목표·마감·총 회복 예산을 소유한다. 기획·구현 전 `vibe session open --kind start --tag <tag> --json`으로 받은 전용 worktree의 targetRoot/branch에서 실행한다. 배정된 hostManaged 단위는 기존 격리 공간을 검증해 잇는다. 직렬 loop가 실제 checkout에서 preflight·active·보고서·절전 방지를 준비하므로 동일 점검을 앞에서 반복하지 않는다. 독립 probe가 필요하면 `vibe preflight --probe-workspace current --probe '<태스크 단계 명령>' --json`으로 실제 실행 공간을 확인한다. 의존성 부재·네트워크 제한·권한 거부를 구분하고, 네트워크 실패만으로 별도 worktree 의존성 설치를 반복하지 않는다. 작업 묶음 조정자는 실제 워커 공간에 맞는 probe를 쓰며 이 세션에서 세션 등록(`vibe beat --tag <tag> --mode autopilot`)·보고서·awake를 준비한다.

## loop 옵션

시간 한도의 끝 구간은 마감 관문 전용이라 새 단위를 시작하지 않는다(`final-window`). 길이는 CLI가 실측으로 정한다(전체 검수 한 번+수정 영향 범위+CI). 사용자의 마감 시각은 시간대를 확인해 `--deadline '<ISO with Z or offset>'`으로 넘긴다. `--final-reserve-hours`는 마감 전 검증·수정·CI 예약 **길이**이며 마감 시각이 아니다. 시작 응답/status의 실제 deadline·workDeadline·예약 시간을 확인한 뒤에만 마감이 설정됐다고 말한다. 맡길 태스크는 `--tasks '<T### ...>'`로 넘긴다(next 줄에 기대지 않음, 끝나면 `scope-done`). 단위 상한(`--timeout-ms`, 기본 1시간·explore는 timebox+30분)에 끊긴 단위는 CLI가 스냅샷→이어가기→쪼개기→parked로 처리하고 loop는 계속된다. `--permission-mode`는 사용자가 그 실행만 바꿀 때 넘긴다. 실제 실행 권한은 시작 probe로 확인한다.
단위마다 도구·모델·에포트는 CLI가 정한다: 태스크 `run:`을 SETTINGS `agents` 안에서 실행하고, 쓸 수 없으면(목록 밖·미로그인·지원 안 하는 모델/에포트) score가 가장 가까운 조합, `run:`이 없으면 `agents` 첫 도구를 그 도구 기본 설정(모델·에포트 미지정)으로 쓴다. 회복·관문 수정 단위는 그보다 낮추지 않는다. 사용량·속도 한도·과부하·로그인 실패는 단위·사다리·실패 횟수에 세지 않고 같은 태스크를 `agents` 안 다음 조합의 새 세션으로 다시 띄운다(차단은 clone 공용 `limits.json`). 모두 막히면 첫 리셋이 작업 시간 안이면 모델 호출 없이 기다리고, 아니면 `usage-limit`으로 멈춘다(`hint`의 도구·리셋 시각을 보고서·사용자에게, 재실행은 리셋 뒤). 시작 전 `--dry-run`의 `routing`(task·recommended·run·source)을 실행 정보로 보여 준다. `--provider`·`--model`·`--effort`는 사용자가 실행 전체를 직접 고정할 때만 넘긴다. `agents` 미정이면 `needs-init`으로 멈추니 gusta-init으로 보낸다. 보고서 done 줄과 manifest dispatch·`unit-route` 이벤트에 실제 조합이 남는다(추천과 다르면 `추천 → 실제`).

실행 중에는 `vibe loop --tag <tag> --configure --deadline '<ISO with Z or offset>' --final-reserve-hours <hours> --wait-ms 30000 --json`으로 같은 호스트의 마감·예약을 바꾼다. 단위별 push는 `--push-each-unit|--no-push-each-unit`이며 마감 변경을 대신하지 않는다. applied receipt의 실제 값으로 확인한다. 즉시 취소와 단위 완료 후 정지는 별개다. [실행 중 제어·복구 계약](loop-control.md)을 따른다.

보통 foreground loop를 도구/하네스 완료 대기로 기다리고 종료 영수증을 받아 이어간다. 모델의 sleep→status 반복은 하지 않는다. detach는 상위 대화의 실제 후속 실행 연결이 있을 때만 쓴다. 시작 때 알림 연결 여부를 보고하며, 훅 미설정/상위 연결 부재면 자동 채팅 통지가 안 된다고 밝힌다. CLI가 끝나도 회복 가능한 문제가 남으면 새 하위 단위나 일반 스킬로 목표를 이어서 처리한다(원래 마감·총 한도 유지). CLI 결함은 보고서에 남기고 현재 프로젝트에서 패키지를 고치지 않는다.

## 배포와 선점

- "배포해줘"는 `vibe deploy --wait-ci`로 SETTINGS deploy 브랜치를 land로 fast-forward한다. 사용자가 요청할 때만 하며, deploy가 `-`면 gusta-preference로 정하게 안내한다. 거절(deploy에 land에 없는 커밋)되면 그 커밋을 land에 합쳐 검증한 뒤 다시 배포한다.
- 선점은 SETTINGS push와 무관하게 항상 조정 브랜치에서 한다: `vibe task start`가 먼저 선점한다(코드 push·깨끗한 트리·커밋 불필요, 행이 걷힌 세션은 다시 등록). 거절(exit 1, `claim.owner`·`reason: claimed|unlanded`)이나 status `coordination.lost`(다른 기기가 먼저 올림)면 다른 후보. 못 올린 선점(`unpublished`)은 그대로 일한다. `coordination.error`는 메시지대로 SETTINGS `coord`를 고친다. 같은 checkout의 동시 쓰기 금지.

## 마감

마감 때 구현·태스크 결과와 agent AC를 ready로 제출하고 [공유 검증 절차](verification.md)를 따른다. 작업이 끝난 세션이 다른 기기를 idle로 추정해 전체 검사·push하지 않는다. 모두 ready인 묶음의 한 소유자만 고정 후보를 반영하며 waiting-agent이면 capable host가 실제 후보에서 관찰·기록한 뒤 기존 검수 증거로 재개한다. 보고서는 기존 checks에 AC 결과를 모으고 기준의 누락/오류에 대한 사용자 피드백을 요청한다. 마지막 `vibe prune --tag <tag>`는 합쳐진 소유 공간만 정리하고, 아직 제출·검증 중인 세션 worktree는 보존한다.
