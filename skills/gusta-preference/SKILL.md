---
name: gusta-preference
description: >-
  "/gusta-preference, gusta 설정 보여줘, 설정 바꿔줘"에 사용한다. 이 프로젝트에서 gusta가 동작하는 방식을 정하는
  설정(spec/SETTINGS.md)을 표로 보여주고, 사용자가 말한 값만 바꾼다. 예: 브랜치 전략(land·land-via·push·deploy·plan),
  prune-branches(작업이 끝나면 쓰지 않는 브랜치·worktree를 지울지, 기본 true), permission-mode(맡김·워커 세션 권한 우회, 기본 bypass), headless-mcp(그 세션에 MCP 서버를 싣지 않음, 기본 isolate), agents(쓸 AI 도구와 폴백 순서).
---

# gusta-preference — 패키지 동작 설정

**역할: 설정 안내.** `spec/SETTINGS.md`의 값을 보여 주고, 사용자가 말하거나 승인한 값만 바꾼다. 제품 기획·태스크·코드는 다루지 않는다. 설정 키·기본값·뜻의 정본은 CLI이며 프로젝트 정책 변경 승인과는 다르다. 이 문서에 키 목록을 따로 적지 않는다.

## 1. 보기
- `npx @haeram/gusta vibe settings --json`을 한 번 실행한다. `settings`를 표(키 | 값 | 기본값 | 출처 | 뜻)로 보여 준다. 뜻은 `note`를 STATE cfg.lang으로 옮겨 쓴다. 출처가 `default`이면 파일에 그 키가 없어서 기본값을 쓰는 중이라는 뜻이다. `legacy-cfg`이면 예전 STATE cfg에서 읽은 값이므로 `npx @haeram/gusta migrate`로 옮기라고 알린다. 값이 `?`인 키는 gusta-init으로 정한다.
- `errors`가 있으면 해당 줄과 허용 값(`values`)을 알린다. 값이 잘못돼 있으면 그 설정을 쓰는 동작이 실행되지 않는다. 예를 들어 prune-branches 값이 잘못되면 정리가 멈춘다.
- 인자 없이 불렸으면 여기서 끝낸다. 바꿀지 묻지 않는다.

## 2. 바꾸기
- 조회·규칙 조사는 현재 위치에서 할 수 있다. 첫 설치·의존성 변경·이관·설정/agent-block 쓰기·커밋 **전에** Git의 현재 브랜치를 확인하고, land·deploy·plan·저장소 기본 브랜치이면 자기 소유 하위 브랜치를 만들거나 확인한 작업 브랜치로 옮긴다. 다른 세션·checkout·미커밋 사용자 변경을 옮기거나 덮지 않는다.
- 변경 전에 적용 지침과 그 설정에 겹치는 활성 문서·실행 근거를 [프로젝트 규칙 대조](../gusta-update/references/project-rules.md)대로 확인한다(보기만 할 때는 생략). 정책 차이는 프레임워크 기본 절차에 맞추는 안과 영향을 보여 주고 괜찮은지 묻는다. 이미 구체적으로 승인한 변경은 다시 묻지 않는다.
- 승인한 키·값만 `vibe settings --set <key>=<value> --json`으로 쓴다. 파일 생성과 해당 줄 수정은 CLI가 하며 SETTINGS.md를 직접 편집하지 않는다. 승인된 운영 문서도 일치시키며 SSOT 정책 변경은 gusta-update-ssot로 처리한다. CLI가 지원하지 않는 키·절차를 만들어 해결하지 않는다.
- `agent-block`을 바꿨으면 `npx @haeram/gusta agent-block`(false로 바꿨으면 `--remove`)을 실행해 지침 파일의 블록을 맞춘다.
- `coord`(조정 브랜치 이름)는 모든 브랜치·기기의 SETTINGS에서 같아야 세션이 서로 보인다 — 바꾸기 전에 그 점을 알린다.
- `vibe status --json`에 `design`이 있으면 커밋 전에 디자인이 끝났는지 묻는다.
- 변경을 확인해 `settings: <key>=<value>`로 커밋한다. 승인된 spec 변경과 외부 운영 문서는 분리하며, 기획 발행은 프로젝트 규칙과 SETTINGS plan이 합치할 때 spec/만 `vibe plan-push`한다. 코드의 PR 전략이 기획 직접 push까지 허용한다는 뜻은 아니다.
- 바뀐 값과 그 결과로 달라지는 동작을 한 줄로 알린다.
