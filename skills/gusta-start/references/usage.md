# 선택적 로컬 사용량

`settings`의 `usage-measurement`가 false(기본)이면 이 절차를 실행하지 않는다. true인 시작 대화만 아래를 실행한다. 하위 세션·hostManaged·단위1은 상위 조정자가 측정하므로 중복 시작하지 않는다. 같은 대화에서 상위 스킬이 이미 열었으면 그 tag·기준선을 이어가고 최상위 호출만 마감한다. 중첩된 부모·자식 보고서는 합산하지 않는다.

- Claude 네이티브 대화는 작업 전에 `vibe usage start --tag <tag> --marker <32자리 임의 16진수>`를 호출한다. marker는 이번 호출에만 쓰는 **리터럴**로 명령에 직접 쓴다(셸 변수·명령 치환 금지). CLI는 현재 checkout의 로그에서 그 명령의 assistant tool_use 기록을 찾아 세션을 특정하고 기존 사용량을 기준선으로 저장한다. 정확한 세션 ID를 이미 알면 `--marker` 대신 `--session <id>`를 쓸 수 있다. 최신 세션을 추측하지 않는다.
- 시작이 unavailable이면 로그가 아직 기록되지 않았는지 확인한 뒤 같은 marker로 한 번 재시도한다. 그래도 못 찾거나 로그·로컬 runtime I/O가 실패하면 측정 누락을 남기고 작업은 계속한다. 미완료 기준선이 있는 tag는 덮어쓰지 않으므로 새 실행은 고유 tag를 쓴다. 세션 ID가 확인된 뒤 `vibe usage report --session <id>`는 그 세션 전체 기록이며 이번 작업의 사용량으로 바꾸어 말하지 않는다.
- 마감(성공·할 일 없음·실패·주차 포함)에는 `vibe usage report --tag <tag>`를 실행한다. CLI는 JSON `artifact`와 사람이 읽는 Markdown `reportFile`을 로컬 runtime에 저장한다. **최상위 조정자는 최종 채팅 응답에 `chatSummary`의 사용량 요약·클릭 가능한 `reportLink`를 전달한다**(파일·JSON·터미널 출력만으로 끝내지 않음). 기존 owner 보고서에는 checks에 같은 링크를 남긴다. 백그라운드/인계 실행은 부모가 종료까지 기다려 terminal event/status/result의 measurement를 받아 채팅으로 전달한다. 하위 워커는 부모 보고서를 만들지 않는다. 저장 실패는 경로를 꾸미지 말고 `reportErrors`와 저장 불가를 알린다.
- 기준선 뒤의 부모 세션과 그 세션 아래 네이티브 subagents 기록만 측정한다. 부모는 현재 checkout으로 확인하며, 자식은 세션·sidechain·agentId/파일명이 일치하면 다른 worktree cwd도 포함한다(소유권 불명은 제외+partial). 보고서는 측정 기간/기준선·모델·세션/메시지 수, input/output/cache-read/cache-creation, 관측 최대 처리 입력·캐시 읽기 비율·누락을 표시한다. 읽기 제한·잘린 기록·미지원 카운터는 partial/unknown이며 그래도 보고서를 만든다. 보고 호출 시점의 스냅샷이므로 이후 최종 응답 토큰은 포함되지 않는다.
- 다른 제공자·로그 부재는 네이티브 사용량 unavailable로 보고한다. CLI adapter 보고서가 있으면 별도 범위로 함께 제시하고 두 합계를 더하지 않는다. 금액·구독 한도·절감률은 추정하지 않는다. 원문 프롬프트·도구 내용은 저장하지 않으며 숫자·모델·해시 식별자만 Git 로컬 runtime에 남긴다.
