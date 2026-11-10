---
name: haeram-init
description: >-
  "/haeram-init, haeram 초기 설정, 브랜치 전략 정해줘"에 사용한다. 다른 haeram 스킬이 `vibe status`의 settings.unset을 보고
  이 스킬로 보낼 때도 쓴다. 이 프로젝트의 브랜치 전략(끝난 작업이 병합될 land, 병합 방식, push, 배포 브랜치, 기획 브랜치) 중
  정해지지 않은 것만 물어 spec/SETTINGS.md에 쓰고, 원래 하려던 일로 돌아간다.
---

# haeram-init — 정해지지 않은 설정 정하기

**역할: 설정 인터뷰.** 미정(`?`) 설정만 묻고 `vibe settings --set`으로 쓴다. 이미 정한 값은 다시 묻지 않는다. 값을 바꾸는 일은 haeram-setting이 한다. 기획·코드는 다루지 않는다. 맡김 세션이나 실행기가 배정한 세션에서는 이 스킬을 실행하지 않는다. 그런 세션은 묻지 않고 현재 브랜치에 커밋만 하며, "브랜치 전략 미정"을 inbox parked에 남긴다.

## 1. 확인
- `npx haeram-spec-creator vibe settings --json`으로 `unset`·`legacy`·현재 값을 본다. `legacy`가 있으면(예전 STATE cfg push·plan) 먼저 `npx haeram-spec-creator migrate`로 옮기고 다시 본다. `unset`이 비어 있으면 이미 정해져 있다고 한 줄로 알리고 원래 일로 돌아간다.
- 후보 브랜치는 실제 브랜치(`git branch -a --format='%(refname:short)'`)와 원격 기본 브랜치(`git symbolic-ref --short refs/remotes/origin/HEAD`)에서만 고른다. 브랜치 이름을 지어내지 않는다. 사용자가 새 이름을 말한 경우는 예외다.

## 2. 묻기 (한 번에 모아서)
선택지형 질문 도구가 있으면 쓴다. 말투와 상세도는 cfg.lang·cfg.level을 따른다. novice에게는 선택마다 무엇이 달라지는지 먼저 설명한다.
- **브랜치 전략**: land·land-via·deploy를 한 번에 정하는 선택지다.
  - 바로 병합: 끝나면 기본 브랜치에 바로 병합한다. → `land=<기본>`, `land-via=merge`, `deploy=-`
  - 통합 브랜치를 거쳐 배포: 끝나면 통합 브랜치(예: next, develop)에 병합하고, "배포해줘"라고 하면 기본 브랜치에 반영한다. → `land=<통합>`, `deploy=<기본>`
  - PR: 끝나면 기본 브랜치로 PR을 올린다. → `land=<기본>`, `land-via=pr`
  - 커밋만: 작업한 브랜치에 커밋만 한다. → `land=current`, `deploy=-`
- **push**: 반영할 때 원격에도 올릴지 정한다(true/false). push할 때마다 원격 CI가 돈다. PR 전략이면 작업 브랜치는 어느 쪽이든 원격에 올라간다는 점을 알린다.
- **plan**: land가 current일 때만 묻는다. 여러 worktree가 같은 태스크 번호를 쓰지 않으려면 기획 정본 브랜치가 하나 있어야 한다. 다른 전략에서는 plan이 land를 따르므로 묻지 않는다.
- land로 고른 브랜치가 로컬에 없으면 기본 브랜치에서 만든다는 점을 알린 뒤 `git branch <land> <기본>`으로 만든다.

## 3. 쓰기
- `vibe settings --set land=<값> --set land-via=<값> --set push=<값> --set deploy=<값> [--set plan=<값>] --json`을 실행한다.
- spec/SETTINGS.md를 커밋한다. migrate로 spec/STATE.md도 바뀌었으면 함께 넣는다. 메시지는 `settings: branch strategy`다. plan이 `-`가 아니면 `vibe plan-push`로 올린다.
- 정한 전략을 한 줄로 요약한다(예: "끝나면 next에 병합하고 push, '배포해줘'로 main 반영"). 그다음 원래 요청한 스킬로 돌아가 이어서 진행한다.
