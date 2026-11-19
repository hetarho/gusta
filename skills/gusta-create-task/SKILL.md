---
name: gusta-create-task
description: >-
  SSOT 변경분과 채택된 review finding을 구현 태스크(spec/tasks/)로 나누는 내부 스킬. 기획 스킬과 gusta-start가 부른다 — 사용자가 직접 부르지 않는다.
---

# gusta-create-task — SSOT 델타 → 태스크

**역할: 엔지니어.** SSOT 결정은 재논의하지 않고, 모호·모순은 추측으로 메우지 말고 gusta-update-ssot로 올린다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`.

## 1. 스코프와 델타
입력은 **SSOT 델타**와 **채택된 리뷰 finding**이다(지정이 없으면 둘 다). 리뷰 finding은 [리뷰 태스크](references/review.md)대로 처리한다.
- SSOT: 지정한 도메인, 없으면 STATE ssot에서 pending 있는(tasked < rev) 전부. `vibe log --text 'gusta-create-task <IDs> start'`.
- 델타는 `vibe brief <ID>@<tasked>`(tasked=0이면 `vibe brief <ID>`)로 읽고, 태스크가 따를 ARCH 결정도 읽는다. 인용줄 ssot에는 구현이 지킬 결정을 빠짐없이 넣는다 — 같은 도메인의 제약·예외·금지 결정도.
- 코드 영향이 없는 델타(문구·컨벤션 서술 정리)는 태스크 없이 ssot `tasked=rev`·pending `-`, `vibe log --text '<ID> rN..rM no-op (no code impact)'`. 확실하지 않으면 태스크를 만든다.

## 2. 개발 인터뷰 (필요한 것만)
ARCH·SSOT·코드에 답이 없는 것만 묻는다(스키마·인터페이스 계약·에러/엣지·기존 데이터 마이그레이션·성능/보안·테스트 범위).
- **expert**: 설계 초안을 내고 세부를 확인("스키마 이 초안으로? 인덱스는? 소프트 딜리트?").
- **mid**: 갈림길마다 선택지 + 트레이드오프 1줄.
- **novice**: 기술 질문 없이 결과만 확인("기존에 저장된 글은 그대로 보여야 하죠?")하고, 나머지는 정해 근거를 impl notes에 남긴다.

## 3. 분해
- 태스크 1개 = 구현 세션이 **추가 질문 없이** 완주하는 단위다(필요한 결정은 여기서 끝내 impl notes에). 상한: 관심사 하나·모듈 경계 하나, 테스트를 뺀 touches 5개 이하, 단위 상한(기본 60분) 안. 쓴 뒤 `vibe brief T### --json`의 `size.budget.over`가 비어 있지 않으면 도메인·모듈별로 쪼갠다. `contextChars`가 크면 쪼개지 말고 gusta-doc-review로 SSOT를 줄인다. 큰 파일은 impl notes에 읽을 범위를 적는다. 기준 창은 `gusta agents --json`의 `minContext`다(null이면 위 상한만).
- **실행 추천 `run:`**: `gusta agents --json`의 options는 싼 순서다 — `allowed` 중 이 태스크를 완주하기에 충분한 첫 조합을 쓴다. 설계 판단·여러 모듈 계약은 높은 score, 기계적 변경·문서는 낮은 score. 높은 조합이 필요해 보이면 먼저 쪼갤 수 있는지 보고, score 9 이상이면 impl notes에 이유 한 줄. `agents`가 미정이면 `run:-`으로 두고 inbox `suggest`로 gusta-init을 권한다.
- **explore**: 측정해서 정하는 일(보정·튜닝·밸런스)은 `explore:<시간>`(예 `2h`) 태스크로 분리하고 acceptance에 `- [ ] exit: <시간이 다 되면 무엇을 기록하고 done인지>`를 둔다 — 끝은 기준 통과가 아니라 exit다. 규칙 변경이 필요하면 gusta-update-ssot 거리로 impl notes에 적고, lane에 넣지 않는다(후속 포함).
- **lane**: 단독이면 `lane:-`. 여러 세션의 병렬 묶음을 설계할 때만 [기반 → 줄기 → 통합](references/lanes.md)을 읽는다.
- **acceptance**: 관찰 가능한 동작·주 검증 방법·owner/stage를 템플릿 둘째 줄대로 적는다. acceptance·검증 줄에는 태스크 단계 영향 검사만 쓰고, 전체 검수는 공동 고정 후보, 지원 브라우저 호환 검사는 CI에 맡긴다 — 전체 스위트 성공·integration 관찰 pass는 done 조건이 아니라 ARCH batch/묶음 최종 관문에 둔다(명령이 실제로 돌리는 범위를 확인한다). 저위험 문구·스타일, 소스 문자열/구현 추종 테스트를 의무로 만들지 않는다. 프로젝트가 명시한 더 엄격한 의무는 [규칙 대조](../gusta-update/references/project-rules.md)로 승인받기 전까지 보존한다(미승인·미지원이면 parked).
- **전체 범위 결정**("모든" 화면·라우트·모듈): `rg`·라우트 목록으로 만든 대상 인벤토리를 마지막 태스크 impl notes에 두고, 항목마다 담당 태스크의 touches나 제외 이유가 있어야 분해가 끝난다. 제품 코드를 touches에 갖지 않은 감사 태스크는 준수를 체크하지 않고 빠진 항목을 inbox `suggest`로 올린다.
- **경계**: ARCH 모듈 경계 안의 응집된 변경으로 만들고, 여러 모듈을 가로지르면 계약(타입·인터페이스) 태스크를 먼저 둔다. 바깥 의존(DB·네트워크·시간 등)의 주입 지점을 impl notes에 적는다.
- **공용 코드**: 여러 태스크가 쓰는 helper·타입·검증·정규화는 처음 필요한 태스크가 공용 위치에 만들고(impl notes에 위치·이름, touches에 그 파일), 뒤 태스크는 그 이름으로 가리킨다(예 `normalize from validation.ts`).
- **수치**: 조정할 값은 설정 이름으로 적고(예 `RETRY_CONFIG.maxAttempts`, `3` 아님) 숫자는 그 설정을 정의하는 태스크에만 둔다.
- 이후 변경도 지킬 계약(공개 API 형태·저장 포맷·호환성)은 태스크에만 두지 않고 gusta-update-ssot(또는 ARCH 개정)를 제안한다.
- **dep·채번**: dep(인용줄과 STATE에 같게)은 활성 태스크나 `tasks/done/` 완료 태스크(파일명만 본다)를 가리킨다. 번호는 `vibe plan-sync` 직후 `vibe task reserve --tag <tag> --count <n>`이 준 것을 쓴다. 기존 todo와 겹치면 todo를 고치고(base 갱신), doing·done(묶음이면 `work board`의 활성 attempt 포함)은 두고 후속 태스크로 만든다.

## 4. 마감
- 태스크마다 이 스킬 폴더의 assets/task.md를 복사해 `tasks/T###.<slug>.md`로 채운다(`<...>` 전부 교체) → STATE: tasks 행 추가, next=`gusta-implement-task T###`(dep상 첫 것). `vibe log` 1줄.
- SSOT에서 만든 태스크: ssot 행 `tasked=rev`·pending `-`.
- 보고: 태스크 목록과 순서 — novice에겐 각 태스크가 무엇을 만들어내는지 한 줄씩.
