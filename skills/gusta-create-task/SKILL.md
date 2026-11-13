---
name: gusta-create-task
description: >-
  엔지니어 역할로 SSOT 변경분(STATE pending)과 채택된 리팩토링 finding(spec/review/,
  st:ready)을 구현 태스크(spec/tasks/T###.md)로 분해하는 내부 스킬. gusta-sketch가 기획
  마지막에, gusta-start가 요청 실행·실행 중 공백을 메울 때 부른다 — 사용자가 직접 부르지 않는다. STATE의
  rev/tasked 차이와 SSOT chg로 무엇이 새로 생겼고 어디가 바뀌었는지 스스로 파악한다. 개발 관점 질문만
  한다(데이터 모델·API·엣지·마이그레이션). 구현은 gusta-implement-task.
---

# gusta-create-task — SSOT 델타 → 태스크

**역할: 엔지니어.** SSOT의 기획 결정은 재논의하지 않는다. SSOT가 모호하거나 모순이면 추측으로 메우지
말고 gusta-update-ssot로 올린다. 단독 맡김이면 추천안을 반영한 뒤 분해를 잇고, 직접 호출(gusta-sketch 등)은 확인을 요청하며 묶음 워커는 기획 공간으로 인계한다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 gusta-create-architecture 실행을 안내한다. `settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 문서 상태를 STATE에, 세션 기록(시작·상태 변화·활동)을 `vibe` 명령으로만(`beat`·`claim`·`inbox`·`log`) 남기고 SESSIONS.md를 직접 고치지 않는다. 워커는 STATE·SSOT·세션 기록 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 inbox(`vibe inbox add`)와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.
5. **읽기**: status 요약·`vibe brief <T###|ID-n|ID@rev> --summary`로 필요한 범위를 찾는다. 큰 brief는 `--section decisions|tasks --offset <n> --limit <n>`으로 원문 블록째 읽고 모든 필요 블록의 coverage를 확인한다. 전체 brief의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 보고서도 필요한 절만 읽고, 출력은 요약·tail, 전체 로그는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`).

## 1. 스코프와 델타
입력은 두 종류다 — **SSOT 델타**(기획 변경)와 **리뷰 finding**(사용자가 채택했거나 명시적 위임 범위에서 gusta-self-improve-remote/gusta-self-improve 오케스트레이터가 채택한 개선). 사용자가 지정하지 않으면 둘 다 처리한다. 자율 채택은 review notes의 정책 참조 또는 로컬 호출 위임·승인 범위·동작 보존 근거를 확인하며, 큰 변화나 근거 없는 [o]는 태스크화하지 않고 [?]로 돌려 인계한다.
- SSOT: 사용자가 지정한 도메인, 없으면 STATE ssot에서 pending 있는(= tasked < rev) 전부. `vibe log --text 'gusta-create-task <IDs> start'`.
  - 델타 파악: `vibe brief <ID>@<tasked>`가 chg의 tasked+1..rev 줄과 바뀐 결정 원문·필수 의존·flow·constraints를 준다. tasked=0이면 도메인 전체가 신규(`vibe brief <ID>`). ARCH의 관련 결정도 읽는다(태스크가 따를 기준). 태스크 인용줄 ssot에는 구현이 지켜야 하는 결정을 빠짐없이 넣는다 — 같은 도메인의 제약·예외·금지를 담은 결정도. 인용 결정이 `→!`·`→=`로 가리키는 결정은 brief가 함께 싣지만, 연결되지 않은 결정은 cfg brief가 `cited`일 때 brief에 들어가지 않는다.
  - 델타가 코드에 영향이 없으면(문구 정리, 컨벤션 서술 변경 등) 태스크 없이 소화한다: ssot `tasked=rev`·pending `-`, `vibe log --text '<ID> rN..rM no-op (no code impact)'`. 영향 여부가 확실하지 않으면 태스크를 만든다.
- 리뷰: spec/review/에서 st:ready인 문서(사용자가 `review/<slug>`를 지정하면 그것만). 대상은 `→T###`가 아직 없는 [o] finding — [x]·[?]는 건드리지 않는다. `vibe log --text 'gusta-create-task review/<slug> start'`.

## 2. 개발 인터뷰 (필요한 것만)
ARCH·SSOT·기존 코드에 답이 있으면 묻지 않는다. 영역: 데이터 모델/스키마, API·인터페이스 계약, 상태·에러·엣지 처리, 기존 데이터 마이그레이션, 성능·보안 요구, 테스트 범위.
맡김은 level과 무관하게 추천안으로 결정하고 inbox decided에 남긴다. 아래 인터뷰는 직접 호출(gusta-sketch 등)에만 적용한다.
- **expert**: 설계 초안을 제시하고 세부를 직접 확인. "스키마 이 초안으로? 인덱스는? 소프트 딜리트?"
- **mid**: 갈림길마다 선택지 + 트레이드오프 1줄.
- **novice**: 기술 질문 금지. 결과 수준만 확인("기존에 저장된 글은 그대로 보여야 하죠?"). 나머지는 AI가 결정하고 근거를 구현메모에 남긴다.

## 3. 분해
- 크기: 태스크 1개 = 구현 세션이 **추가 질문 없이** 처음부터 끝까지 완주할 수 있는 단위. 그러기 위해 필요한 결정은 전부 이 단계에서 끝내 impl notes에 담는다 — 구현 중 질문이 생기면 분해 실패다.
- 크기 상한은 새 세션 하나에 넉넉히 들어가는 양: 관심사 하나·모듈 경계 하나, 테스트를 뺀 touches 5개 이하, 단위 상한(기본 60분) 안. 쓴 뒤 `vibe brief T### --json`의 `size.budget.over`(brief 40k자·touches 기준)가 비어 있지 않으면 도메인·모듈별로 쪼갠다. 큰 파일은 impl notes에 읽을 범위(함수·구간)를 적는다. 기준 창은 `gusta agents --json`의 `minContext`다.
- **실행 추천 `run:`**: `gusta agents --json`의 options는 싼 순서다 — `allowed` 중 이 태스크를 완주하기에 충분한 첫 조합을 쓴다. 어려운 설계 판단·여러 모듈 계약은 높은 score, 기계적 변경·문서·작은 수정은 낮은 score. 높은 조합이 필요해 보이면 먼저 쪼갤 수 있는지 보고, score 9 이상이면 impl notes에 이유 한 줄. `agents`가 미정이면 `run:-`으로 두고 inbox `suggest`로 gusta-init을 권한다.
- **탐색형(explore)**: 보정·튜닝·밸런스처럼 돌려 보고 측정해서 정하는 일은 일반 태스크와 분리해 explore 태스크로 만든다. 인용줄 `explore:<시간>`(예 `explore:2h`)이 시간 제한이고, acceptance에 `- [ ] exit: <시간이 다 되면 무엇을 기록하고 done인지>`를 반드시 넣는다(lint 오류로 강제). 기준 밴드를 "모두 통과"로 완료 조건 삼지 않는다 — 기준은 측정 대상이고 끝은 exit가 정한다. 기준을 못 맞출 때 규칙을 바꿔야 한다면 그건 gusta-update-ssot 거리라고 impl notes에 적는다. explore 태스크와 그 후속은 메인 세션에서 실행되므로 lane에 넣지 않는다.
- **작업 묶음(lane)**: 단독 진행이면 lane을 쓰지 않는다(`lane:-`). 여러 세션·worktree가 병렬로 진행할 묶음을 설계할 때만 [기반 → 줄기 → 통합](references/lanes.md)을 읽는다.
- acceptance에는 그 변경을 검증하는 테스트가 포함된다. 예외는 ARCH에 테스트 제외 [o] 결정이 있을 때뿐. 테스트는 파일·케이스 이름과 실행 단계로 적는다. acceptance·검증 줄에는 태스크 단계 검사(바뀐 범위의 테스트·빠른 정적 검사)만 쓴다 — 빌드·통합·e2e·전체 스위트는 적지 않고 최종 관문(ARCH batch/묶음)이 한 번 실행한다. 통합/e2e 테스트도 구현할 때 함께 고치고 result limits에 묶음 실행 대상을 남기게 한다. 테스트 분류는 이름이 아닌 격리 범위와 의존성으로 판단하고 단위 검사는 작은 fixture로 독립 검증하게 한다.
- 명령이 실제로 실행하는 스크립트·테스트 범위를 읽는다. 기본 task acceptance는 구현·영향 검사·필요한 인계 완료이며, 뒤에 실행할 전체 스위트의 성공을 done 선행 조건으로 만들지 않는다. 전체 범위·성공 증거는 실제 실행될 ARCH batch/묶음 최종 관문에 등록하고 인계 경로를 남긴다. 기존 "done 전 전체 검사 통과"를 바꾸려면 [규칙 대조](../gusta-update/references/project-rules.md)로 완료 시점·주체 변경을 승인받아 활성 계약과 최종 관문을 함께 맞춘다(진행 중이면 중단·해제 후 재기획). 미승인·미지원이면 해당 변경은 parked이며 미실행 검사를 통과로 쓰지 않는다.
- **경계를 따라 나눈다**: 태스크는 ARCH의 모듈 경계 안에서 응집된 변경으로 만든다. 여러 모듈을 가로지르면 계약(타입·인터페이스)을 먼저 만드는 태스크와 모듈별 태스크로 나눈다. 바깥 의존(DB·네트워크·시간 등)을 받는 주입 지점을 impl notes에 적어 acceptance의 단위 테스트가 실제 서비스 없이 돌게 한다.
- **공용 코드**: 여러 태스크가 쓰는 helper·타입·검증·정규화 같은 공통 판단은 처음 필요한 태스크가 공용 위치(기존 모듈 또는 새 공용 파일)에 만들게 한다 — impl notes에 위치와 이름을 적고 그 파일을 touches에 넣는다. 뒤 태스크의 impl notes는 그 이름으로 가리킨다(예 `normalize from validation.ts`). touches를 태스크 자기 파일로만 좁혀 같은 helper를 파일마다 만들게 두지 않는다. 단독 진행에도 적용한다(작업 묶음의 기반 단계와 같은 원리).
- **수치**: 조정할 값은 설정 이름으로 적고 숫자는 그 설정을 정의하는 태스크에만 둔다(예 `RETRY_CONFIG.maxAttempts`, `3` 아님). 다른 태스크가 정의한 값을 쓰는 태스크에는 읽을 설정 이름을 적는다 — impl notes의 숫자는 구현에 그대로 박힌다.
- 리뷰 태스크: finding 하나 = 태스크 하나가 기본. 같은 파일·같은 원인이면 묶고, 한 세션에 못 끝낼 finding은 쪼갠다. 인용줄·impl notes 첫 줄·동작 불변 acceptance는 FORMAT review-sourced tasks대로 쓰고 finding이 요구하는 테스트를 더한다. 기획 결정을 바꾸는 태스크는 만들지 않는다 — 그런 finding은 gusta-update-ssot로 넘기고 [?]로 되돌린다.
- impl notes의 결정 중 **이후 변경이 계속 지켜야 하는 계약**(공개 API 형태, 저장 포맷, 호환성 규칙)은 태스크에만 두지 않는다 — 그건 기획·기준 문서의 몫이니 gusta-update-ssot(또는 ARCH 개정)를 제안하고, 태스크에는 이번 구현이 따를 형태만 남긴다.
- dep 그래프와 순서를 정리한다. 자기참조·순환은 금지하고 태스크 인용줄과 STATE의 dep을 일치시킨다. dep은 표의 활성 태스크 또는 `tasks/done/`의 완료 태스크를 가리킬 수 있고, 채번은 `vibe plan-sync` 직후 tasks/done/까지 포함한 최대 번호+1 — 이때 완료 태스크는 **파일명 목록만** 본다(내용 정독은 특정 태스크를 조사할 때뿐, FORMAT Reading). 기존 todo 태스크와 겹치면 todo는 수정(base 갱신), doing·done(작업 묶음이면 STATE todo라도 `work board`의 활성 attempt 포함 — 재분해는 작업자 중단·해제 후)은 불변 — 후속 태스크로 만든다.

## 4. 마감
- 태스크마다 이 스킬 폴더의 assets/task.md를 복사해 `tasks/T###.<slug>.md`로 채운다(`<...>` 전부 교체) → STATE: tasks 행 추가(리뷰 태스크의 ssot 셀은 `ARCH`), next=`gusta-implement-task T###`(dep상 첫 것). `vibe log` 1줄.
- SSOT에서 만든 태스크: ssot 행 `tasked=rev`·pending `-`.
- 리뷰에서 만든 태스크: 문서의 finding 끝에 `→T###`, 모든 [o]가 전환되면 문서 st→`converted@YYMMDD` + STATE review 행 갱신. ssot 행(tasked·pending)은 건드리지 않는다.
- 보고: 태스크 목록과 순서 — novice에겐 각 태스크가 무엇을 만들어내는지 한 줄씩 설명.
