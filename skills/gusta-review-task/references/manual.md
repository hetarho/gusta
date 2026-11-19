# 수동 리뷰 세션

실행기나 `work next`가 리뷰 배정을 주지 않은 세션만 읽는다. `work ...`는 `npx @haeram/gusta work ...`의 축약이다.

- 선점: `work review-claim --work <group> --owner <reviewer> --json`(특정 제출물은 `--attempt <id>`). 계속 리뷰하는 세션은 `--wait 540`(셸 timeout은 더 길게)으로 기다리고 빈 큐를 모델 호출로 반복 확인하지 않는다. `complete`면 종료, `stalled`·`timeout`이면 reason을 전한다.
- 반환된 workspace는 제출 커밋에 고정된 checkout이다. `work status`의 currentReview가 받은 review ID와 같은지 확인한다.
- 긴 리뷰는 `work review-update --review <id>`로 heartbeat, 리뷰를 그만둘 때는 리뷰 작업을 먼저 멈춘 뒤 `work review-release --review <id>`로 선점을 푼다(다른 리뷰어가 이어받는다).
- 마감: 결과 JSON을 세션 임시 폴더에 저장하고(저장소·그 밖의 경로 금지) `work review-finish --review <id> --result-file <path> --json`. 결과가 거부되면 새 배정으로 다시 리뷰하고, 옛 결과를 새 ID에 복사하지 않는다.
