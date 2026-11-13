---
name: gusta-init
description: >-
  "/gusta-init, gusta 초기 설정, 브랜치 전략 정해줘"에 사용한다. 다른 gusta 스킬이 `vibe status`의 settings.unset을 보고
  이 스킬로 보낼 때도 쓴다. 이 프로젝트의 브랜치 전략(끝난 작업이 병합될 land, 병합 방식, push, 배포 브랜치, 기획 브랜치), 자동 버전 관리,
  CLAUDE.md·AGENTS.md에 gusta 안내 블록을 둘지, 쓸 AI 도구(Claude·Codex)와 순서 중 정해지지 않은 것만 물어 spec/SETTINGS.md에 쓰고, 원래 하려던 일로 돌아간다.
---

# gusta-init — 정해지지 않은 설정 정하기

**역할: 설정 인터뷰.** 미정(`?`) 설정만 묻고 `vibe settings --set`으로 쓴다. 이미 정한 값은 다시 묻지 않는다. 값을 바꾸는 일은 gusta-preference가 한다. 기획·코드는 다루지 않는다. 맡김 세션이나 실행기가 배정한 세션에서는 이 스킬을 실행하지 않는다. 그런 세션은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 하고 "브랜치 전략 미정"을 inbox parked에 남기며, agent-block 미정이면 지침 파일을 쓰지 않고, version 미정이면 버전을 올리지 않고 미정으로 둔다. agents 미정이면 태스크 `run:`을 비워 둔다.

## 1. 확인
- 조회·규칙 조사는 현재 위치에서 할 수 있다. 첫 설치·의존성 변경·이관·설정/agent-block 쓰기·커밋 **전에** Git의 현재 브랜치를 확인하고, land·deploy·plan·저장소 기본 브랜치이면 자기 소유 하위 브랜치를 만들거나 확인한 작업 브랜치로 옮긴다. 다른 세션·checkout·미커밋 사용자 변경을 옮기거나 덮지 않는다.
- `npx @haeram/gusta vibe settings --json`으로 `unset`·`legacy`·현재 값을 본다. `legacy`가 있으면(예전 STATE cfg push·plan) 먼저 `npx @haeram/gusta migrate`로 옮기고 다시 본다. `unset`이 비어 있으면 설정은 재질문하지 않고 아래 연결 확인 뒤 원래 일로 돌아간다.
- 묻기 전에 적용 지침과 브랜치·기획 발행·배포의 기존 운영 규칙을 [프로젝트 규칙 대조](../gusta-update/references/project-rules.md)대로 확인한다. 같은 주제·겹치는 범위의 실제 차이만 현재 프레임워크 절차로 맞추길 권유하고 변경안·영향과 함께 괜찮은지 묻는다. 설정에 없는 프로젝트 제약도 보존하며, 기존에 정한 값을 프리셋으로 덮지 않는다.
- 원래 작업의 검증도 지침과 실제 명령을 대조해 검사별 주체·단계·조건·입력·중복·재사용 조건이 ARCH 단계/계획으로 실행되는지 확인한다([검증 절차](../gusta-start/references/verification.md)). `declared:false`·`partial:true`나 지침에만 있는 명령은 연결 필요로 남기고 gusta-create-architecture/gusta-update로 잇는다. 이 스킬이 검증 정책을 임의로 고치거나 모든 프로젝트에 새 계획 파일을 요구하지 않는다.
- 후보 브랜치는 실제 브랜치(`git branch -a --format='%(refname:short)'`)와 원격 기본 브랜치(`git symbolic-ref --short refs/remotes/origin/HEAD`)에서만 고른다. 브랜치 이름을 지어내지 않는다. 사용자가 새 이름을 말한 경우와 통합 브랜치 후보가 없을 때 추천하는 `develop`은 예외다.

## 2. 묻기 (한 번에 모아서)
선택지형 질문 도구가 있으면 쓴다. 말투와 상세도는 cfg.lang·cfg.level을 따른다. novice에게는 선택마다 무엇이 달라지는지 먼저 설명한다.
- **브랜치 전략**: "개발(통합) 브랜치를 운영합니까?"로 land·land-via·deploy를 한 번에 정한다.
  - 아니오: 끝난 작업이 기본 브랜치에 바로 반영된다. → `land=<기본>`, `land-via=merge`, `deploy=-`
  - 예: 통합 브랜치에 모았다가 "배포해줘"(`vibe deploy`)로 기본 브랜치에 올린다 — 실제 브랜치에 통합 후보가 없으면 `develop`을 새로 만드는 안을 추천한다. → `land=<통합>`, `deploy=<기본>`
  - 그 밖: PR(끝나면 기본 브랜치로 PR을 올린다 → `land=<기본>`, `land-via=pr`) 또는 커밋만(작업한 브랜치에 커밋만 한다 → `land=current`, `deploy=-`).
- **push**: 반영할 때 원격에도 올릴지 정한다(true/false). push할 때마다 원격 CI가 돈다. PR 전략이면 작업 브랜치는 어느 쪽이든 원격에 올라간다는 점을 알린다.
- **plan**: land가 current일 때만 묻는다. 여러 worktree가 같은 태스크 번호를 쓰지 않으려면 기획 정본 브랜치가 하나 있어야 한다. 다른 전략에서는 plan이 land를 따르므로 묻지 않는다.
- land로 고른 브랜치가 로컬에 없으면 기본 브랜치에서 만든다는 점을 알린 뒤 `git branch <land> <기본>`으로 만든다.
- **version**: 운영 브랜치(deploy가 있으면 그 브랜치, 없으면 land)에 반영될 때마다 CLI가 버전을 올릴지 묻는다(auto/off) — 새 SSOT 결정이 있으면 minor, 아니면 patch이고 major는 사람이 직접 올린다. 버전 변경으로 배포하는 CI가 있는 프로젝트에서는 반영이 곧 릴리스라는 점을 알린다. 루트 `package.json`에 `version`이 없거나 land-via가 pr이면 적용되지 않는다고 알리고 `off`로 쓴다.
- **agent-block**: `npx @haeram/gusta agent-block --check --json`의 `files`(대상 파일)와 `block`(넣을 내용)을 보여 주고, 그 파일의 마커 사이에 gusta 안내 블록을 두고 업데이트 때 갱신해도 되는지 묻는다(true/false). 블록 밖은 바뀌지 않는다.
- **agents**: `npx @haeram/gusta agents --json`의 `tools`를 도구·버전·로그인 여부·고를 수 있는 모델 수(`superseded` 없는 models)로 보여 주고, 쓸 도구와 순서를 묻는다 — 앞이 먼저이고, 사용 한도에 닿으면 이 목록 안에서만 다음 도구로 넘어간다. 로그인 안 된 도구는 고를 수 없다고 알린다. → `agents=claude,codex`처럼 쉼표로.

## 3. 쓰기
- 이번에 결정한 미정 키만 `vibe settings --set <key>=<value> ... --json`으로 쓴다. 예를 들어 미정 land만 승인받았다면 `vibe settings --set land=<approved-branch> --json`으로 쓴다. 기존 값의 변경도 함께 승인받은 경우에만 그 키를 포함한다. 선택한 정책에 영향을 받는 활성 문서도 일치시키며 SSOT 정책 변경은 gusta-update-ssot를 쓴다.
- spec/SETTINGS.md와 승인된 spec 변경을 `settings: branch strategy`로 커밋하고, spec 외 운영 문서는 분리한다. 프로젝트 정책과 기획 발행이 합치할 때만 `vibe plan-push`한다. PR 필수 정책과 기획 직접 push가 충돌하면 미지원 범위를 알리고 선택받으며, 공유 채번을 끄는 `plan=-`로 임의 우회하지 않는다.
- agent-block을 true로 썼으면 `npx @haeram/gusta agent-block`으로 적용하고(지침 파일을 직접 편집하지 않는다) `chore: add gusta agent block`으로 따로 커밋한다.
- 정한 전략을 한 줄로 요약한다(예: "끝나면 next에 병합하고 push, '배포해줘'로 main 반영"). 그다음 원래 요청한 스킬로 돌아가 이어서 진행한다.
