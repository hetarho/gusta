# 승인한 작업을 전용 세션에 모아 공동 통합

## 역할과 실제 실행 수단

작업 묶음은 배정·검증·통합 장치이며 오케스트레이터를 다른 최상위 세션으로 넘기는 기능이 아니다.

사용 가능한 하위 세션 실행 도구가 있으면 각 역할의 프롬프트와 고정 파일 포인터를 전달한다. 실제 세션 ID/owner와 배정·완료/차단을 기록한다. 서로 다른 세션은 같은 checkout에 쓰지 않는다.

## 승인 기록과 태스크

1. 깨끗한 브랜치와 실제 실행 수단·검사 명령이 통합 전제다. 미커밋 사용자 변경은 자동 커밋/정리하지 않는다.
2. 문서 표기·기획 정본은 기존 FORMAT와 SETTINGS plan을 따른다. 다른 todo를 승인으로 간주하지 않는다.
3. 승인된 ID만 묶음 `--tasks`에 넣는다. 같은 lane은 전부 승인해야 하고, 범위 밖 선행 태스크는 승인 없이 자동 배정되지 않는다. 필요한 의존 작업을 별도로 제안/승인하거나 해당 작업을 보류한다.

## 전용 세션 worktree를 단위 통합 공간으로 사용

아래 명령 앞에는 설치된 `npx @haeram/gusta` 또는 실행기의 실제 cliCommand를 붙인다. 명령의 자리표시자는 확인한 값으로 치환한다.

```sh
work start <run> --workspace current --tasks '<approved task IDs>' --review all --push - --workers 2 --task-verify '<ARCH task: affected unit + fast checks>' --verify '<fast integration check>' --group-verify '<final deterministic checks; shared integration owns the full gate>'
```

`current`는 `vibe session open --kind self-improve`가 반환한 전용 worktree와 세션 브랜치를 뜻한다. 원래 호출한 checkout에서 이 명령을 실행하지 않는다. 워커는 또 다른 배정 worktree를 쓰며 보호 브랜치에서 구현하지 않는다. `--workers 2`는 기본 구현 슬롯이다.

설치된 CLI 도움말에서 `--tasks` 지원을 확인한다. 지원하지 않으면 올바른 버전의 CLI 연결이 필요하다고 보고하고 무제한 큐로 대체하지 않는다.

기존 묶음이 이 checkout을 이미 소유하면 새 이름으로 중복 시작하지 않는다. 이 로컬 개선 묶음이고 기존 실행이 끝난 것이 확인되면 기존 승인 ID/완료 이력을 보존해 `work configure --work <run> --tasks '<old and newly approved IDs>' --review all --push -`로 확장한다. 무관한 활성 묶음이면 침범하지 않고 보고한다. 진행/통합된 ID를 범위에서 제거해 이력을 숨길 수 없다.

## 구현과 리뷰 실행

- **네이티브 하위 세션**: 오케스트레이터가 승인 ID를 `work claim <task> --work <run> --owner <worker> --workspace new`로 배정하고 실제 workspace·attempt를 전달한다. 구현 완료 프로토콜에서 커밋·submit 소유자를 한 번 정한다. 리뷰는 다른 owner의 `work review-claim` → gusta-review-task → `work review-finish`다. 승인된 제출물만 오케스트레이터의 `work integrate`로 통합한다. 자식이 다른 묶음이나 무관한 태스크를 고르지 않도록 정확한 배정을 유지한다.
- **기존 headless 실행기**: 탐색은 채운 [탐색 프롬프트](../assets/scout-prompt.md)를 세션 임시 폴더에 쓰고 영역마다 `work scout --prompt-file <file> --json`(도구는 CLI가 SETTINGS `agents`에서 배정)을 백그라운드로 실행해 제안 JSON만 받는다(읽기 전용, 기본 15분). 제안 승인은 호출 세션, 확정 태스크의 구현/리뷰는 `work run --work <run> --autopilot`이 맡는다(도구·모델·에포트는 태스크 `run:`대로 CLI가 배정하고 리뷰어는 다른 도구를 먼저 쓴다). 대상 묶음의 승인 범위·검사·review all·push 비활성 상태를 먼저 확인한다. 조정자는 기획 결정 요청을 처리하고 실행기는 배정/커밋/제출/리뷰/통합을 맡는다. 스킬의 “오케스트레이터가 승인”은 코드 리뷰 자동 승인 옵션이 아니다.

묶음의 `--push -`는 단위별 원격 코드 반영을 끈다. 네이티브 세션에서도 push/PR은 자식에게 배정하지 않는다. 코드/범위가 변하면 새 제출·독립 리뷰를 받으며 오래된 승인을 복사하지 않는다.

## 통합 완료와 원격 반영

검사·리뷰된 단위가 실제 전용 세션 브랜치에 들어온 것을 board/HEAD/diff로 확인한다. `work finish`는 공동 ready/고정 후보 관문에 연결하며 다른 세션이 working이면 각자 전체 검수를 실행하지 않는다. 승인 범위와 제외 항목·후보·검증 SHA를 보존한다. 이 세션의 ready와 전체 land 반영 완료를 구별한다.

묶음 응답의 `integrationTarget`은 전용 세션의 실제 경로·브랜치다. 최종 반영은 공유 묶음의 소유권과 SETTINGS land·push를 따르며 배포는 별도 요청이다. 원래 checkout을 전환하거나 원격 land가 바뀌었다고 자동 병합·전체 재검증을 반복하지 않는다. 필수 integration AC는 도구가 있는 owner가 고정 후보에서 수행한 뒤 기존 검수 증거로 이어간다.

긴 측정 전에 생산 명령이 원시 수치·입력/출력 해시를 실행기 artifact에 저장하도록 준비한다. `work finish`의 성공 기록은 검사 명령/시각/결과의 영수증이며 원시 측정 stdout을 보존하는 저장소가 아니다. 근거를 잃었으면 그 공백을 보고하고 예산 안의 보완만 수행하며, 긴 실행을 자동으로 반복하지 않는다. 보고서 변경도 실제 검사 입력인지 확인하고 입력이 같은 기존 성공만 재사용한다. 마감 보고라는 이유만으로 증거를 버리거나 무조건 유지하지 않는다.

대기는 완료 이벤트나 실행기 대기 기능으로 처리한다. 모델이 sleep/상태 조회를 반복하지 않는다. 시간·시도 한도를 넘으면 로그·진행분·승인/검토 상태와 다음 재개 조건을 보존한다.
