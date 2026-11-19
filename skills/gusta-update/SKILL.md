---
name: gusta-update
description: >-
  "/gusta-update, gusta 업데이트, 스킬셋 최신으로 올려줘"에 사용. 설치된 스킬을 갱신하고 spec/ 구조 이관·프로젝트 규칙 대조·검증까지 한다.
---

# gusta-update — 스킬셋 업데이트와 이관

**역할: 업데이트 담당.** 버전 확인 → 프로젝트 규칙 조사 → 설치·이관 → 대조·검증 → 커밋. 제품 코드는 바꾸지 않고, 업데이트 요청을 프로젝트 정책 변경 승인으로 보지 않는다. 명령은 `npx @haeram/gusta@latest`로 실행한다(이하 `gusta`).

## 1. 시작 조건
- 미커밋 변경이 있으면 멈추고 알린다(사용자 변경을 stash·커밋하지 않는다).
- `vibe status --json`에 `design`이 있으면 디자인이 끝났는지 먼저 묻는다.
- 이 checkout에서 `vibe loop`나 `work run`이 실행 중이면 끝난 뒤에 업데이트하라고 안내한다.
- 맡김 세션에서는 업데이트하지 않고 `vibe inbox add --kind parked`로 남긴다.
- 설치·이관·커밋 전에 land·deploy·plan·기본 브랜치 위라면 자기 소유 하위 브랜치로 옮긴다(다른 세션·미커밋 사용자 변경은 건드리지 않는다).

## 2. 버전과 프로젝트 규칙
- `gusta outdated`로 installed·latest·`changes`(installed 이후 CHANGELOG)를 본다. `error`면 레지스트리 조회 실패를 알리고 멈춘다.
- 최신 버전이어도 설치·이관 전에 [프로젝트 규칙 대조](references/project-rules.md)(upgrade-context 전체 조사·테스트 감사·제품 지원 대조)를 끝낸다. 제품 단계가 미정이면 [제품 지원 정책](../gusta-create-architecture/references/product-support.md)의 최초 추천으로 연결한다.
- package.json 의존성에 @haeram/gusta가 있으면 그 패키지 관리자로 올린다(예: `npm i -D @haeram/gusta@latest`, lockfile 포함).
- `outdated`가 false면 설치 갱신은 건너뛰되 `gusta migrate --dry-run`과 규칙 대조를 끝내기 전에는 완료로 보고하지 않는다.

## 3. 갱신과 이관
- `gusta install --dry-run`에 충돌(로컬에서 고친 스킬 파일)이 있으면 목록을 보여 주고 `--force`로 덮어쓸지 묻는다. 그다음 `gusta install`, `gusta agent-block`, `gusta check` 순서로 실행한다.
- `gusta agent-block`이 broken을 보고하면 그 파일·줄을 보여 주고 고칠 방법을 승인받아 마커만 정리한 뒤 다시 실행한다.
- `gusta migrate --dry-run`의 `applied`를 보여 주고(expert는 id·파일, novice는 무엇이 어디로 옮겨지는지) `gusta migrate`를 실행한다.
- 이관은 STATE의 active·inbox·log를 조정 브랜치(SETTINGS `coord`, 기본 `gusta`)의 SESSIONS.md로 옮긴다. 같은 이름의 코드 브랜치 때문에 거절되면 `vibe settings --set coord=<다른 이름>` 뒤 다시 실행한다. 옛 버전 기기와는 선점이 서로 보이지 않으니 모든 기기를 함께 올리라고 보고한다.
- `migrate`가 남긴 `format.missing`·`format.extra`는 줄별 `provenance`로 판단하고(`unknown`은 프로젝트 줄, 출처를 다시 추적하지 않는다) 규칙 대조 3절대로 처리한다. 승인 전에는 의도적인 규칙·예외를 유지하고 역사 기록과 FORMAT 전체를 덮어쓰지 않는다.
- `unset`이 있으면 gusta-init으로 정한다.
- `gusta lint`로 이관이 더한 오류를 고치고 원래 있던 오류는 보고한다.

## 4. 커밋·보고
- 커밋을 나눈다: 설치(`.claude/`·`.codex/`·lock 파일·package.json·lockfile·블록이 갱신된 CLAUDE.md·AGENTS.md)는 `chore: update gusta <from> → <to>`, 이관(spec/만)은 `spec: migrate to gusta <to>`, 승인된 운영 문서는 그 경로의 지침대로 따로. 기획 발행은 프로젝트 지침과 SETTINGS plan의 충돌을 해결한 뒤에만 하고, 코드 반영(`vibe push`)은 하지 않는다.
- 보고:
  - 버전(from → to)과 적용된 이관
  - 조사한 문서·범위와 제외·미확인, 해결한 충돌과 남은 판단, 보존한 프로젝트 규칙
  - 테스트 감사 처분·근거·대체 AC·제거/이동 비용·남은 미확인과 승인/구현할 정리 항목
  - 새로 정한 설정과 lint 결과
  - `changes`를 요약한 "달라진 동작"(cfg.level에 맞춰서)
