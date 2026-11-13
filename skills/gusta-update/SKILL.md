---
name: gusta-update
description: >-
  "/gusta-update, gusta 업데이트, 스킬셋 최신으로 올려줘"에 사용한다. npm에 새 gusta 버전이
  있으면 설치된 스킬(.claude/skills·.codex/skills)을 갱신한다. spec/ 구조를 이관하고, 모든 프로젝트 소유 문서·범위별 지침과
  설정·코드·CI의 운영 규칙을 대조한 뒤 검증·커밋한다. 최신이어도 빠진 이관과 규칙 충돌을 확인한다.
---

# gusta-update — 스킬셋 업데이트와 이관

**역할: 업데이트 담당.** 버전 확인 → 프로젝트 규칙 조사 → 설치·이관 → 대조·검증 → 커밋. 제품 코드는 바꾸지 않는다. 업데이트 요청만으로 프로젝트 정책을 바꿀 권한을 추론하지 않는다. 아래 명령은 새 이관 규칙을 가진 `npx @haeram/gusta@latest`로 실행한다(이하 `gusta`).

## 1. 시작 조건
- 미커밋 변경이 있으면 멈추고 알린다. 업데이트 커밋에 섞이지 않게 하려는 것이다. 사용자 변경을 stash하거나 커밋하지 않는다.
- `vibe status --json`에 `design`이 있으면 디자인이 끝났는지 먼저 묻는다.
- 이 checkout에서 `vibe loop`나 `work run`이 실행 중이면, 끝난 뒤에 업데이트하라고 안내한다. 실행 중인 세션이 읽는 스킬이 바뀌기 때문이다.
- 맡김 세션에서는 업데이트하지 않는다. 대신 `vibe inbox add --kind parked`로 남긴다. 설치 충돌이나 FORMAT 판단처럼 사람이 골라야 할 일이 생길 수 있다.

## 2. 버전과 프로젝트 규칙
- `gusta outdated`로 installed(lock 파일), latest, `changes`(installed 이후 CHANGELOG 항목)를 본다. `error`가 있으면 레지스트리 조회 실패를 알리고 멈춘다.
- 설치·이관 전에 [프로젝트 규칙 대조](references/project-rules.md)를 수행한다. `gusta upgrade-context`의 모든 페이지와 적용 지침·참조를 조사하고, 대조 범위·제외 이유·미확인 항목을 남긴다. 최신 버전이거나 알려진 설정 키가 검색되지 않아도 이 조사를 생략하지 않는다.
- package.json 의존성에 @haeram/gusta가 있으면 그 패키지 관리자로 올린다(예: `npm i -D @haeram/gusta@latest`, lockfile 포함).
- `outdated`가 false여도 `gusta migrate --dry-run`과 규칙 대조를 끝낸다. 설치 갱신이 불필요하면 건너뛰되 이관·정합성 확인 전에는 완료로 보고하지 않는다.

## 3. 갱신과 이관
- `gusta install --dry-run`을 실행한다. 충돌(로컬에서 고친 스킬 파일)이 있으면 목록을 보여 주고, `--force`로 덮어쓸지 묻는다. 그다음 `gusta install`, `gusta agent-block`, `gusta check` 순서로 실행한다.
- `gusta agent-block`은 SETTINGS `agent-block`이 true일 때만 CLAUDE.md·AGENTS.md의 마커 사이 블록을 새 버전으로 바꾼다(아니면 건너뛴다). broken이면 아무것도 쓰지 않는다 — 보고된 파일·줄을 보여 주고 고칠 방법을 승인받아 마커만 정리한 뒤 다시 실행한다.
- `gusta migrate --dry-run`으로 적용될 이관(`applied`)을 보여 준다. expert에게는 id와 파일을, novice에게는 무엇이 어디로 옮겨지는지 알려 준다. 그다음 `gusta migrate`를 실행한다. 이관은 여러 번·여러 checkout에서 실행해도 결과가 같다.
- 이관은 STATE의 active·inbox·log를 조정 브랜치(SETTINGS `coord`, 기본 `gusta`)의 SESSIONS.md로 옮긴다(결과 `sessions`, 커밋·push는 CLI). 같은 이름의 코드 브랜치가 있어 거절되면 `vibe settings --set coord=<다른 이름>` 뒤 다시 실행한다. 옛 버전 기기와는 선점이 서로 보이지 않으니 모든 기기를 함께 올리라고 보고한다.
- `format.missing`·`format.extra`는 문장 차이이지 정책 변경 승인이나 의도 판정이 아니다. FORMAT도 다른 활성 문서와 대조하고, 동작이 같은 표기 정리만 자동 적용한다. 실제 차이는 원문·범위·변경안·영향을 보여 주며 현재 프레임워크 기본 절차에 맞추길 권유하고 괜찮은지 묻는다. 승인 전에는 의도적인 규칙·범위별 예외를 유지하고, 역사 기록과 FORMAT 전체를 덮어쓰지 않는다.
- `unset`이 있으면 gusta-init으로 정한다.
- 선택받은 일치화는 SETTINGS와 영향을 받는 모든 활성 문서에 함께 반영한다(SSOT 정책 변경은 gusta-update-ssot). 설정값의 실행 정본이라는 이유로 SETTINGS가 프로젝트 정책 변경을 승인한 것으로 보지 않는다. 조사·반영 뒤 `upgrade-context`를 다시 받아 변경·참조·검토 범위를 확인한다.
- `gusta lint`로 이관이 더한 오류를 고친다. 원래 있던 오류는 보고하며, 구조 검사와 프로젝트 정책 대조 결과를 따로 확인한다.

## 4. 커밋·보고
- 설치·spec 이관·프로젝트 운영 문서의 커밋을 분리한다.
  - 설치 커밋: `.claude/`·`.codex/`·lock 파일과 package.json·lockfile, 블록이 갱신된 CLAUDE.md·AGENTS.md를 `chore: update gusta <from> → <to>`로 커밋한다.
  - 이관 커밋: spec/만 `spec: migrate to gusta <to>`로 커밋한다. 기획 발행은 대조한 프로젝트 지침과 SETTINGS plan을 함께 확인하며, 충돌을 해결하기 전 자동 plan-push하지 않는다.
  - 승인된 프로젝트 지침·운영 문서 변경은 해당 경로의 지침을 따라 별도 커밋한다. spec 외 파일을 기획 발행에 섞지 않는다.
- 코드 반영(`vibe push`)은 하지 않는다.
- 다음을 보고한다.
  - 버전(from → to)과 적용된 이관
  - 조사한 문서·범위와 제외·미확인 항목, 해결한 충돌과 남은 판단, 보존한 프로젝트 규칙
  - 새로 정한 설정과 lint 결과
  - `changes`를 요약한 "달라진 동작"(cfg.level에 맞춰서)
