---
name: gusta-preference
description: >-
  "/gusta-preference, gusta 설정 보여줘, 설정 바꿔줘"에 사용. spec/SETTINGS.md를 표로 보여 주고 말한 값만 바꾼다.
---

# gusta-preference — 패키지 동작 설정

**역할: 설정 안내.** `spec/SETTINGS.md`를 보여 주고 사용자가 말하거나 승인한 값만 바꾼다.

## 1. 보기
- `npx @haeram/gusta vibe settings --json`을 한 번 실행해 `settings`를 표(키 | 값 | 기본값 | 출처 | 뜻)로 보여 준다. 뜻은 `note`를 cfg.lang으로 옮긴다. 출처가 `legacy-cfg`이면 `npx @haeram/gusta migrate`로 옮기라고 알린다. 값이 `?`인 키는 gusta-init으로 정한다.
- `errors`가 있으면 그 줄과 허용 값(`values`)을 알린다.
- 인자 없이 불렸으면 여기서 끝낸다(바꿀지 묻지 않는다).

## 2. 바꾸기
- 쓰기·커밋 전에 land·deploy·plan·기본 브랜치 위라면 자기 소유 하위 브랜치로 옮긴다(다른 세션·미커밋 사용자 변경은 건드리지 않는다).
- 그 설정에 겹치는 지침·활성 문서·실행 근거를 [프로젝트 규칙 대조](../gusta-update/references/project-rules.md)대로 확인하고, 정책 차이는 맞추는 안과 영향을 보여 주고 묻는다.
- 승인한 키·값만 `vibe settings --set <key>=<value> --json`으로 쓰고 SETTINGS.md를 직접 편집하지 않는다. 승인된 운영 문서도 맞추고, SSOT 정책 변경은 gusta-update-ssot로 한다.
- `agent-block`을 바꿨으면 `npx @haeram/gusta agent-block`(false로 바꿨으면 `--remove`)을 실행해 지침 파일의 블록을 맞춘다.
- `coord`(조정 브랜치 이름)는 모든 브랜치·기기의 SETTINGS에서 같아야 세션이 서로 보인다고 바꾸기 전에 알린다.
- `vibe status --json`에 `design`이 있으면 커밋 전에 디자인이 끝났는지 묻는다.
- `settings: <key>=<value>`로 커밋한다(spec 외 운영 문서는 따로). 기획 발행은 프로젝트 규칙과 SETTINGS plan이 합치할 때만 spec/만 `vibe plan-push`한다.
- 바뀐 값과 그 결과로 달라지는 동작을 한 줄로 알린다.
