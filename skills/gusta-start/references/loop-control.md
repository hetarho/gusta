# 실행 중 제어·복구

loop 호스트가 실행·기록을 맡고, 사용자 목표는 시작 대화가 소유한다. 단위 세션은 호스트 보고서를 편집하거나 마감하지 않는다. 호스트 종료 영수증은 사용자 작업 완료가 아니다 — 회복할 수 있으면 원래 마감·전체 예산·누적 이력을 유지해 일반 스킬이나 새 하위 단위로 잇는다. 실행 중인 호스트의 npm 캐시·소스를 고치거나 살아 있는 호스트를 중단·대체하는 전환기를 만들지 않는다.

## 세 동작

모든 제어는 실행 중인 checkout에서 같은 tag로 한다.

| 요청 | 현재 단위·검증 | 다음 단위 | 마감 |
|---|---|---|---|
| `vibe loop --tag <tag> --stop` | 즉시 취소(`cancelled`) | 시작하지 않음 | 새 검증·push 없음 |
| `--stop-after-unit` | 현재 단위와 마감 관문을 마침(원래 deadline 우선) | 시작하지 않음 | 검증된 것만 반영 |
| `--configure` + push·`--deadline`·`--final-reserve-hours` | 취소하지 않음 | 바뀐 설정으로 | 명시한 값만 바뀌고 소비한 단위·이력은 유지 |

- 사용자가 중단·먼저 반영·원인 보고 등 새 지시를 주면 `--stop`으로 현재 검사와 소유한 하위 프로세스를 끝내고, `--status`의 `running:false`로 종료를 확인한 뒤 새 지시에 맞춰 재계획한다. 접수만으로 끝났다고 말하지 않고, 남은 검사를 임의로 재개하지 않는다. 검증 예외·미실행 검사를 숨기거나 하드 관문을 우회하지 않는다.
- `--stop`이 남긴 STOP 표식은 사용자가 새 실행을 명시할 때만 지운다. 새 실행은 새 예산이고, 설정 변경·재시도·메타데이터 복구는 새 실행이 아니다.
- 검증 실패(`fail`)와 중단(`cancelled`)을 섞어 보고하지 않는다.
- 마감 직전 구간(`final-window`)에는 수정 단위만 돌고 마감 관문이 정상 실행된다 — 취소가 아니다. `deadline` 도달은 즉시 취소다.

## 설정 변경 확인

```sh
npx @haeram/gusta vibe loop --tag <tag> --configure --deadline '<ISO with Z or offset>' --final-reserve-hours 1 --wait-ms 30000 --json
npx @haeram/gusta vibe loop --tag <tag> --configure --push-each-unit --wait-ms 30000 --json
npx @haeram/gusta vibe loop --tag <tag> --status --json
```

- 접수 응답(`applied:false`·`request.status:pending`)은 확인이 아니다. `requests/<id>.json`이 `status:applied`이고 `actual`의 push·deadline·workDeadline·예약 값을 확인한 뒤에만 설정됐다고 말한다. `--wait-ms` 시간 초과는 취소도 적용도 아니다.
- `--push-each-unit|--no-push-each-unit`은 의도만 바꾸고 발행은 공동 마감으로 모은다. SETTINGS push의 게시 권한을 대신하지 않으며, 실제 발행은 push 영수증으로 확인한다.

## 복구

- 끝난 호스트의 보고서·메타데이터가 덜 정리됐으면(`metadata-error`) `vibe loop --tag <tag> --recover-metadata --json`. 기록과 정확히 일치하는 쓰기만 다시 적용할 뿐 모델·코드 복구·push·STOP 제거·예산 초기화는 없고, 성공해도 원래 실행·검증 실패가 해결된 것은 아니다. `.arbiter` 파일 때문에 거절되면 기록의 PID·host가 실제로 끝났는지 확인한 뒤 그 파일만 정리하고 다시 한다.
- `land-conflict`: 새 하위 세션에서 그 land를 이 세션 브랜치에 merge해(rebase 금지) 충돌을 풀고 커밋한 뒤 loop를 다시 띄운다.
- `claim-lost`: 다른 기기가 먼저 가져간 태스크다. 그 결과를 정본으로 따른다.
- 시작 전 미커밋 변경은 `vibe checkpoint --tag <tag>`로 보존하고 이어갈 것만 커밋한 뒤 시작한다.
- 끊긴 단위의 미커밋 변경은 `refs/gusta/units/<tag>/...`에 스냅샷되어 다음 단위가 잇는다. 남은 ref는 보고서 next에 있다.
- spec 관문 거절(보고서 `rejected by spec gate`·`spec lint: fail`·`spec close: fail`)은 수리 단위가 한 번 돌고, 다시 어기면 parked다. 시작 대화가 실제 문서를 고쳤으면 호스트가 그 근거를 다시 확인하니 완료 보고를 새로 꾸미지 않는다.

## 알림

`--notify-command '<command>'`를 시작 옵션에 주면 알림 이벤트 JSON이 stdin으로 간다(`level`: `failure`·`attention`(판단 대기·`ciUnchecked`)·`info`). 훅이 없으면 로컬 기록만 남으니 자동 사용자 통지가 안 된다고 실행 전에 밝힌다. 파일·훅 기록은 사용자 수신 증거가 아니므로 그것만으로 알렸다고 보고하지 않는다. 종료 영수증을 받으면 검증 시도·남은 수정 태스크·반영/WIP 보존 여부를 확인해 잇거나 실제 중단 사유를 사용자에게 전달한다.
