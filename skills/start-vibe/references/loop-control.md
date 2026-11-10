# 실행 중 제어·종료·메타데이터 복구

이 계약은 loop 호스트가 소유한다. Claude/Codex/command 워커는 호스트 보고서를 편집하거나 마감하지 않고 배정된 단위 결과만 반환한다. 다른 프로세스의 npm 캐시나 실행 중 소스를 고쳐서 동작을 바꾸지 않는다. 기존 호스트를 중단하거나 새 호스트로 자동 인계하지 않는다.

## 세 동작

| 요청 | 현재 단위/검증 | 다음 단위 | 마감 |
|---|---|---|---|
| `--stop`, SIGINT, SIGTERM | 즉시 취소 | 시작하지 않음 | 메타데이터만; 새 검증/push 없음 |
| `--stop-after-unit` | 현재 단위와 최종 관문 완료; 원래 deadline 우선 | 시작하지 않음 | 검증 성공분 게시 가능 |
| `--configure --push-each-unit` 또는 `--no-push-each-unit` | 취소하지 않음 | 같은 호스트에서 새 설정으로 한 번 시작 | 시간·단위 한도 유지 |

시간 한도는 두 단계다. `workDeadline`(deadline − 실측 마감 예약, [검증 절차](verification.md#시간-예산))부터는 수정 단위 외에는 시작하지 않고 `reason:final-window`로 마감 관문을 정상 실행한다 — 취소가 아니다. `deadline` 도달은 기존처럼 즉시 취소이며 진행 중 검증은 `cancelled`로 남는다.

`--stop`의 기존 의미와 STOP 표식은 유지한다. 취소 후 마감 검증/push 생략은 의도적인 변경이다. 검증 실패와 중단 이유를 섞지 않는다. 진행 중이던 검증의 중단은 `cancelled`, 실제 명령 실패는 `fail`이다. 사용자가 정지하면 STOP을 보존한다. 자동 메타데이터 재시도·명시적 복구는 STOP을 지우거나 워커를 재시작하지 않는다. 사용자가 새 실행을 명시할 때만 STOP을 확인·제거하고 새 실행을 시작한다. 기존처럼 명시적 새 실행은 새 예산이며, 설정 전환/내부 재시도/메타데이터 복구는 새 실행이 아니다.

## 요청과 확인

실행 중인 checkout에서 같은 tag로 요청한다. `--configure`에는 push 옵션 하나가 필요하다. 이 옵션은 SETTINGS push의 게시 권한을 대신하지 않는다.

```sh
npx haeram-spec-creator vibe loop --tag k3f9 --configure --push-each-unit --wait-ms 30000 --json
npx haeram-spec-creator vibe loop --tag k3f9 --status --json
```

접수 응답의 `applied:false`·`request.status:pending`은 완료 확인이 아니다. `requests/<id>.json`의 `status:applied`, `actual.pushEachUnit`, `appliedAt`, `afterUnit`이 설정 적용 완료 확인이다. `--wait-ms`는 그 시간만 receipt를 기다리며, 시간 초과가 요청 취소/적용을 뜻하지 않는다. 여러 요청은 잠금 안에서 발급한 `sequence` 순서로 적용한다. 단위 완료 정지의 applied는 단위 경계에서 마감을 시작했다는 뜻이며, 호스트 종료는 `--status`의 `running:false`로 확인한다. 종료 전에 적용되지 못한 요청은 `cancelled`와 이유를 남긴다. 적용을 저장한 뒤 응답 기록에 실패해도 마지막 정리에서 적용 이력으로 receipt를 복원한다. 호스트가 죽으면 미확인 요청을 취소하며 작업을 재실행하지 않는다.

단위 완료 → journal로 식별한 보고서/active 정리·커밋 → 미확인 사용자 변경 확인 → 요청 설정 적용·manifest/receipt 저장 → 필요하면 검증 SHA로 push·게시 SHA의 CI 대기 → 다음 단위 순서다. `runId`, PID, `startedAt`, `deadline`, `limits`, `units`는 설정 변경으로 초기화하지 않는다. 현재 단위가 실패했거나 사용자가 취소하면 재시작 전환기를 붙이지 않는다. 파일 전체가 dirty라는 이유만으로 일반 복구 모델을 부르지 않는다.

checkout Git 디렉터리의 소유권 lock은 한 호스트만 허용한다. 모든 제어는 manifest의 checkout·tag·runId를 확인한다. detach 응답은 자식의 소유권 기록을 확인한 뒤 반환하며 preflight 완료는 status에서 별도 확인한다. 호스트는 독립 감시자의 준비 응답도 확인한 뒤 단위를 시작한다. 인계·새 워커 재시도·복구 실행기는 없다.

## 정확한 메타데이터 소유권

`metadata.json`은 그 runId의 보고서 **하나**에 대해 마지막으로 쓴 정확한 내용과 쓰기 전/후를 보존한다. STATE는 자기 active 행만 수정하며 다른 바이트를 다시 포맷하지 않는다. STATE 전체를 자동 커밋할 수 있는 경우는 HEAD와의 차이가 그 행뿐일 때다. 다른 사용자 변경이나 알 수 없는 index 내용은 보존한다. `spec/`, `reports/`, STATE 전체를 dirty 예외로 취급하지 않는다.
기존 보고서는 Git이 깨끗해도 이전 journal이 경로·tag·내용을 증명할 때만 다시 연다. 이전 버전 보고서처럼 증거가 없거나 사용자 파일과 이름이 겹치면 보존하고 새 tag를 사용한다.

보고서는 매 단위 경계와 모든 종료 경로에서 호스트가 정리한다. source/SSOT/task/기타 STATE/사용자 변경은 다음 단위·게시를 막고 그대로 남긴다. 호스트 보고서를 외부에서 수정했다면 자동 덮어쓰기/커밋도 거절한다. 메타데이터 쓰기·커밋·manifest는 동일 호스트에서 한 번만 자동 재시도한다. 워커를 다시 호출하거나 한도를 리셋하지 않는다. 실패는 구현/검증 오류와 별도 `operationalErrors`, journal, `metadata-error` 이벤트로 남는다.

종료된 호스트만 다음 명령으로 정리한다.

```sh
npx haeram-spec-creator vibe loop --tag k3f9 --recover-metadata --json
```

기록한 before/after와 정확히 일치하는 미완료 쓰기만 재적용하고, 자기 active를 제거하고, 보고서를 닫아 알려진 파일만 커밋한다. 모델·코드 복구·push·STOP 제거·예산 초기화는 없다. 복구 충돌은 운영 오류로 남기고 보존한다. 이 명령이 성공해도 원래 실행 실패나 검증 실패가 해결됐다는 뜻은 아니다. 짧은 소유권 arbiter를 쓰는 순간 프로세스가 강제 종료되어 `.arbiter` 파일이 남으면 자동 소유권 탈취 대신 거절한다. 기록의 PID/host와 실제 종료를 확인한 운영자가 그 파일만 정리한 뒤 재시도한다.

## 상태와 알림

runtime는 `<Git common dir>/haeram/v1/loops/<tag>/`다(일반 checkout은 `.git/haeram/v1/loops/<tag>/`).

| 파일/필드 | 계약 |
|---|---|
| `loop.json` | 원자적 교체. runId/host/PID, phase/status, startedAt/workDeadline/deadline/endedAt, units, requestedConfig/appliedConfig, configHistory, reason/stopReason, error/operationalErrors |
| `heartbeatAt` | 약 1초마다 기록. 60초 지연은 건강하지 않은 상태이며 살아 있는 소유권을 탈취하지 않음 |
| `terminal.json` | 최종 manifest 쓰기 실패의 별도 종료 기록. `--status`는 같은 runId일 때 병합 |
| `events.jsonl` | started/configuration-applied/stopped, failed/metadata-error/host-lost/heartbeat-stale/supervisor-error 등 |
| `notifications/<event-id>.json` | 실패 이벤트의 내구성 있는 outbox와 실제 훅 시도 결과 |

독립 감시 프로세스는 호스트가 비정상 종료되면 `status:failed`, `reason:host-lost`, `running:false`를 기록하고 미적용 요청을 취소한다. 호스트는 감시자가 사라져도 운영 오류로 중단한다. `--status`는 원시 running 플래그만 믿지 않고 PID·heartbeat·감시자·terminal을 확인한다. 다른 host 소유권이나 살아 있는 PID는 자동 탈취하지 않는다. 사용자 취소·no-work·원래 시간/단위 한도를 감시자가 되돌리지 않는다.
단위 timeout·출력 한도 같은 비사용자 강제 종료도 성공으로 반환하지 않고 실패 이벤트를 남긴다. 체크포인트·절전 방지 종료 실패도 운영 오류로 남기며 조용히 버리지 않는다.

`--notify-command '<command>'`를 시작 옵션에 지정하면 호스트와 감시자가 실패 이벤트 JSON을 stdin으로 보낸다. 명령은 대상 checkout에서 실행하며 stdout/stderr는 `notification.log`, 제한은 10초다. exit 0만 `delivery:hook-acknowledged`, `deliveredToHook:true`다. 훅 실패는 `delivery:failed`, 미설정은 `pending`이며 둘 다 전달 완료가 아니다. 훅 성공도 외부 사용자 수신 증거는 아니므로 `externalDelivered:false`를 유지한다.

전체 시스템 종료·재부팅·감시자까지 함께 종료되면 새 알림 생성은 보장하지 않는다. 다음 `--status`는 사망/오래된 heartbeat를 판별하지만 독립 OS 서비스 설치는 하지 않는다. 비정상 종료 후 구현 프로세스가 살아 있을 수도 있으므로 메타데이터 복구 외 자동 작업 재시작은 하지 않는다. 기존 버전 호스트에는 새 제어 프로토콜이 없으며 패키지 설치만으로 이미 실행 중인 프로세스가 바뀌지 않는다.
