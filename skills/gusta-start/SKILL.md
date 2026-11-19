---
name: gusta-start
description: >-
  만들어 둔 태스크를 맡겨 실행한다. "/gusta-start, 시작하자, 이어서 해줘, 남은 거 해줘, 알아서 해줘"에 사용. `/gusta-start <변경 요청>`이면 기획부터 구현까지 묻지 않고 끝낸다. 태스크가 없으면 /gusta-plan을 안내한다.
---

# gusta-start — 맡김 실행자

**역할: 진행자.** 이미 구상된 태스크를 사람 없이 끝까지 실행시킨다 — 실행 순서·커밋·진행 표시·결정함·보고서를 지킨다. 기획·기술 판단은 고른 스킬이 한다. 이 대화가 오케스트레이터이고, 구현은 `vibe loop`가 띄우는 단위 세션이 한다. loop 단위 세션(`GUSTA_VIBE_UNIT=1`)은 이 스킬 대신 [단위 계약](references/unit.md)을 따른다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

CLI는 `npx @haeram/gusta` 뒤에 붙인다.

## 1. 시작 — 보여 주고 바로 실행
인자로 태스크 ID(`T012 T013`)·시간 한도(`4시간`·마감 시각)·작은 수정 요청·기획 변경 요청을 받는다. 묻지 않는다. 인자가 없으면 STATE·태스크대로 실행한다.
1. `vibe status --tag <tag> --json`으로 cfg·다른 세션·inbox 수·runnable·남은 일을 본다. 원격이 앞서 있으면 깨끗한 트리에서 sync한다. 실행기 밖 초기화·선점이 필요할 때만 [세션 절차](references/session.md)를 읽는다.
2. SETTINGS `usage-measurement`가 true인 시작 대화는 분기 전에 [사용량 기준선](references/usage.md)을 시작하고, 아래 조기 종료에도 5절의 Markdown 보고·채팅 요약/링크를 붙인다.
3. 멈추는 경우 — 한 줄로 끝낸다:
   - 기획 변경 요청 인자 없이 실행할 태스크가 없으면(route `sketch-first`): "실행할 태스크가 없습니다 — /gusta-plan으로 먼저 기획하고 태스크까지 만드세요". 미룬 구상·태스크로 안 쪼갠 SSOT 변경·채택 review가 있으면 목록을 붙인다.
   - route `design`: "디자인이 열려 있습니다 — /gusta-design-mode로 마감한 뒤 다시 실행하세요".
   - `settings.unset`에 `agents`: gusta-init으로 보낸다.
4. 쓰기 전에 `vibe session open --kind start --tag <tag> --json`으로 전용 worktree·하위 브랜치를 확보하고 이후 cwd를 반환된 targetRoot로 둔다. 원래 checkout의 미커밋 작업은 건드리지 않는다.
5. 규칙·동작을 바꾸는 요청이면 [요청 실행](references/request.md)을 읽는다.
6. 실행 정보를 한 번 보여 주고 답을 기다리지 않고 시작한다: 대상 태스크(ID·제목), dep 순서·병렬(lane), 마감, 검증 단계, 반영 설정(land·land-via·push), 단위별 배정(`vibe loop --dry-run`의 `routing`), 다른 세션·기기의 진행(`others` — `pushed:false`는 "아직 push 안 됨")과 건너뛸 태스크(`held`·`unlanded`), 결정함 미확인 수, 완료 알림 연결 여부, ARCH의 [제품 지원](../gusta-create-architecture/references/product-support.md) 단계(미정이면 최초 기획 연결부터 한다).
7. ARCH 검증 연결에 빠진 실행 범위가 있으면 [검증 절차](references/verification.md)대로 연결한다.
8. preflight가 사람만 고칠 수 있는 문제(needsUser: 권한 규칙·인증·원격)로 실패하면 목록과 고칠 방법을 한 번 묻는다 — 실행 중 유일한 질문이다. 고쳐지지 않으면 멈춘다.

## 2. 실행 — 이 대화가 오케스트레이터
- `vibe loop --tag <tag> --json`이 단위마다 새 세션을 띄운다(도구·모델은 CLI가 태스크 `run:`대로 정한다 — `--provider`를 붙이지 않는다). loop 옵션(마감·`--tasks`·단위 상한·권한 모드)과 실행 중 설정 변경·취소·정지는 [세션 절차](references/session.md)를 먼저 읽는다.
- 완료 대기로 종료 결과를 받아 판단한다. CLI 종료를 작업 완료로 보고하지 않는다. `--detach`는 완료를 이 대화로 돌려주는 연결이 있을 때만 쓴다.
- 사용자 목표·마감·회복 예산·검증·원격 결과는 이 대화가 끝까지 책임진다. 실행기가 실패해도 남은 일을 대조해 회복할 수 있으면 잇는다 — 이미 쓴 시도·마감·한도는 초기화하지 않는다. CLI 결함은 익명화해 보고서에 남기고 대상 프로젝트 작업에 패키지 수정을 끼워 넣지 않는다.
- 작업 묶음은 사용자의 병렬 요청, 또는 독립 단위 2개 이상·각 태스크 3개 이상·touches 분리·explore 제외일 때만 [조정자 절차](references/coordinator.md)로 한다.

| 상황 | 다음 |
|---|---|
| dep 충족 todo·자기 doing | `vibe loop` — 단위가 태스크 1개씩 gusta-implement-task로 |
| 규칙·동작을 바꾸는 요청 | [요청 실행](references/request.md): 해석을 보여 주고 `vibe loop --request-file` |
| 작은 버그·문구·스타일 수정 요청 | 아래 경량 경로 |
| route repair(FORMAT 밖 st, 손으로 닫은 태스크) | 문서·STATE를 FORMAT에 맞게 복구하고 gusta-implement-task 5절로 마감 후 lint(정상 완료 기록 보존) |
| inbox 정리 요청 | `vibe inbox list`에서 확인받은 것만 `vibe inbox resolve --id <id> --log '<한 줄>'`(결정을 바꾸는 요청은 /gusta-plan) |
| 원격에서 이어가기·상태 보존만 | `vibe checkpoint --handoff --tag <tag>` — 수정·반영 없이 원격 브랜치·SHA·검증 상태·다음 작업 반환 |
| 일 없음·parked만 남음 | 미반영 CI 수정·해결 가능한 blocked부터. ARCH에 활성·기한 도래한 지속 개선 위임이 있으면 gusta-self-improve-remote 한 사이클, 없으면 마감 |

경량 경로는 SSOT 규칙·계약·저장 형식·마이그레이션 변경과 새 결정이 없고, 코드+테스트 3파일·100줄 이하(STATE 제외)일 때만이다: 구현 → 영향 테스트 → 커밋 하나 → `vibe log --text 'fix <area>: <what>'`. 조건이 깨지면 기획 한 조각(gusta-update-ssot+gusta-create-task)으로 태스크를 만들어 실행한다.

## 3. 맡김 규칙
- 실행 중 질문은 0회다. 되돌릴 수 있는 기획·기술 판단은 위임받은 것이다 — 추천안으로 정하고 질문·선택·대안·이유를 `vibe inbox add --kind decided --ref <ID> --text '<줄>'` 한 번으로 남긴다(따옴표·`|`가 섞이면 `--file`). SSOT에는 일반 [o]만 쓴다.
- 해당 작업만 parked로 두고 다른 일로 간다: 과금·데이터 삭제·개인정보·보안 정책([?]), 되돌리기 어려운 일(배포·게시·force push·브랜치 삭제·전역 설정·외부 메시지·공유 데이터 변경), 실제 권한·인증 부재.
- 사용자가 중단·먼저 반영·보고 등 새 지시를 주면 [제어 계약](references/loop-control.md)으로 소유한 실행을 취소·정리한 뒤 처리한다. 하드 관문·권한은 우회하지 않는다.
- **권한 창을 만들지 않는다** — 사람이 없으면 세션이 멈춘다. 셸 호출 하나에 일 하나(`cd`를 섞지 않고 절대 경로·`git -C`), 쓰기는 작업 공간·세션 임시 폴더 안에서만, `rm -rf`·`kill`·`sudo`·`chmod`·`curl`/`wget`·전역 설치·force push·`reset --hard`·`clean`·브랜치 삭제·권한 설정 수정·부하 에이전트는 쓰지 않는다. 병렬은 `work run`으로만 한다. 그래도 필요한 일은 parked로 남긴다.

## 4. 커밋·검증·반영
- 태스크·기획 조각·경량 수정마다 관련 파일만 커밋한다. 보고서는 태스크 3개·기획 조각 소진·세션 끝 중 먼저 온 경계에 갱신한다. 무관한 사용자 변경은 커밋하지 않는다.
- 기획 커밋은 `vibe plan-sync` 뒤 spec/만 담아 커밋 직후 `vibe plan-push`한다. ID 충돌이면 다시 채번하고, 실패하면 parked로 남기고 그 태스크를 구현하지 않는다.
- 끝난 작업은 공동 통합에 ready로 제출한다. land 반영은 고정 후보를 검수한 한 소유자만 SETTINGS `land`·`land-via`·`push`대로 한다. land 미정이면 작업 브랜치의 커밋과 미반영 사유를 남긴다.
- 검증 단계·agent acceptance는 [검증 절차](references/verification.md)를 따른다.
- 1시간마다, 긴 명령 전에 `vibe checkpoint --tag <tag>`.
- "배포해줘"는 [세션 절차](references/session.md)를 읽고 `vibe deploy`로 한다.
- 프로젝트 지침이 패키지 기본과 실제로 충돌하면 [규칙 대조](../gusta-update/references/project-rules.md)대로 한다 — 실행 중에는 parked로 남긴다.

## 5. 마감
- 측정을 시작한 최상위 대화는 [사용량 보고](references/usage.md)로 Markdown을 저장하고 최종 채팅에 summary·reportFile 링크를 전달한다(할 일 없음·실패·주차도 동일, JSON artifact만으로 끝내지 않는다).
- 종료 영수증으로 목표 완료나 실제 중단 사유를 확인한 뒤 보고한다: 검증 실패·시도 횟수, 남은 수정 태스크, push 여부·원격 SHA, 보고서, agent acceptance의 수행/실패/미실행. 기준에서 빠진 시나리오가 있는지 사용자에게 확인을 요청하되 답을 기다리지 않는다.
- 돌아온 사용자는 새 대화에서 `/gusta-start`로 잇는다 — 상태는 보고서·결정함·loop.json에 남아 있다.
