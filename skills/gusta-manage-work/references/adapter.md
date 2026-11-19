# command 어댑터 규약

기본 Codex·Claude 어댑터 밖의 실행기를 `work run --adapter /absolute/path/adapter.json`으로 연결할 때 쓴다. provider/model CLI 옵션과 함께 쓰지 않는다.

```json
{
  "command": "node",
  "args": ["/absolute/path/my-agent-adapter.mjs"],
  "timeoutMs": 3600000,
  "maxDispatches": 200,
  "maxTaskRuns": 3
}
```

command는 셸을 거치지 않고 실행된다. 상대 command 경로는 설정 파일 기준이고 args의 경로는 절대 경로를 권장한다. 작업마다 지정 workspace에서 새 프로세스가 뜨며, 같은 세션 유지·모델·reasoning 설정은 어댑터가 정한다. 워커 수는 동시 실행 슬롯 수이지 고정된 대화 세션 수가 아니다.

## stdin

JSON 객체 한 줄이다:
- `schemaVersion:1`, `dispatchId`, `role:worker|reviewer`, `slot`, `group`, `attempt`, `taskId`(이번 태스크), `tasks`(단위 전체), `lane`, `workspace`, `groupBranch`.
- `instruction`: 역할과 완료 절차. command 어댑터의 worker는 commit까지, reviewer는 결과 JSON 반환까지 한다. submit/review-finish는 runner 몫이니 호출하지 않는다.
- `verify`: 단위 통합 검증 명령 배열, `taskVerify`: 태스크 제출 때 호스트가 실행할 명령 배열(빈 배열 가능). `cliCommand`: 현재 패키지 CLI의 실행 파일과 절대 경로 인자 배열 — 여기에 `boardCommand`를 이어 붙여 최신 상태를 읽는다.
- `correction`: 수정 요청 재배정이면 이전 리뷰와 findings, 아니면 null.
- `mode`: `autopilot`이면 질문에 답할 사람이 없다. `resume`: 이어 쓸 세션 ID(없으면 null), `sessionFile`: 새 세션 ID를 알게 되는 즉시 써 둘 파일. `directive`: 조정자 메모나 timeout 뒤 이어 가기 안내(`note`). `allowTools`: 워커가 묻지 않고 실행할 도구 규칙. `brief`: 태스크·결정 원문 블록(필수 의존·전역 규칙 포함)·flow·constraints·history·출처(경로·rev·sha256)·issues·검증 명령. `risk`: 리뷰어에게 넘기는 위험 이유.
- `review`: 리뷰 배정이면 id, submissionId, commit, baseCommit, workspace, owner. 아니면 null.

## stdout

최종 JSON 객체 하나만 출력하고 진행 로그는 stderr로 보낸다. 실행 도구의 JSONL/마크다운 출력은 어댑터에서 이 형식으로 바꾼다 — raw CLI 출력을 그대로 넘기지 않는다. 형식이 맞지 않거나 종료 코드가 실패면 완료로 취급되지 않는다.

```json
{"outcome":"completed","summary":"Implemented and committed the task."}
```

- 막히면 `{"outcome":"blocked","summary":"Reason and required decision."}`. 기획 결정만이 문제면 `"decision":{"question":"...","options":["..."],"recommendation":"..."}`를 더한다 — 실행기가 진행분을 WIP 커밋으로 남기고 결정 요청으로 기록한 뒤 다른 단위를 계속한다.
- 리뷰어는 gusta-review-task의 JSON 형식(`verdict`, `summary`, `findings`)을 반환한다.
- completed여도 runner가 실제 커밋·acceptance·spec 변경 범위와 검증 명령을 다시 검사한다.

규약 근거: [Codex 비대화형 실행](https://developers.openai.com/codex/noninteractive/), [Claude headless 실행](https://code.claude.com/docs/en/headless).
