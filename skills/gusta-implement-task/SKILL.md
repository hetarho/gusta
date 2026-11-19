---
name: gusta-implement-task
description: >-
  spec/tasks/의 태스크 하나를 구현·검증하고 마감하는 내부 스킬. gusta-start와 작업 묶음 워커가 부른다 — 남은 태스크를 맡기려면 /gusta-start.
---

# gusta-implement-task — 태스크 구현

**역할: 엔지니어.** SSOT·ARCH대로 구현한다. 기획 공백은 gusta-update-ssot, 기술 결정 누락은 gusta-create-task로 올리고 코드로 정하지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

## 1. 선택과 브리핑
`work status --json`이 worker/group/reviewer이거나 남은 태스크를 맡긴 요청에 활성 묶음·todo `lane:`이 있으면 [작업 묶음 절차](references/work-group.md)를 따른다. 단독이면 `vibe status --tag <tag> --json`의 `runnable` 하나를 고른다.
- 직접 호출이면 먼저 `vibe beat --tag <tag> --mode pair`로 세션을 등록하고, 마치면 `--end`.
- 선점·doing은 `vibe task start T### --tag <tag>`로만 한다(거절되면 다른 후보). 바뀐 doing은 첫 작업 커밋에 담는다. 시작 HEAD를 `$GUSTA_DIFF_BASE`로 둔다(반복기는 이미 설정).
- brief(`vibe brief T###`, 실행기 안에서는 주어진 것)의 issues부터 처리한다 — `[x]`는 규칙이 아니고, `[?]`에 기대는 구현은 기획 결정이 먼저다.

## 2. 신선도
brief의 stale-base·history가 델타다. 무관하면 base만 갱신한다. 영향이 있으면 todo로 되돌리고(`vibe beat --tag <tag> --doing -`) `vibe log` 후 gusta-create-task로 갱신한다. 완료 전 관련 rev만 다시 확인한다.

## 3. 구현
- **낮은 결합·높은 응집**: 한 모듈 한 책임, 바깥 세계(DB·네트워크·파일·시간·난수)는 경계에서 주입한다. 테스트가 무거워지면(실제 서비스·큰 fixture·timeout 상향) 테스트가 아니라 touches 안의 구조를 고쳐 순수 로직을 분리한다.
- 새 함수·타입·상수 전에 `rg`로 기존 것을 찾아 재사용한다(impl notes의 공용 위치 우선). 조정 가능한 수치는 정의된 설정을 이름으로 읽고(impl notes에 숫자가 있어도), 새 설정은 실제로 읽히게 연결한다.
- touches 밖은 고치지 않고 result limits에 남긴다 — 단독의 공용 helper 이동만 예외다(limits에 적는다). 결정을 적용해야 하는데 어느 태스크에도 없는 대상은 inbox `suggest`로 올리고 `[v]`로 체크하지 않는다.
- 단독 구현을 서브에이전트로 나누지 않는다.
- explore는 시작 시각·timebox를 기록하고 측정값을 result에 쌓다가, 시간이 다 되면 exit대로 끝낸다.

## 4. 검증
① 구현·인계 acceptance 확인 ② 바뀐 범위의 작은 결정론적 검사와 빠른 ARCH task 명령을 커밋 직전 한 번 `vibe check --tier task`로(`--diff-base <시작 SHA> --task T### -- <command>`, 실패하면 고친 범위부터, 편집마다 반복하지 않는다) ③ spec lint — 오류·경고는 고치고 reviewHints는 next의 gusta-doc-review나 limits로 ④ 공동 최종 검수·CI는 owner에게 인계([검증 절차](../gusta-start/references/verification.md)). 긴 명령은 완료 알림을 기다린다(sleep→조회 반복 금지).
- 검사 전에 `git diff $GUSTA_DIFF_BASE`를 한 번 훑어 3절 위반·읽히지 않는 설정/export·틀린 주석·반복을 고친다.
- 결정론적 검사는 기존 증거를 재사용하고 실제 불변식 공백만 작은 fixture로 보완한다. 테스트 분류는 스크립트 이름이 아니라 격리 범위·의존성으로 한다.
- agent 화면 AC는 실제 computer use로 관찰해 기록한다. 도구가 없거나 owner가 host·stage가 integration이면 not-run·이유·담당자(capable host)로 인계한다 — pass를 꾸미거나 E2E를 덧붙이지 않는다.
- acceptance가 done 전 전체 스위트 성공을 요구하면 통과로 체크하지 말고, 최종 관문 인계로 바꾸는 안을 gusta-create-task(묶음은 조정자)로 승인받는다 — 승인된 예외는 따르고 미승인·미지원이면 parked.

## 5. 마감
`vibe task start`로 선점한 단독 태스크는 이 순서로만 닫는다(st·아카이브·STATE를 손으로 고치지 않는다).
1. 충족한 acceptance는 `[v]`로 체크한다(`[x]` 아님). 인계한 AC로 blocked하지 않고 닫는다. 관찰 pass를 done 조건으로 쓴 acceptance는 gusta-create-task로 인계 기준으로 고친다.
2. result 네 줄 `- outcome:` / `- at:` 검증 SHA / `- verified:` 실제로 돌린 검사 / `- limits:` 한계 또는 `-`와 `- agent-acceptance:`를 쓴다. 이후에도 지킬 계약은 result에 묻지 말고 gusta-update-ssot로 올린다.
3. `vibe task done T### --tag <tag> [--at <sha>]`.
4. 출력 files와 관련 변경만 커밋한다(gusta-start 밖에서는 요청받았을 때만, push는 gusta-start 몫).
