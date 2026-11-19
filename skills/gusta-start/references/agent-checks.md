# agent acceptance 기록

단위·워커 결과의 `agentChecks`와 보고서 `## checks`에 쓰는 형식이다.

- 항목: `id`·`scenario`·`steps`(1개 이상)·`expected`·`observed`·`evidence`·`status`(`pass|fail|not-run`)·`reason`·`replaces`(대체한 자동 E2E/명령 범위)·`stage`(`unit|integration`, 기본 integration)·`required`(기본 true)·`owner`(기본 host)·`candidate`·`duplicationReason`.
- pass·fail은 실제 computer use로 관찰한 것만이다. `candidate`는 integration 후보를 관찰했을 때만 그 커밋의 전체 SHA, 아니면 null이다.
- unit-stage AC는 그 단위에서 확인한다. 도구가 없거나 integration-stage면 not-run과 이유·담당자(capable host)를 남겨 태스크 result·호스트에 넘긴다. 관찰 없는 pass, E2E fallback, MCP 격리 해제로 메우지 않는다.
- agent AC가 맡은 자동 E2E/명령 범위는 실행 대상에서 제거·축소한다. 둘 다 돌리는 것은 다른 위험·근거·추가 비용을 적은 승인된 예외뿐이다 — `duplicationReason`만으로는 안 된다. 기존 명시적 의무와 충돌하면 주 검증 방법을 먼저 승인된 계약에 배정한다.
- 최종 완료에는 실제 candidate SHA에 고정된 필수 integration 증거가 필요하다. candidate가 바뀌면 이전 관찰을 새 SHA의 pass로 옮기지 않는다.
- 결과는 최종 보고서의 기존 `## checks`와 채팅에 모은다. 사용자는 기준의 누락·잘못된 기대 조건을 검토하며, 에이전트의 수동 QA를 대신하지 않는다.
