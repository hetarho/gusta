---
name: haeram-report
description: >-
  이 세션에서 haeram-spec-creator 스킬(start-vibe·implement-task 등)을 실행한 뒤 "/haeram-report, haeram 스킬 개선점
  정리해줘"라고 부를 때만 사용한다. 그 실행에서 드러난 스킬·CLI 동작의 개선 사항을 근거와 함께 markdown 코드 블록 하나로
  돌려준다. 대상 프로젝트가 아니라 haeram-spec-creator 자체의 개선 보고이며 파일을 바꾸지 않는다.
---

# haeram-report — 스킬 동작 개선 보고

**역할: 회고자.** 이 세션에서 실행된 haeram-spec-creator 스킬과 CLI가 실제로 어떻게 동작했는지 돌아보고, 스킬셋 관리자에게 넘길 개선 보고서를 만든다. 대상 프로젝트의 코드·기획은 평가하지 않는다. 읽기 전용이다 — 파일·STATE·Git을 바꾸지 않고 하위 세션도 띄우지 않는다.

## 1. 전제와 근거
- 이 대화에서 haeram 스킬(start-vibe·start-design·ideation·create-architecture·create-ssot·update-ssot·create-task·implement-task·review-task·review-code·doc-review·create-narrative·manage-work·self-improve·self-improve-local·show-ab·haeram-init·haeram-setting·update-haeram-spec-creator)이 한 번 이상 실행됐는지 대화 기록으로 확인한다. 없으면 "haeram 스킬을 실행한 세션에서 불러 주세요" 한 줄만 답하고 끝낸다.
- 근거는 이 대화에 남은 것만 쓴다: 스킬 지시, 실행한 명령과 출력, 오류·재시도, 사용자의 교정·불만, 권한 창, 대기, 반복해서 읽은 파일. 남아 있지 않은 부분을 추측으로 채우지 않는다. 앞부분이 요약됐으면 notes에 적는다.
- 스킬 문장을 정확히 인용해야 할 때만 설치된 스킬 파일(`.claude/skills/<name>/` 또는 `.codex/skills/<name>/`)의 해당 절만 읽는다. 버전은 설치된 CLI의 `--version`으로 한 번 확인한다.

## 2. 무엇을 찾는가
기준은 패키지 철학이다 — 사람은 고르기만 하고, 문서가 먼저이며, 토큰은 적게, 구현은 빠르게.

| kind | 신호 |
|---|---|
| bug | CLI 오류·잘못된 출력, 지시대로 했는데 실패한 명령 |
| instruction | 모호하거나 서로 충돌하는 문장, 빠진 절차, 스킬 사이 중복 |
| tokens | 큰 파일 전체 읽기·반복 읽기, 긴 출력을 통째로 받음, 하위 세션에 맡길 일을 직접 함 |
| time | 불필요한 전체 검사·대기·폴링·재시도 |
| human | 사람이 판단이 아닌 일(반복 확인·권한 창·타이핑)에 시간을 씀, 맡김이 멈춤 |
| missing | 스킬·CLI에 없어서 우회한 기능 |

- 스킬이 분명히 지시했는데 모델이 어긴 것은 "지시 준수 실패"로 적고, 문장을 더 눈에 띄게 해야 할 때만 제안한다.
- 제안은 문장을 늘리기보다 줄이거나 바꾸는 쪽, 규칙을 한 곳(정본)에 두는 쪽을 먼저 고른다. 결정론적인 일은 CLI로 옮기는 안을 함께 검토한다.
- severity: P1=잘못된 결과·데이터 손실·맡김 정지, P2=상당한 토큰·시간 낭비나 반복 혼란, P3=사소함.

## 3. 익명화
보고서는 haeram-spec-creator 저장소로 넘어간다. 대상 프로젝트의 이름·도메인·업무 규칙·실제 결정/태스크 ID·코드·경로·비밀값을 넣지 않는다. `<project>`, `T###`, `<domain rule>`처럼 일반화하고 수치·명령 형태·스킬 위치만 남긴다.

## 4. 반환
대화 언어로 쓴다. 코드 블록 밖에는 한 줄 요약만 둔다. 블록은 백틱 4개(````markdown)로 열어 안의 인용이 깨지지 않게 하고, findings는 severity 순으로 쓴다. 개선 사항이 없으면 findings에 `- none — <확인한 범위>`만 쓴다.

````markdown
# haeram-report <YYMMDD>
> version:<x.y.z> | agent:<도구> <model> | mode:<함께|맡김|-> | skills:<실행된 스킬, 순서대로>

## findings
### 1. <한 줄 제목>
- where: <skill>/<절 또는 references 파일> | CLI `<command>`
- kind: <kind> · severity: <P1|P2|P3>
- observed: <이 세션에서 실제로 일어난 일 — 명령·출력 요약, 횟수·시간>
- expected: <스킬·철학상 기대한 동작>
- cause: <확인한 원인, 확인 못했으면 "추정: ...">
- suggestion: <바꿀 문장·CLI 동작을 구체적으로>

## notes
- <근거의 한계: 요약된 구간, 확인하지 못한 것>
````
