---
name: manage-work
description: >-
  혼자 여러 AI 작업을 병렬로 진행할 때 작업 묶음 브랜치와 태스크별 worktree를 관리한다.
  "작업을 병렬로 진행 / worktree로 나눠줘 / 작업 묶음 시작 / 결과 통합 / 작업 공간 정리" 요청에 사용한다.
  외부 도구 없이 Git만으로 동작하며, Orca 등에서 만든 작업 공간도 수용한다. 작은 단독 구현은 implement-task로 진행한다.
---

# manage-work — 작업 묶음 관리

**역할: 작업 조정자.** 상위 브랜치에서 기획·태스크 배정을 조정하고 리뷰 승인과 검증을 통과한 결과를 통합한다. 정책 결정은 기존 기획 스킬, 코딩은 implement-task에 맡긴다. 에이전트 실행 도구가 없어도 사용자가 여러 세션에 작업 공간을 배정할 수 있다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다.
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

작은 단독 작업은 implement-task로 보낸다. 작업 묶음을 만들거나 운영할 때만 [전체 절차](references/workflow.md)를 읽는다. 단독 세션에서 이 참조를 로드하지 않는다.

- 시작/재개: `work status --json`, `work board --work <id> --json`으로 배정·기획 공간·막힌 이유를 확인한다. 브랜치 이름으로 소유권을 추정하지 않는다.
- 기본 검증 매핑: ARCH task → `--task-verify`, 빠른 통합 검사 → `--verify`, 통합/e2e·전체 스위트 → `--group-verify`, CI → 최종 코드 push 뒤 한 번. 사용자 별도 명시가 없으면 조정자 소유 [최종 검증 절차](../start-vibe/references/verification.md)를 따른다. 기존 묶음도 저장된 명령을 확인하고 관문이 실행 중이 아닐 때 configure로 맞춘다. 기본은 로컬 작업 브랜치에 모으고 단위별 push를 켜지 않는다.
- 기획·SSOT·채번은 group.path에서만, cfg plan 브랜치(기본 `main`) 기준으로: 기획 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`. 워커는 자기 코드·acceptance 체크·result만 수정한다. doing/done 계약은 바꾸지 않는다.
- 통합은 CLI의 잠금·검증·원격 판정을 따른다. 실패·충돌·미커밋 변경을 보존하며 선점을 임의로 회수하지 않는다.
- 오케스트레이터가 승인한 일부 태스크만 실행할 때는 start/configure `--tasks 'T### T###'`로 범위를 저장한다. lane은 전체를 포함하고 미승인 선행 작업을 자동 채택하지 않는다. self-improve-local은 `--workspace current --review all --push -`로 현재 브랜치에 통합하며 범위 밖 todo를 소비하지 않는다.
- headless runner는 `work run`; 직렬 단독 맡김은 `vibe loop`. 긴 명령은 완료 이벤트까지 CLI가 기다리며 모델 폴링을 하지 않는다.
