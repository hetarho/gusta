---
name: start-design
description: >-
  실시간 디자인 모드. "/start-design, 디자인하자, 화면 보면서 고치자, UI 다듬자, 디자인 모드" 일 때 사용.
  이 checkout만 디자인 중으로 표시하고(STATE·다른 worktree는 그대로), 사용자가 말하는 대로 코드만 바로 고쳐 화면에서 실시간으로 보게 한다 —
  그동안 테스트·e2e·커밋·push는 하지 않는다.
  사용자가 디자인이 끝났다고 하면 그때 전체 테스트를 돌려 확인하고 커밋한다. 커밋·push 전에는 항상 디자인이 끝났는지 묻는다.
---

# start-design — 디자인 진행자

**역할: 디자인 진행자.** 사용자가 화면을 보며 말하는 대로 코드를 즉시 고친다. 판단은 사용자가 화면으로 한다 — 되묻기보다 고쳐서 보여 준다. 기획 결정·태스크 작성·리팩토링 제안은 하지 않는다(디자인이 끝난 뒤 해당 스킬로). 함께 모드 전용이다: 사람이 화면을 봐야 하므로 맡김·단위 세션(`HAERAM_VIBE_UNIT=1`)·작업 묶음 워커에서는 시작하지 않고 start-vibe로 돌려보낸다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

CLI는 `npx haeram-spec-creator` 뒤에 붙인다. 디자인 모드 규칙의 정본은 `vibe format --section state`의 Design mode 항목이다.

## 1. 시작
- `vibe status --json`의 `design`이 있으면 그 tag·scope로 이어서 한다 — "디자인 이어서 합니다: <scope>"만 알린다. 없으면 세션 tag(영숫자 2-4자)를 정하고 `vibe design start --tag <tag> --scope "<무엇을 디자인하는지 한 줄>"`로 이 checkout을 디자인 중으로 표시한다. 이 상태는 checkout의 Git 디렉터리에만 있다 — STATE에 쓰지 않으므로 기획 커밋·plan-push로 다른 worktree에 퍼지지 않는다.
- 새로 시작할 때 미커밋 변경이 있으면(`git status --porcelain`, STATE 제외) 한 번만 묻는다: 지금 따로 커밋 / 디자인에 포함. 포함하면 마감 검증·커밋에 함께 들어간다.
- 화면: 개발 서버(hot reload)가 떠 있으면 재사용하고, 없으면 ARCH·package.json의 dev/start 명령을 백그라운드로 한 번 띄워 주소를 알린다. 띄울 수 없으면 사용자가 실행할 명령만 알려 준다. 디자인 중 서버를 다시 시작하지 않는다.

## 2. 디자인 루프
사용자 지시 → 바로 코드 수정 → 바꾼 곳 한두 줄 → 다음 지시를 기다린다. 확인 질문으로 수정을 미루지 않는다.
- **하지 않는다**: 단위·통합·e2e 테스트, typecheck·lint·build·format 실행, 커밋·push, 태스크 파일·SSOT·STATE 수정, 지시 밖 리팩토링·정리.
- 예외 하나: 내 수정 때문에 개발 서버가 컴파일·런타임 오류를 내면 그 출력만 보고 바로 고친다 — 검증이 아니라 화면을 되살리는 일이다.
- 모호한 지시는 가장 그럴듯한 해석으로 고쳐 보여 주고 "다르면 말해 주세요"만 붙인다. 대상(어느 화면·컴포넌트)을 정말 특정할 수 없을 때만 묻는다.
- 프로젝트의 디자인 토큰·공용 컴포넌트·스타일 방식(ARCH 컨벤션)을 따른다. 토큰이 있으면 값을 여러 파일에 하드코딩하지 않고 토큰을 고친다.
- 지시가 디자인을 넘어도(동작·데이터·API 변경, SSOT 결정과 어긋남) 막지 않고 말한 대로 고친다. 그런 변경은 기억해 두었다가 마감 보고에 "SSOT 반영 필요"로 올린다.
- 보고 상세도: expert는 바꾼 파일·위치만, mid는 위치+확인할 화면, novice는 어느 화면 어디를 보면 되는지 쉬운 말로.
- 길어지면 사용자가 원할 때만 `vibe checkpoint --tag <tag>`로 `wip/<tag>`에 스냅샷한다(테스트 없음, 현재 브랜치·커밋은 그대로).

## 3. 커밋·push 전 확인
커밋·push가 필요해지는 모든 순간 — 사용자의 "커밋해줘/푸시해줘", 다른 스킬로 넘어가기, 대화 마감 — 먼저 묻는다: **"디자인 끝났나요?"** 선택지: 끝났다(→ 4절 마감) / 아직이다(→ 커밋하지 않고 2절 계속) / 중간 저장만(→ `vibe checkpoint`, 디자인 계속). 사용자가 먼저 "디자인 끝"이라고 말했으면 그것이 답이다 — 다시 묻지 않는다. 디자인 중에는 `vibe push`가 거절된다. 우회하지 않는다.

## 4. 마감
1. **전체 테스트**: `vibe design verify --json` 한 번(Claude는 셸 백그라운드+완료 알림, Codex는 긴 timeout의 단일 호출). ARCH의 task·batch 명령 전부를 미커밋 작업 트리에서 돌린다 — 빠른 검사가 실패하면 무거운 검사는 skipped로 남는다. 명령이 없다고 나오면 ARCH·package.json에서 전체 테스트 명령을 찾아 `--verify '<command>'`로 넘긴다. 이 실행이 이 디자인의 최종 검증이다.
2. **실패 처리**: 확정된 디자인 때문에 바뀐 기대값(문구·스냅샷·시각 기준·선택자)은 테스트를 디자인에 맞춘다. 기능이 깨졌으면 디자인을 유지한 채 코드를 고친다. 디자인을 바꿔야만 고칠 수 있으면 사용자에게 묻는다. 고친 뒤 ok가 될 때까지 verify를 다시 돌린다(같은 트리의 통과는 캐시로 건너뛴다).
3. **커밋**: `vibe design end` → STATE log에 `- YYMMDD design <area>: <what>`(20줄 초과분 삭제) → 디자인 변경·테스트 수정·STATE를 커밋 하나로. verify 통과 뒤 STATE 말고 다른 파일이 바뀌었으면 커밋 전에 verify부터 다시 돌린다.
4. **반영**: 사용자가 요청했거나 SETTINGS land가 다른 브랜치·push가 true일 때만 `vibe push --verified-commit <디자인 커밋 SHA>`. 검증한 트리와 커밋의 차이는 STATE뿐이라 다시 돌리지 않는다. 그 밖에는 커밋만 한다.
5. **보고**: 바꾼 것·돌린 검사·커밋 SHA·push 여부, 개발 서버를 띄운 채 둔다는 것. "SSOT 반영 필요"가 있으면 update-ssot로 넘긴다(기획 커밋은 spec/만 담아 `vibe plan-push`).
