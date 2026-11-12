# 함께 모드와 실행기 밖 세션

시작 질문은 한 번에 모은다: 함께/맡김, route:choose의 기획/구현 우선순위, 다른 기기의 배정(이어받기는 사용자 지시 필요). 인자로 답한 것은 묻지 않는다. 함께 모드가 기본이며 질문 도구가 없으면 텍스트 질문 뒤 답을 기다린다.

함께는 `vibe status --section inbox --no-fetch --json`으로 결정함만 확인받는다. 승인 항목은 삭제+log, 수정은 gusta-update-ssot 후 삭제. 열린 보고서는 to를 채운다. 결정은 cfg.level에 맞춰 모아 묻는다.

맡김도 이 대화가 목표·마감·총 회복 예산을 소유한다. 직렬 loop가 실제 checkout에서 preflight·active·보고서·절전 방지를 준비하므로 동일 점검을 앞에서 반복하지 않는다. 독립 probe가 필요하면 `vibe preflight --probe-workspace current --probe '<태스크 단계 명령>' --json`으로 실제 실행 공간을 확인한다. 의존성 부재·네트워크 제한·권한 거부를 구분하고, 네트워크 실패만으로 별도 worktree 의존성 설치를 반복하지 않는다. 작업 묶음 조정자는 실제 워커 공간에 맞는 probe를 쓰며 이 세션에서 active·보고서·awake를 준비한다.

## loop 옵션

시간 한도의 끝 구간은 마감 관문 전용이라 새 단위를 시작하지 않는다(`final-window`). 길이는 CLI가 실측으로 정한다(전체 검증×2+수정 단위+CI). 사용자의 마감 시각은 시간대를 확인해 `--deadline '<ISO with Z or offset>'`으로 넘긴다. `--final-reserve-hours`는 마감 전 검증·수정·CI 예약 **길이**이며 마감 시각이 아니다. 시작 응답/status의 실제 deadline·workDeadline·예약 시간을 확인한 뒤에만 마감이 설정됐다고 말한다. 맡길 태스크는 `--tasks '<T### ...>'`로 넘긴다(next 줄에 기대지 않음, 끝나면 `scope-done`). 단위 상한(`--timeout-ms`, 기본 1시간·explore는 timebox+30분)에 끊긴 단위는 CLI가 스냅샷→이어가기→쪼개기→parked로 처리하고 loop는 계속된다. `--permission-mode`는 사용자가 그 실행만 바꿀 때 넘긴다. 실제 실행 권한은 시작 probe로 확인한다.

실행 중에는 `vibe loop --tag <tag> --configure --deadline '<ISO with Z or offset>' --final-reserve-hours <hours> --wait-ms 30000 --json`으로 같은 호스트의 마감·예약을 바꾼다. 단위별 push는 `--push-each-unit|--no-push-each-unit`이며 마감 변경을 대신하지 않는다. applied receipt의 실제 값으로 확인한다. 즉시 취소와 단위 완료 후 정지는 별개다. [실행 중 제어·복구 계약](loop-control.md)을 따른다.

보통 foreground loop를 도구/하네스 완료 대기로 기다리고 종료 영수증을 받아 이어간다. 모델의 sleep→status 반복은 하지 않는다. detach는 상위 대화의 실제 후속 실행 연결이 있을 때만 쓴다. 시작 때 알림 연결 여부를 보고하며, 훅 미설정/상위 연결 부재면 자동 채팅 통지가 안 된다고 밝힌다. CLI가 끝나도 회복 가능한 문제가 남으면 새 하위 단위나 일반 스킬로 목표를 이어서 처리한다(원래 마감·총 한도 유지). CLI 결함은 보고서에 남기고 현재 프로젝트에서 패키지를 고치지 않는다.

## 배포와 strict 선점

- "배포해줘"는 `vibe deploy --wait-ci`로 SETTINGS deploy 브랜치를 land로 fast-forward한다. 사용자가 요청할 때만 하며, deploy가 `-`면 gusta-preference로 정하게 안내한다. 거절(deploy에 land에 없는 커밋)되면 그 커밋을 land에 합쳐 검증한 뒤 다시 배포한다.
- strict(SETTINGS push 대상이 있고 다른 생존 세션·소유 불명 doing이 보일 때): 세션을 등록·커밋한 뒤 `vibe claim --tag <tag> --task T###`로 원격 선점 정보를 **먼저** 공유한다. claim은 원격 트리의 STATE에 자기 선점만 기록하므로 미검증 로컬 코드는 push하지 않는다. 원격 영수증을 로컬에 합친 뒤 소유권을 재확인한다. 다른 tag면 다른 후보. 원격이 선점을 판정한다. push 브랜치가 없으면 이 checkout 혼자 일한다. 같은 checkout의 동시 쓰기 금지.

## 마감

실행기 밖 조정자/단독 시작 세션만 마감 때 보고서 to/next와 STATE next를 채우고 beat --end, 최종 후보의 묶음 검증(push 브랜치가 있으면 검증 SHA로 push 한 번), awake --stop을 한다. 마지막으로 `vibe prune --tag <tag>`를 실행한다. 이 세션의 `wip/<tag>`와 합쳐진 작업 묶음의 브랜치·worktree를 정리하며, 설정이 false면 CLI가 건너뛴다. 보고는 한 일·inbox/parked·다음 일·보고서 경로만 짧게 한다.
