---
name: update-haeram-spec-creator
description: >-
  "/update-haeram-spec-creator, haeram 업데이트, 스킬셋 최신으로 올려줘"에 사용한다. npm에 새 haeram-spec-creator 버전이
  있으면 설치된 스킬(.claude/skills·.codex/skills)을 갱신한다. 그 뒤 spec/의 구조 변경(STATE·SETTINGS·FORMAT)을 이관하고,
  검증한 다음 커밋한다. 최신이어도 빠진 이관이 있는지 확인한다.
---

# update-haeram-spec-creator — 스킬셋 업데이트와 이관

**역할: 업데이트 담당.** 버전 확인, 설치 갱신, spec/ 이관, 검증, 커밋 순서로 진행한다. 기획 내용과 제품 코드는 바꾸지 않는다. 아래 명령은 항상 `npx haeram-spec-creator@latest`로 실행한다(이하 `hsc`). 이관 규칙은 새 버전 안에 들어 있기 때문이다.

## 1. 시작 조건
- 미커밋 변경이 있으면 멈추고 알린다. 업데이트 커밋에 섞이지 않게 하려는 것이다. 사용자 변경을 stash하거나 커밋하지 않는다.
- `vibe status --json`에 `design`이 있으면 디자인이 끝났는지 먼저 묻는다.
- 이 checkout에서 `vibe loop`나 `work run`이 실행 중이면, 끝난 뒤에 업데이트하라고 안내한다. 실행 중인 세션이 읽는 스킬이 바뀌기 때문이다.
- 맡김 세션에서는 업데이트하지 않는다. 대신 inbox parked에 남긴다. 설치 충돌이나 FORMAT 판단처럼 사람이 골라야 할 일이 생길 수 있다.

## 2. 버전
- `hsc outdated`로 installed(lock 파일), latest, `changes`(installed 이후 CHANGELOG 항목)를 본다. `error`가 있으면 레지스트리 조회 실패를 알리고 멈춘다.
- package.json 의존성에 haeram-spec-creator가 있으면 그 패키지 관리자로 올린다(예: `npm i -D haeram-spec-creator@latest`, lockfile 포함).
- `outdated`가 false여도 3절의 `hsc migrate --dry-run`은 한 번 실행한다. 이전 업데이트에서 이관이 빠졌을 수 있다.

## 3. 갱신과 이관
- `hsc install --dry-run`을 실행한다. 충돌(로컬에서 고친 스킬 파일)이 있으면 목록을 보여 주고, `--force`로 덮어쓸지 묻는다. 그다음 `hsc install`, `hsc check` 순서로 실행한다.
- `hsc migrate --dry-run`으로 적용될 이관(`applied`)을 보여 준다. expert에게는 id와 파일을, novice에게는 무엇이 어디로 옮겨지는지 알려 준다. 그다음 `hsc migrate`를 실행한다. 이관은 여러 번 실행해도 결과가 같다.
- spec/FORMAT.md는 `format.missing`(새 패키지 줄)과 `format.extra`(프로젝트에만 있는 줄)로 맞춘다.
  - 같은 주제의 옛 줄은 새 줄로 바꾼다. 새 규칙은 같은 섹션에 넣는다.
  - 프로젝트가 의도적으로 고친 규칙은 남긴다. 패키지에 대응하는 줄이 없는 extra 줄이 여기에 해당한다.
  - 판단이 애매한 줄은 사용자에게 보여 주고 고르게 한다.
  - FORMAT 전체를 패키지 것으로 덮어쓰지 않는다.
- `unset`이 있으면 haeram-init으로 정한다.
- `hsc lint` 오류가 0이 될 때까지, 이관으로 생긴 문제만 고친다. 원래 있던 오류는 보고만 한다.

## 4. 커밋·보고
- 커밋은 둘로 나눈다.
  - 설치 커밋: `.claude/`·`.codex/`·lock 파일과 package.json·lockfile을 `chore: update haeram-spec-creator <from> → <to>`로 커밋한다.
  - 이관 커밋: spec/만 `spec: migrate to haeram-spec-creator <to>`로 커밋한다. SETTINGS plan이 `-`가 아니면 `vibe plan-push`로 올린다.
- 코드 반영(`vibe push`)은 하지 않는다.
- 다음을 보고한다.
  - 버전(from → to)과 적용된 이관
  - FORMAT에서 바꾼 줄 수와 남긴 프로젝트 규칙
  - 새로 정한 설정과 lint 결과
  - `changes`를 요약한 "달라진 동작"(cfg.level에 맞춰서)
