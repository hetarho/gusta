# 빠른 구현을 위한 검증 계약

프레임워크 기본 절차다. 적용되는 프로젝트 지침·활성 문서가 다른 주체·시점·발행을 요구하면 [프로젝트 규칙 대조](../../gusta-update/references/project-rules.md)대로 원문·변경안·영향을 보여 주고 기본 절차로 맞춰도 괜찮은지 묻는다. 이미 구체적으로 승인한 변경은 다시 묻지 않고, 맡김에서는 미승인 차이를 parked로 남긴다.

## 단계

| 단계 | 범위 | 누가·언제 | 작업 묶음 |
|---|---|---|---|
| task | 바뀐 범위의 영향 단위 테스트·빠른 정적 검사 | 구현 세션·워커가 하위 브랜치에서 커밋 직전 한 번(`vibe check --tier task`) | `--task-verify` |
| 단위 통합 | 빠른 통합 검사 | CLI가 단위 통합마다 | `--verify` |
| batch | 결정론적 전체 검수 | 살아 있는 참여 세션이 모두 ready인 고정 후보에서 한 소유자가 한 번 | `--group-verify` |
| 단계 검사 | batch 명령 그대로 | 시간 한도 loop에서 태스크 N개마다 CLI가 그 커밋을 백그라운드로(`vibe loop --dry-run`의 `phaseGates`). 두 번 실패하면 fix-gate 태스크가 다음 단위다 — 조기 경보일 뿐 batch를 대신하지 않는다 | — |
| CI | 위험을 입증하는 최소 자동 브라우저 E2E·선언한 지원 브라우저 호환 검사 | 실제 push마다 원격 CI | — |

- 기존 행동 증거로 충분하면 새 테스트를 만들지 않는다. 검사 분류는 명령 이름이 아니라 실제 의존성·브라우저 행렬로 한다.
- 각 AC는 주 검증 방법 하나와 owner·stage를 갖는다. computer-use agent acceptance는 고른 E2E/명령 범위를 제거·축소한 뒤 그 자리를 맡는다 — [기록 형식](agent-checks.md).
- 리뷰 세션은 기존 증거와 필요한 빠른 재현만 확인한다. 전체 검사나 이미 대체한 E2E·agent 검사를 다시 띄우지 않는다.
- 기존 활성 묶음도 승인된 매핑으로 `work configure`한다. 세션 종료·태스크 done은 공동 통합 완료가 아니다.

## 검사 계획

ARCH 단계별 명령으로 충분하면 그대로 쓴다. 독립 검사 여러 개가 한 스크립트에 묶여 부분 성공을 잃으면 프로젝트 안의 JSON 계획을 ARCH 검증 결정의 `plan:` 하위 줄에 백틱 경로로 연결한다(`vibe check --plan <경로> --tier task|batch`로도 실행한다).

```json
{"schemaVersion":1,"checks":[{"id":"unit","tier":"task","command":"npm run test:unit","inputs":["src/","test/**","package.json"]}]}
```

- `tier`는 `task|batch|ci`다. `ci`는 원격 인계 정보이고 로컬에서 돌리지 않는다.
- `inputs`에는 명령이 읽는 코드·테스트·스크립트·설정·의존성·생성 입력을 프로젝트 상대 경로로 적는다. 모르면 생략한다(전체 트리). ignore된 설정 파일이 입력이면 리터럴 경로로 적는다.
- 계획을 선언하면 모든 단계가 정해진다. 빈 단계에 명령을 추론해 넣거나 설명문에서 명령을 추측하지 않는다. 단계별 명령을 함께 적었으면 계획과 일치시킨다.
- `declared:false`·`partial:true`나 지침에만 남은 명령은 실행 전에 연결하거나 미지원 범위로 명시한다.

## 공동 마감

1. 세션 worktree에서 `vibe integration status --tag <tag>`로 공유 상태를 보고 `vibe integration ready --tag <tag>`로 제출한다. 보이지 않는 기기까지 안다고 주장하지 않고, 원격 불명·미발행·stale을 완료로 세지 않는다.
2. loop·묶음 마감 또는 `vibe integration finish --tag <tag>`가 모두 ready인 참여자로 후보를 고정해 한 번 검수한다. 대기 응답의 세션별 원인과 `nextAction`대로 한다. 관문 밖에서 이미 반영됐거나 다시 제출하지 않을 세션은 소유자가 `vibe integration withdraw --participant <id>`로 닫는다(맡김은 withdraw하지 않는다).
3. `waiting-agent`면 도구가 있는 시작/검증 세션이 영수증의 정확한 candidate에서 computer use로 관찰하고, token·candidate·checks JSON을 `vibe integration accept --file <JSON>`으로 낸 뒤 `vibe integration finish --tag <tag>`로 잇는다. 끝난 결정론적 검사는 다시 돌리지 않는다.
4. 검수된 후보만 SETTINGS land·land-via·push대로 반영된다. 원래 checkout을 전환하거나 force push로 동시 변경을 덮지 않는다.

spec lint 경고는 막힘 사유가 아니라 할 일이다. 기준에 있던 경고는 단위 통합 결과의 `specWarnings`로 온다. 시작 대화는 ready 제출 전에 `gusta lint` 경고 정리를 한 조각(새 하위 세션)에 맡긴다 — 경고가 가리키는 문서의 소유 스킬대로(STATE·태스크 정합은 gusta-implement-task 마감, base<rev는 gusta-create-task, SSOT 참조·pending은 gusta-update-ssot, SSOT 형식은 gusta-doc-review) 고치고, 사람 판단이 필요한 것만 경고 원문과 함께 parked로 남긴다. 예산 안에 못 고친 수는 보고서 checks에 남긴다.

## 실패 뒤

- 관문 실패는 결과 `next`대로 실패·영향·미실행 범위만 고친다. 고친 부분을 `vibe check --tier task --diff-base <관문 커밋>`으로 먼저 확인하고 같은 계획의 유효한 성공은 재사용한다. 전체 재실행은 실제 입력·정책 변경 같은 무효화 근거가 있을 때만 한다.
- 실패 재현용 빌드·e2e는 `--heavy`로 한 번에 하나씩, 다른 검사와 동시에 돌리지 않는다.
- 범위 밖 문제는 보고서 limits와 inbox(`suggest` 또는 다음 태스크)로 분리한다.
- 밖에서 land가 움직였으면 반영을 보류·재조정하고 자동 병합·전체 검수 초기화를 반복하지 않는다.
- 실행기가 끝나도 수동 복구는 같은 `--tag`·원래 마감을 잇는다.
- 미완료를 통과로 바꾸거나 하드 관문·권한을 우회하지 않는다.

## CI

실제 push마다 `vibe ci wait --commit <sha> --diff-base <묶음 시작 SHA> --json` 한 번(또는 push `--wait-ci`)으로 기다린다 — Claude는 셸 백그라운드+완료 알림, Codex는 긴 timeout의 단일 블로킹 호출이고 sleep→조회 반복은 하지 않는다. 같은 SHA에서 이미 통과한 CI·릴리스 증거는 재사용한다. `unchecked`면 보고서 next에 `check CI later: <sha> <checkUrl>`로 남기고 진행한다. 맡김에서 CI 실패는 근거를 담은 수정 태스크를 만들어 **다음 단위로 우선 실행**한다(만들기만 하고 끝내지 않는다).
