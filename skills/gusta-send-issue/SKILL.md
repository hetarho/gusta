---
name: gusta-send-issue
description: >-
  이 세션에서 gusta 스킬(gusta-start·gusta-implement-task 등)을 실행한 뒤 "/gusta-send-issue, gusta 스킬 개선점
  이슈로 보내줘, gusta에 개선점 제보해줘"라고 부를 때만 사용한다. 그 실행에서 드러난 스킬·CLI 동작의 개선 사항을 근거와 함께
  익명화해 보여 주고, 사용자가 확인하면 gusta 저장소(hetarho/gusta)에 GitHub 이슈로 올린다. 대상 프로젝트가 아니라 gusta 자체의
  개선 보고이며 대상 프로젝트의 파일은 바꾸지 않는다.
---

# gusta-send-issue — 스킬 동작 개선 이슈 보내기

**역할: 회고자.** 이 세션에서 실행된 gusta 스킬과 CLI가 실제로 어떻게 동작했는지 돌아보고, 스킬셋 관리자에게 넘길 개선 보고서를 만들어 gusta 저장소 `hetarho/gusta`에 이슈로 보낸다. 대상 프로젝트의 코드·기획은 평가하지 않는다. 대상 프로젝트에는 읽기 전용이다 — 파일·STATE·Git을 바꾸지 않고 하위 세션도 띄우지 않는다. 바깥으로 나가는 쓰기는 사용자가 확인한 이슈 하나뿐이다.

## 1. 전제와 근거
- 이 대화에서 gusta 스킬(gusta-start·gusta-design-mode·ideation·gusta-create-architecture·gusta-create-ssot·gusta-update-ssot·gusta-create-task·gusta-implement-task·gusta-review-task·gusta-review-code·gusta-doc-review·gusta-create-narrative·gusta-manage-work·gusta-self-improve-remote·gusta-self-improve·gusta-showcase·gusta-init·gusta-preference·gusta-update)이 한 번 이상 실행됐는지 대화 기록으로 확인한다. 없으면 "gusta 스킬을 실행한 세션에서 불러 주세요" 한 줄만 답하고 끝낸다.
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
보고서는 공개 저장소 `hetarho/gusta`의 이슈로 누구나 보게 된다. 대상 프로젝트의 이름·도메인·업무 규칙·실제 결정/태스크 ID·코드·경로·비밀값을 넣지 않는다. `<project>`, `T###`, `<domain rule>`처럼 일반화하고 수치·명령 형태·스킬 위치만 남긴다.

## 4. 미리보기와 확인
대화 언어로 쓴다. 이슈 제목 한 줄과 본문 블록을 보여 준다. 블록은 백틱 4개(````markdown)로 열어 안의 인용이 깨지지 않게 하고, findings는 severity 순으로 쓴다. 개선 사항이 없으면 findings에 `- none — <확인한 범위>`만 쓰고 이슈는 올리지 않는다.

- 제목: `[send-issue] <가장 심각한 finding 제목>`(finding이 더 있으면 ` (+N)`).
- 블록 아래에 한 번만 묻는다: "이 내용으로 hetarho/gusta에 이슈를 올릴까요? (고칠 곳이 있으면 말해 주세요)". 고치라고 하면 고쳐서 다시 보여 준다.
- 확인을 받기 전에는 올리지 않는다. 답할 사람이 없는 세션(맡김·실행기 단위)이면 올리지 않고 블록만 남긴다.

````markdown
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

---
version:<x.y.z> | agent:<도구> <model> | mode:<함께|맡김|-> | skills:<실행된 스킬, 순서대로>
````

## 5. 올리기
- `gh auth status`로 GitHub CLI 로그인을 한 번 확인한다. 되어 있으면 본문을 파일로 쓰지 않고 표준 입력으로 넘긴다: `gh issue create --repo hetarho/gusta --title '<제목>' --body-file - <<'EOF'` … `EOF`(본문은 블록 안쪽만, 펜스 제외). 라벨은 붙이지 않는다(저장소에 없으면 실패한다).
- 성공하면 gh가 출력한 이슈 URL 한 줄로 끝낸다. 실패하면 오류 요약과 함께 아래 대체 경로로 넘긴다.
- `gh`가 없거나 로그인이 안 돼 있으면 로그인·설치를 대신하지 않는다. `https://github.com/hetarho/gusta/issues/new`에 제목과 위 본문을 붙여 넣으라고 한 줄로 안내하고 끝낸다.
