# 실행 중 제어·종료·메타데이터 복구

이 계약의 실행·기록은 loop 호스트가 맡고, 사용자 목표의 오케스트레이션은 시작 대화가 소유한다. Claude/Codex/command 워커는 호스트 보고서를 편집하거나 마감하지 않고 배정된 단위 결과만 반환한다. 호스트 종료는 시작 대화가 읽을 영수증이며 사용자 작업 완료가 아니다. 회복 가능한 실행기 결함 뒤에는 시작 대화가 원래 마감·전체 예산·누적 이력을 유지해 일반 스킬/새 하위 단위로 이어간다. 다른 프로세스의 npm 캐시나 실행 중 소스를 고쳐서 동작을 바꾸지 않는다. 살아 있는 호스트를 중단·대체하는 전환기는 만들지 않는다.

## 세 동작

| 요청 | 현재 단위/검증 | 다음 단위 | 마감 |
|---|---|---|---|
| `--stop`, SIGINT, SIGTERM | 즉시 취소 | 시작하지 않음 | 메타데이터만; 새 검증/push 없음 |
| `--stop-after-unit` | 현재 단위와 최종 관문 완료; 원래 deadline 우선 | 시작하지 않음 | 검증 성공분 게시 가능 |
| `--configure` + push·deadline·예약 옵션 | 취소하지 않음 | 같은 호스트에서 적용된 설정 사용 | 명시한 시간 설정만 변경; 소비한 단위·이력 유지 |

시간 한도는 두 단계다. `workDeadline`(deadline − 실측 마감 예약, [검증 절차](verification.md#시간-예산))부터는 수정 단위 외에는 시작하지 않고 `reason:final-window`로 마감 관문을 정상 실행한다 — 취소가 아니다. `deadline` 도달은 기존처럼 즉시 취소이며 진행 중 검증은 `cancelled`로 남는다.

`--stop`의 기존 의미와 STOP 표식은 유지한다. 취소 후 마감 검증/push 생략은 의도적인 변경이다. 검증 실패와 중단 이유를 섞지 않는다. 진행 중이던 검증의 중단은 `cancelled`, 실제 명령 실패는 `fail`이다. 사용자가 정지하면 STOP을 보존한다. 자동 메타데이터 재시도·명시적 복구는 STOP을 지우거나 워커를 재시작하지 않는다. 사용자가 새 실행을 명시할 때만 STOP을 확인·제거하고 새 실행을 시작한다. 기존처럼 명시적 새 실행은 새 예산이며, 설정 전환/내부 재시도/메타데이터 복구는 새 실행이 아니다.

## 요청과 확인

실행 중인 checkout에서 같은 tag로 요청한다. `--configure`에는 push 옵션·`--deadline`·`--final-reserve-hours` 중 하나 이상이 필요하다. push 옵션은 SETTINGS push의 게시 권한을 대신하지 않는다. deadline은 `Z` 또는 offset이 있는 절대 ISO 시각이며, 예약 시간은 마감 전 관문에 남길 길이다.

```sh
npx @haeram/gusta vibe loop --tag k3f9 --configure --push-each-unit --wait-ms 30000 --json
npx @haeram/gusta vibe loop --tag k3f9 --configure --deadline '<ISO with Z or offset>' --final-reserve-hours 1 --wait-ms 30000 --json
npx @haeram/gusta vibe loop --tag k3f9 --status --json
```

접수 응답의 `applied:false`·`request.status:pending`은 완료 확인이 아니다. `requests/<id>.json`의 `status:applied`, `actual`의 실제 push·deadline·workDeadline·예약 값, `appliedAt`, `afterUnit`으로 적용을 확인한 뒤에만 사용자에게 설정됐다고 말한다. 요청 시 이미 지난 마감은 유효성 오류로 거절하고, 단위 경계에서 마감이 지났거나 예약을 확보할 수 없으면 실패 영수증을 남긴다. push 주기 변경은 마감 설정이 아니다. `--wait-ms`는 receipt 대기 길이이며 시간 초과가 취소/적용을 뜻하지 않는다. 여러 요청은 잠금 안에서 발급한 `sequence` 순서로 적용한다. 단위 완료 정지의 applied는 단위 경계에서 마감을 시작했다는 뜻이며, 호스트 종료는 `--status`의 `running:false`로 확인한다. 종료 전에 적용되지 못한 요청은 `cancelled`와 이유를 남긴다. 적용 저장 뒤 응답 기록에 실패하면 적용 이력으로 receipt를 복원한다. 호스트가 죽으면 미확인 요청을 취소하며 작업을 재실행하지 않는다.

단위 완료 → journal로 식별한 보고서/active 정리·커밋 → 미확인 사용자 변경 확인 → 요청 설정 적용·manifest/receipt 저장 → 필요하면 검증 SHA로 push·게시 SHA의 CI 대기 → 다음 단위 순서다. `runId`, PID, `startedAt`, 소비한 `units`·회복 이력은 초기화하지 않고 deadline·예약은 명시한 값만 바꾼다. 현재 단위가 실패했거나 사용자가 취소하면 재시작 전환기를 붙이지 않는다. 파일 전체가 dirty라는 이유만으로 일반 복구 모델을 부르지 않는다.

checkout Git 디렉터리의 소유권 lock은 한 호스트만 허용한다. 모든 제어는 manifest의 checkout·tag·runId를 확인한다. detach 응답은 자식의 소유권 기록을 확인한 뒤 반환하며 preflight 완료는 status에서 별도 확인한다. 호스트는 독립 감시자의 준비 응답도 확인한 뒤 단위를 시작한다. 인계·새 워커 재시도·복구 실행기는 없다.

## 정확한 메타데이터 소유권

`metadata.json`은 그 runId의 보고서 **하나**에 대해 마지막으로 쓴 정확한 내용과 쓰기 전/후를 보존한다. STATE는 자기 active 행만 수정하며 다른 바이트를 다시 포맷하지 않는다. STATE 전체를 자동 커밋할 수 있는 경우는 HEAD와의 차이가 그 행뿐일 때다. 다른 사용자 변경이나 알 수 없는 index 내용은 보존한다. `spec/`, `reports/`, STATE 전체를 dirty 예외로 취급하지 않는다.
기존 보고서는 Git이 깨끗해도 이전 journal이 경로·tag·내용을 증명할 때만 다시 연다. 이전 버전 보고서처럼 증거가 없거나 사용자 파일과 이름이 겹치면 보존하고 새 tag를 사용한다.

보고서는 매 단위 경계와 모든 종료 경로에서 호스트가 정리한다. source/SSOT/task/기타 STATE/사용자 변경은 다음 단위·게시를 막고 그대로 남긴다. 호스트 보고서를 외부에서 수정했다면 자동 덮어쓰기/커밋도 거절한다. 메타데이터 쓰기·커밋·manifest는 동일 호스트에서 한 번만 자동 재시도한다. 워커를 다시 호출하거나 한도를 리셋하지 않는다. 실패는 구현/검증 오류와 별도 `operationalErrors`, journal, `metadata-error` 이벤트로 남는다.

종료된 호스트만 다음 명령으로 정리한다.

```sh
npx @haeram/gusta vibe loop --tag k3f9 --recover-metadata --json
```

기록한 before/after와 정확히 일치하는 미완료 쓰기만 재적용하고, 자기 active를 제거하고, 보고서를 닫아 알려진 파일만 커밋한다. 모델·코드 복구·push·STOP 제거·예산 초기화는 없다. 복구 충돌은 운영 오류로 남기고 보존한다. 이 명령이 성공해도 원래 실행 실패나 검증 실패가 해결됐다는 뜻은 아니다. 짧은 소유권 arbiter를 쓰는 순간 프로세스가 강제 종료되어 `.arbiter` 파일이 남으면 자동 소유권 탈취 대신 거절한다. 기록의 PID/host와 실제 종료를 확인한 운영자가 그 파일만 정리한 뒤 재시도한다.

## 상태와 알림

runtime는 `<Git common dir>/gusta/v1/loops/<tag>/`다(일반 checkout은 `.git/gusta/v1/loops/<tag>/`).
시작 응답/status의 알림 capability·terminal 이벤트/receipt 경로를 확인한다. 시작 대화는 이 이벤트를 실제 후속 실행/통지 연결로 소비한다. 훅 미설정이면 로컬 기록만 남고 자동 사용자 통지가 불가능함을 실행 전에 밝힌다. 파일이 생겼다는 이유로 이 대화에 알림을 보냈다고 보고하지 않는다.

| 파일/필드 | 계약 |
|---|---|
| `loop.json` | 원자적 교체. runId/host/PID, phase/status, startedAt/workDeadline/deadline/endedAt, units, recovery/specRepairs/specRejected(미해결 task ID·위반), requestedConfig/appliedConfig, configHistory, reason/stopReason, error/operationalErrors, publication(마지막 반영) |
| `heartbeatAt` | 약 1초마다 기록. 60초 지연은 건강하지 않은 상태이며 살아 있는 소유권을 탈취하지 않음 |
| `terminal.json` | 최종 manifest 쓰기 실패의 별도 종료 기록. `--status`는 같은 runId일 때 병합 |
| `gate`·`continuation` | 전체 관문 시도·누적 실패/상한·남은 수정 태스크, 남은 시간/단위와 중단 경계. `objectiveComplete:false`이며 사용자 목표 완료는 시작 대화가 판단 |
| `terminal-event.json` | 같은 runId의 최종 알림과 outbox receipt 경로. 상위 연결이 소비할 수 있지만 파일 생성은 사용자 전달 증거가 아님 |
| `events.jsonl` | started/configuration-applied/stopped, unit-cut/unit-leftover/task-parked/spec-gate/spec-gate-reconciled(알림 아님), 알림: failed/metadata-error/host-lost/heartbeat-stale/supervisor-error·needs-judgment·finished 등; 상위 연결이 소비할 종료 근거 |
| `notifications/<event-id>.json` | 알림 이벤트의 내구성 있는 outbox와 실제 훅 시도 결과 |
| `<dispatch>.log` | 단위 로그. 어댑터 stdout/stderr(Claude stream-json·Codex JSONL)를 도착 즉시 덧붙인다 — 실행 중 단위는 가장 최근 파일을 `tail -f`. 끝난 단위는 `dispatches[].log` |

독립 감시 프로세스는 호스트가 비정상 종료되면 `status:failed`, `reason:host-lost`, `running:false`를 기록하고 미적용 요청을 취소한다. 호스트는 감시자가 사라져도 운영 오류로 중단한다. `--status`는 원시 running 플래그만 믿지 않고 PID·heartbeat·감시자·terminal을 확인한다. 다른 host 소유권이나 살아 있는 PID는 자동 탈취하지 않는다. 사용자 취소·no-work·원래 시간/단위 한도를 감시자가 되돌리지 않는다.
단위 상한(`--timeout-ms`, explore는 timebox+30분, 어느 쪽이든 마감 구간 시작까지)·출력 한도로 끊긴 단위는 성공으로 반환하지 않는다: `unit-cut` 이벤트와 보고서 `cut (...)` 줄로 남기되 loop는 계속한다. 실패·절단 단위의 미커밋 변경은 `refs/gusta/units/<tag>/<run>-<n>`에 스냅샷하고(스테이징만 된 내용은 둘째 부모, push 안 함) 그 경로만 HEAD로 되돌린 뒤 새 단위에 넘긴다 — 같은 태스크는 이어가기→한 번 쪼개기→inbox parked(`unit-leftover`·`task-parked`). 이어받은 태스크가 끝나면 그 ref를 지우고, 남은 ref는 보고서 next에 적는다. 변경 없는 절단만 실패로 세며 연속 2회면 `session-failures`로 멈추지만 앞 단위가 커밋한 코드는 마감 관문·push를 거친다. 성공을 보고한 단위 뒤의 미커밋 변경은 사람의 것일 수 있어 그대로 두고 다음 단위·게시를 멈춘다. 사용자 취소는 트리를 건드리지 않는다. 체크포인트·절전 방지 종료 실패도 운영 오류로 남기며 조용히 버리지 않는다.

태스크 완료 보고는 주장이고 spec 마감이 증거다: 호스트는 배정한 태스크가 tasks/done에 `done@날짜`로 보관되고 STATE 행이 사라졌으며 단위가 더한 lint 오류가 없는지 본다(경고는 막지 않는다). 어기면 완료로 세지 않고(보고서 `rejected by spec gate`) 위반 목록과 `vibe task start/done` 마감 지시를 담은 수리 단위 하나를 주고(이미 유효한 완료 보관본은 보존), 다시 어기면 inbox parked 후 다른 일을 계속한다(`spec-gate`). FORMAT 밖 st가 남은 태스크(`vibe status` issues·route repair)도 같은 수리 단위 하나로 시작한다. 최종 반영·마감 관문은 spec lint와 마감 근거를 먼저 본다: 오류나 미해결 완료 거절이 있으면 최종 반영하지 않고 `spec lint: fail` 또는 `spec close: fail`로 남기며, 마감은 no-work가 아니라 실패로 끝난다. 상위 세션이 실제 문서를 수리했으면 호스트가 그 근거를 다시 확인해 specRejected를 지우고 `spec-gate-reconciled`로 기록한다(새 완료 보고를 꾸밀 필요 없음). 명시적 원격 이어가기는 검증되지 않은 WIP 인계로 보존할 수 있다. 시작 대화는 수리/주차 근거와 남은 일을 받아 전체 마감·예산 안에서 후속 처리한다.

`--notify-command '<command>'`를 시작 옵션에 지정하면 호스트와 감시자가 알림 이벤트 JSON을 stdin으로 보낸다. 사람이 볼 일에만 알린다 — 단위 완료·heartbeat 알림은 없다. 모든 알림의 `level`로 거른다:
- `failure`: 위 실패 이벤트. 기존 필드 그대로.
- `attention`: `needs-judgment` — 단위가 inbox decided/parked 줄·STATE ssot `[?]` 수 증가를 더했거나 parked를 반환하면 단위당 한 번. `unit`·`task`·`count`·`items`(kind·refs·짧은 text, 10개까지)·`more`.
- `finished`: 모든 종료(no-work·needs-sketch(태스크로 안 쪼갠 기획만 남음 — `hint`가 /gusta-sketch를 안내하고 level은 attention)·범위 끝·단위 완료 정지·시간 한도·`--stop`·실패)에 실행당 한 번, host-lost면 감시자가 보낸다. `status`·`reason`·`units`·`judgment`(지금 판단 대기 전체: count·items·more)·`parked`·`push`(`pushed:true`+commit, 아니면 `pushed:false`+reason: `land-unset`·`push-disabled`·`local`·`not-attempted`·종료 status)·`report`(없으면 null), 읽지 못한 CI가 있으면 `ciUnchecked`(commit·url — 사람이 나중에 확인). level은 실패 failure, 판단 대기·`ciUnchecked` attention, 그 외 info. 실패면 실패 알림도 따로 간다.

알림은 loop를 막거나 실패시키지 않는다(needs-judgment 훅은 다음 단위와 함께 돈다). 명령은 대상 checkout에서 실행하며 stdout/stderr는 `notification.log`, 제한은 10초다. exit 0만 `delivery:hook-acknowledged`, `deliveredToHook:true`다. 훅 실패는 `delivery:failed`, 미설정은 `delivery:recorded-locally`이며 둘 다 전달 완료가 아니다. 훅 성공도 외부 사용자 수신 증거는 아니므로 `externalDelivered:false`를 유지한다. 시작 대화가 종료 영수증을 받으면 검증 시도·남은 수정 태스크·반영/WIP 보존 여부를 확인해 작업을 이어가거나 실제 중단 사유를 사용자에게 전달한다.

전체 시스템 종료·재부팅·감시자까지 함께 종료되면 새 알림 생성은 보장하지 않는다. 다음 `--status`는 사망/오래된 heartbeat를 판별하지만 독립 OS 서비스 설치는 하지 않는다. 비정상 종료 후 구현 프로세스가 살아 있을 수도 있으므로 메타데이터 복구 외 자동 작업 재시작은 하지 않는다. 기존 버전 호스트에는 새 제어 프로토콜이 없으며 패키지 설치만으로 이미 실행 중인 프로세스가 바뀌지 않는다.
