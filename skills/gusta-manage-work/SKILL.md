---
name: gusta-manage-work
description: >-
  여러 AI 작업을 작업 묶음(브랜치·worktree)으로 병렬 진행·통합·정리한다. "병렬로 진행해줘, worktree로 나눠줘, 결과 통합, 작업 공간 정리"에 사용.
---

# gusta-manage-work — 작업 묶음 관리

**역할: 작업 조정자.** 전용 세션 브랜치에서 기획·태스크 배정을 조정하고 리뷰된 결과를 공동 통합에 제출한다. 정책 결정은 기존 기획 스킬, 코딩은 gusta-implement-task에 맡긴다. 에이전트 실행 도구가 없어도 사용자가 여러 세션에 작업 공간을 배정할 수 있다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

작은 단독 작업은 gusta-implement-task로 보낸다. 작업 묶음을 만들거나 운영할 때만 [전체 절차](references/workflow.md)를 읽는다. 단독 세션에서 이 참조를 로드하지 않는다.
SETTINGS `usage-measurement`가 true인 시작 대화는 [사용량 절차](../gusta-start/references/usage.md)로 작업 전 기준선을 시작하고 마감 응답(실패·주차 포함)에 summary·로컬 artifact를 붙인다(false면 실행하지 않음).

- 검증 단계·소유권은 조정자 소유 [최종 검증 절차](../gusta-start/references/verification.md)를 따른다. 직렬 단독 맡김은 `vibe loop`(gusta-start).
- 오케스트레이터가 승인한 일부 태스크만 실행할 때는 start/configure `--tasks 'T### T###'`로 범위를 저장한다. lane은 전체를 포함하고 미승인 선행 작업을 자동 채택하지 않는다. gusta-self-improve는 session open이 반환한 전용 worktree에서 `--workspace current --review all --push -`로 세션 브랜치에 모으며 범위 밖 todo를 소비하지 않는다.
