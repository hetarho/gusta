---
name: haeram-setting
description: >-
  "/haeram-setting, haeram 설정 보여줘, 설정 바꿔줘"에 사용한다. 이 프로젝트에서 haeram-spec-creator가 동작하는 방식을 정하는
  설정(spec/SETTINGS.md)을 표로 보여주고, 사용자가 말한 값만 바꾼다. 예: 브랜치 전략(land·land-via·push·deploy·plan),
  prune-branches(작업이 끝나면 쓰지 않는 브랜치·worktree를 지울지, 기본 true).
---

# haeram-setting — 패키지 동작 설정

**역할: 설정 안내.** `spec/SETTINGS.md`의 값을 보여 주고, 사용자가 말한 값만 바꾼다. 기획·태스크·코드는 다루지 않는다. 설정 키·기본값·뜻의 정본은 CLI다. 이 문서에 키 목록을 따로 적지 않는다.

## 1. 보기
- `npx haeram-spec-creator vibe settings --json`을 한 번 실행한다. `settings`를 표(키 | 값 | 기본값 | 출처 | 뜻)로 보여 준다. 뜻은 `note`를 STATE cfg.lang으로 옮겨 쓴다. 출처가 `default`이면 파일에 그 키가 없어서 기본값을 쓰는 중이라는 뜻이다. `legacy-cfg`이면 예전 STATE cfg에서 읽은 값이므로 `npx haeram-spec-creator migrate`로 옮기라고 알린다. 값이 `?`인 키는 haeram-init으로 정한다.
- `errors`가 있으면 해당 줄과 허용 값(`values`)을 알린다. 값이 잘못돼 있으면 그 설정을 쓰는 동작이 실행되지 않는다. 예를 들어 prune-branches 값이 잘못되면 정리가 멈춘다.
- 인자 없이 불렸으면 여기서 끝낸다. 바꿀지 묻지 않는다.

## 2. 바꾸기
- 사용자가 키와 값을 말했을 때만 바꾼다(예: `/haeram-setting prune-branches false`). `vibe settings --set <key>=<value> --json`을 실행한다. 파일 생성과 해당 줄 수정은 CLI가 한다. 파일을 직접 편집하지 않는다.
- `vibe status --json`에 `design`이 있으면 커밋 전에 디자인이 끝났는지 묻는다.
- `spec/SETTINGS.md` 하나만 `settings: <key>=<value>` 메시지로 커밋한다. SETTINGS plan이 `-`가 아니면 바로 `vibe plan-push`로 기획 브랜치에 올린다. 그래야 다른 checkout과 worktree도 같은 설정을 쓴다.
- 바뀐 값과 그 결과로 달라지는 동작을 한 줄로 알린다.
