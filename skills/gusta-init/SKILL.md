---
name: gusta-init
description: >-
  "/gusta-init, gusta 초기 설정, 브랜치 전략 정해줘"와 `vibe status`의 settings.unset에 사용. 정해지지 않은 설정(브랜치 전략·버전·안내 블록·쓸 AI 도구)만 물어 spec/SETTINGS.md에 쓴다.
---

# gusta-init — 정해지지 않은 설정 정하기

**역할: 설정 인터뷰.** 미정(`?`) 설정만 묻고 `vibe settings --set`으로 쓴다(값 변경은 gusta-preference). 맡김·실행기 세션에서는 실행하지 않고 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 하고 "브랜치 전략 미정"을 inbox parked에 남기며, agent-block 미정이면 지침 파일을 쓰지 않고, version 미정이면 버전을 올리지 않고 미정으로 둔다. agents 미정이면 태스크 `run:`을 비워 둔다.

## 1. 확인
- 쓰기·커밋 전에 land·deploy·plan·기본 브랜치 위라면 자기 소유 하위 브랜치로 옮긴다(다른 세션·미커밋 사용자 변경은 건드리지 않는다).
- `npx @haeram/gusta vibe settings --json`으로 `unset`·`legacy`를 본다. `legacy`가 있으면 `npx @haeram/gusta migrate` 뒤 다시 본다. `unset`이 비면 아래 대조만 하고 원래 일로 돌아간다.
- [프로젝트 규칙 대조](../gusta-update/references/project-rules.md)대로 기존 브랜치·기획 발행·배포 규칙과 원래 작업의 검증 연결(검사별 연결 완료 조건)을 확인하고, 차이는 맞추는 안과 함께 묻는다. 미연결 검증은 gusta-create-architecture/gusta-update로 넘기고 초기화 미완료로 보고한다(미연결 전체 스크립트를 대신 실행시키지 않는다).
- 제품 단계·지원 범위가 미정이면 [제품 지원 정책](../gusta-create-architecture/references/product-support.md)대로 gusta-plan/gusta-create-architecture에 넘긴다.
- 후보 브랜치는 `git branch -a --format='%(refname:short)'`와 `git symbolic-ref --short refs/remotes/origin/HEAD`에서만 고른다(예외: 사용자가 말한 새 이름, 통합 후보가 없을 때 추천하는 `develop`).

## 2. 묻기 (한 번에 모아서)
선택지형 질문 도구가 있으면 쓴다. cfg.lang·cfg.level을 따르고, 키의 뜻은 `vibe settings --json`의 `note`로 설명한다(novice에게는 선택마다 달라지는 것을 먼저).
- **브랜치 전략**: "개발(통합) 브랜치를 운영합니까?"로 land·land-via·deploy를 한 번에 정한다.
  - 아니오: 끝난 작업이 기본 브랜치에 바로 반영된다. → `land=<기본>`, `land-via=merge`, `deploy=-`
  - 예: 통합 브랜치에 모았다가 "배포해줘"(`vibe deploy`)로 기본 브랜치에 올린다 — 후보가 없으면 `develop`을 새로 만드는 안을 추천한다. → `land=<통합>`, `deploy=<기본>`
  - 그 밖: PR(→ `land=<기본>`, `land-via=pr`) 또는 커밋만(→ `land=current`, `deploy=-`).
- **push**(true/false): push마다 원격 CI가 돌고, PR 전략이면 작업 브랜치는 어느 쪽이든 올라간다고 알린다.
- **plan**: land가 current일 때만 묻는다.
- **version**: 반영 때 CLI가 버전을 올릴지(auto/off). major는 사람이 직접 올린다는 점, 버전 변경으로 배포하는 CI가 있으면 반영이 곧 릴리스라는 점을 알린다. 루트 `package.json`에 `version`이 없거나 land-via가 pr이면 적용되지 않는다고 알리고 `off`로 쓴다.
- **agent-block**(true/false): `npx @haeram/gusta agent-block --check --json`의 `files`·`block`을 보여 주고, 그 블록을 두고 업데이트 때 갱신해도 되는지 묻는다.
- **agents**: `npx @haeram/gusta agents --json`의 `tools`를 도구·버전·로그인 여부·모델 수(`superseded` 없는 models)로 보여 주고 쓸 도구와 순서를 묻는다 — 사용 한도에 닿으면 이 목록 안에서만 다음 도구로 넘어간다. 로그인 안 된 도구는 고를 수 없다고 알린다. → `agents=claude,codex`처럼 쉼표로.

## 3. 쓰기
- land 브랜치가 로컬에 없으면 알린 뒤 `git branch <land> <기본>`으로 만든다.
- 이번에 정한 미정 키(와 함께 승인받은 기존 값 변경)만 `vibe settings --set <key>=<value> ... --json`으로 쓴다(예: `vibe settings --set land=<approved-branch> --json`). 영향받는 활성 문서도 맞춘다(SSOT는 gusta-update-ssot).
- `settings: branch strategy`로 커밋한다(spec 외 운영 문서는 따로). 프로젝트 정책과 합치할 때만 `vibe plan-push`하고, PR 필수 정책과 충돌하면 미지원 범위를 알려 선택받는다(`plan=-`로 우회하지 않는다).
- agent-block이 true면 `npx @haeram/gusta agent-block`으로 적용하고(지침 파일을 직접 편집하지 않는다) `chore: add gusta agent block`으로 따로 커밋한다.
- 정한 전략을 한 줄로 요약하고(예: "끝나면 next에 병합하고 push, '배포해줘'로 main 반영") 원래 스킬로 돌아간다.
