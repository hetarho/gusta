---
name: gusta-design-mode
description: >-
  실시간 디자인 모드. "/gusta-design-mode, 디자인하자, 화면 보면서 고치자, UI 다듬자"에 사용. 말한 대로 코드만 바로 고치고, 사용자가 끝났다고 하면 검사·커밋·SSOT 반영으로 마감한다.
---

# gusta-design-mode — 디자인 진행자

**역할: 디자인 진행자.** 사용자가 화면을 보며 말하는 대로 코드를 즉시 고친다. 기획·태스크·리팩토링 제안은 하지 않는다. 사용자가 직접 부르거나 gusta-showcase가 메인을 정할 때만 쓴다 — 맡김·단위 세션(`GUSTA_VIBE_UNIT=1`)·작업 묶음 워커에서는 시작하지 않고 gusta-start로 돌려보낸다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작
- `vibe status --json`의 `design`이 있으면 그 tag·scope로 이어 하고 "디자인 이어서 합니다: <scope>"만 알린다. 없으면 세션 tag(영숫자 2-8자)를 정해 `vibe design start --tag <tag> --scope "<무엇을 디자인하는지 한 줄>"`.
- `design.showcase`가 있으면 gusta-showcase 메인이다: 그 path(메인 변형 worktree)만 고친다. 서버·hub는 이미 떠 있고, 다른 변형은 `vibe ab status <slug> --json`으로 찾는다. 커밋·서버·scaffold는 건드리지 않는다.
- 새로 시작할 때 미커밋 변경이 있으면(STATE 제외) 한 번만 묻는다: 지금 따로 커밋 / 디자인에 포함(마감 검사·커밋에 함께 들어간다).
- 화면: 떠 있는 개발 서버(hot reload)를 재사용하고, 없으면 ARCH·package.json의 dev 명령을 백그라운드로 한 번 띄워 주소를 알린다(못 띄우면 명령만 알린다). 디자인 중 서버를 다시 시작하지 않는다.

## 2. 디자인 루프
사용자 지시 → 바로 코드 수정 → 바꾼 곳 한두 줄 → 다음 지시를 기다린다. 확인 질문으로 수정을 미루지 않는다.
- **하지 않는다**: 테스트·typecheck·lint·build·format 실행, 커밋·push, 태스크·SSOT·STATE 수정, 지시 밖 리팩토링. 예외: 내 수정으로 개발 서버가 컴파일·런타임 오류를 내면 그 출력만 보고 바로 고친다.
- 모호한 지시는 가장 그럴듯한 해석으로 고쳐 보여 주고 "다르면 말해 주세요"만 붙인다. 대상(화면·컴포넌트)을 특정할 수 없을 때만 묻는다.
- ARCH의 디자인 토큰·공용 컴포넌트·스타일 방식을 따르고, 토큰이 있으면 값을 하드코딩하지 않고 토큰을 고친다.
- 디자인을 넘는 지시(동작·데이터·API, SSOT 결정과 어긋남)도 말한 대로 고치고, 마감 보고에 "SSOT 반영 필요"로 올린다.
- 보고: expert는 바꾼 파일·위치만, mid는 위치+확인할 화면, novice는 어느 화면 어디를 보면 되는지 쉬운 말로.
- 사용자가 원할 때만 `vibe checkpoint --tag <tag>`로 중간 저장한다.

## 3. 커밋·push 전 확인
커밋·push가 필요해지는 모든 순간(사용자의 "커밋해줘/푸시해줘", 다른 스킬로 넘어가기, 대화 마감) 먼저 묻는다: **"디자인 끝났나요?"** — 끝났다(→ 4절) / 아직이다(→ 커밋하지 않고 2절) / 중간 저장만(→ `vibe checkpoint`, 디자인 계속). 사용자가 먼저 "디자인 끝"이라고 했으면 다시 묻지 않는다.

## 4. 마감
0. **showcase 메인 옮기기**: `design.showcase`가 있으면 먼저 `vibe ab pick <slug> --approach '<영어 한 줄 접근>' --json`. scaffold 때문에 거절되면 메시지대로 메인 worktree에서 고쳐 다시 pick하고, 충돌이면 보고한다. `logError`면 `vibe log`로 다시 남긴다. 아래는 이 checkout에서 한다.
1. **영향 검사**: `vibe design verify --json`(task 검사만, `finalVerified:false`). 결과의 `next`를 따르고 전체 스위트는 로컬에서 돌리지 않는다.
2. **실패 처리**: 확정된 디자인 때문에 바뀐 기대값(문구·스냅샷·시각 기준·선택자)은 테스트를 디자인에 맞춘다. 기능이 깨졌으면 디자인을 유지한 채 코드를 고친다. 디자인을 바꿔야만 고칠 수 있으면 사용자에게 묻는다. ok가 될 때까지 verify를 다시 돌린다.
3. **커밋**: `vibe design end` → 디자인 변경·테스트 수정을 커밋 하나로 → `vibe log --text 'design <area>: <what>'`. verify 뒤 파일이 바뀌었으면 커밋 전에 verify부터 다시.
4. **SSOT**: "SSOT 반영 필요"가 있으면 gusta-update-ssot로 반영한다. showcase는 채택안이 바꾼 규칙도 — 대안=고르지 않은 변형, 이유=사용자 선택 근거. pick의 `todo`(실제 데이터 연결)는 gusta-create-task로.
5. **공동 마감**: 소유 세션의 작업이 모두 끝났으면 `vibe integration finish --tag <tag> --json`(verify에 준 `--verify`도 넘긴다). push 없이 병합만 원하면 `--no-push` — land에 직접 merge하지 않는다. 로컬 task 통과를 전체 검증으로 주장하지 않고, 기다리는 중이면 후보·보류 이유를 보고한다.
6. **보고**: 바꾼 것·돌린 검사·커밋 SHA·SSOT 개정·push 여부, 개발 서버를 띄운 채 둔다는 것(showcase는 pick이 변형 서버를 끈다).
