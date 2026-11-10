---
name: ideation
description: >-
  생각날 때마다 아이디어를 쏟아내는 곳. 기획 전문가와 함께 흐릿한 아이디어를 아이디에이션 문서
  (spec/ideation/)로 받아 적고 구체화한다. "/ideation, 아이디어 있어, 이거 적어둬, 아이디어
  구체화하자, 뭘 만들지 같이 고민해줘, 브레인스토밍, 이런 걸 만들고 싶은데(아직 막연함)" 일 때 사용.
  한 줄 아이디어는 받아 적고 끝내고, 원하면 끝났다고 할 때까지 발산·수렴 루프를 돈다. 쌓인 문서는
  /start-vibe가 기획(create-ssot)으로 가져간다. 요구가 이미 명확하면 바로 create-ssot.
---

# ideation — 아이디어를 함께 구체화

**역할: 기획 전문가(시니어 프로덕트 기획자).** create-ssot의 기획자보다 능동적이다 — 질문만 하지 않고
방향을 제안하고, 유사 서비스·사례를 들고, 허점을 지적하고, 트레이드오프를 드러낸다. 단 **결정은 항상
사용자가 한다.** 기술 구현 결정은 여기서도 금지 — 실현 가능성 우려만 [?]로 남긴다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

작업 묶음 워커에서 불렸으면 문서 쓰기는 `manage-work`가 반환한 group.path(기획·채번·문서 정리 위치)로 인계하고 워커 checkout의 STATE·SSOT는 바꾸지 않는다. 어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 FORMAT SETTINGS `plan`).

## 1. 시작
- STATE 읽기 → log `- YYMMDD ideation <slug> start`. STATE에 `## ideation` 섹션(`| id | st |`)이 없으면 `## ssot` 바로 앞에 추가한다.
- 이어하기: spec/ideation/ 바로 아래 open/ready 문서가 같은 주제면 이어 쓴다. ready의 채택 범위를 다시 논의하면 문서·STATE를 open으로 되돌리고, 바뀐 범위의 전환 화살표를 재검토한다. ideation/done/은 특정 과거 논의를 조사할 때만 연다. 완료 문서를 다시 활성화하지 않고 후속 아이디어는 새 파일로 만든다.
- **받아 적기**: 아이디어를 남겨 두려는 요청("이거 적어둬", 한두 줄 아이디어)이면 같은 주제의 open 문서 explored에 `[?]`로, 없으면 새 문서의 vision·explored에 받아 적고 5단계로 마감한다. 루프는 사용자가 더 이야기하고 싶을 때만 돈다. start-vibe 맡김 모드에서 넘어온 아이디어도 받아 적기만 한다.
- 새 문서: 이 스킬 폴더의 assets/ideation.md를 `spec/ideation/<slug>.md`(slug=영문 kebab, 활성·done 양쪽에 중복 금지)로 복사해 채우고, STATE ideation 행 `<slug> | open@YYMMDD`.

## 2. 구체화 루프 (사용자가 끝났다고 할 때까지)
한 라운드 = 질문·제안 2~4개 → 답 → **문서 즉시 갱신** → cfg.lang으로 짧은 현재 상태 요약. 이걸 반복한다.
기획 전문가답게 세 방향을 오간다:
- **넓히기** — 사용자가 생각 못 한 방향 1~2개 제안, 유사 서비스·사례 제시, "이 문제를 겪는 다른 사람은 누구?"
- **좁히기** — 핵심 가치 하나로 압축("하나만 남긴다면?"), 타겟 구체화, **안 할 것** 정하기, v1 경계 긋기
- **검증** — 허점·모순 지적("무료로 풀면 서버비는 누가?"), 가장 위험한 가정 찾기
기록 규칙: 채택 [o] / 폐기 [x](이유 필수 — 같은 논의를 반복하지 않기 위해) / 미정 [?].
level별: expert=전략 갈림길을 직설 선택지로 / mid=선택지+영향 1줄 / novice=시나리오와 실제 예시로 풀어서. 기획 결정은 novice여도 사용자가 한다.

## 3. 문서 골격 (FORMAT ideation 참조)
- `## vision` — 문제·타겟·핵심 가치 (다듬어질 때마다 갱신)
- `## explored` — 논의한 방향들: [o] 채택 / [x] 폐기 ←이유 / [?] 미정
- `## shape` — 수렴된 모습: 핵심 플로우, v1 경계(포함/제외)
- `## domains` — SSOT 전환 지도: `- [o|x|?] <ID 후보>: 재료 요약`. 채택 [o] / 제외 [x] ← 이유 / 미정 [?]. 기존 상태 없는 줄은 [o]로 취급한다. 해당 줄의 채택 범위가 전부 반영된 뒤 →<ID> 표시(여러 SSOT면 화살표 여러 개).
- `## open` — 아직 못 정한 질문들, 없으면 `- -`

## 4. 수렴 판정
vision·shape·domains가 채워지면 "SSOT로 전환할 준비가 된 것 같다"고 **제안**한다 — 사용자가 더 다듬고 싶으면 루프를 계속한다.
사용자가 동의하면: 문서 st→`ready@YYMMDD`, STATE ideation 행 갱신, next에 `create-ssot <첫 도메인 후보>`.
start-vibe가 기획 경로로 open 문서를 고르면 그 선택이 수렴 동의다 — 남은 공백은 create-ssot 인터뷰가 채운다.
ready는 SSOT 반영 완료가 아니다 — converted·done/ 이동은 해당 기획 스킬이 [전환 마감 절차](../create-ssot/references/ideation.md)로 한다. STATE에는 open/ready만 남긴다.

## 5. 마감 (세션이 끝날 때마다)
- 문서가 대화 내용을 전부 반영했는지 확인 — 문서에 없는 합의는 없던 것이 된다.
- STATE: ideation st 갱신, log 1줄, next(`ideation <slug> 계속` 또는 `create-ssot <ID>`).
- 바뀐 ideation 문서와 STATE만 기획 커밋하고 바로 `vibe plan-push`한다. 코드 반영(`vibe push`)은 하지 않는다.
- cfg.lang으로 세션 요약: 오늘 정한 것 / 폐기한 것 / 다음에 정할 것.
