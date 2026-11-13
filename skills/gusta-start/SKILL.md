---
name: gusta-start
description: >-
  만들어 둔 태스크를 맡겨 실행하는 진입점. "/gusta-start, 시작하자, 이어서 해줘, 남은 거 해줘, 나 나갈게 알아서 해줘" 일 때 사용.
  인자 없이 부르면 STATE와 원격을 읽어 실행할 태스크·순서·검증·반영 설정·다른 세션·기기의 진행을 보여 주고 묻지 않고 바로 실행한다
  (태스크별 커밋, push는 기본으로 하지 않음, 실행 중 판단은 추천안으로 정해 결정함(inbox)과 보고서에 남김).
  "/gusta-start <동작>을 이렇게 바꿔줘"처럼 기획 변경 요청과 함께 부르면 SSOT 수정·태스크 생성부터 구현·검증까지 묻지 않고 끝낸다.
  실행할 태스크도 요청도 없으면 멈추고 /gusta-sketch로 먼저 구상하라고 안내한다.
---

# gusta-start — 맡김 실행자

**역할: 진행자.** 이미 구상된 태스크를 사람 없이 끝까지 실행한다 — 실행 순서·커밋·진행 표시·결정함·보고서를 지킨다. 기획 변경 요청을 인자로 받으면 그 요청을 기획 한 조각(SSOT·태스크)으로 옮긴 뒤 같은 방식으로 실행한다. 기획·기술 판단은 하지 않는다 — 고른 스킬이 자기 역할로 한다. 스킬 절차를 여기서 다시 쓰지 않는다.
**철학**: 미리 잘 구상해 두면(/gusta-sketch) 그다음은 자동으로 돈다. AI가 만들고 사람은 고른다 — 실행 중 판단은 추천안으로 정하고 결정함에 남겨 사람이 나중에 고른다. 문서 먼저 · 적은 토큰 · 빠른 구현 — 시간은 구현에 쓰고 무거운 검증은 마감 관문 한 번에 모은다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 /gusta-sketch로 먼저 구상하라고 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않는다 — land 미정이면 현재 브랜치에 커밋만 하고, agents 미정이면 맡김을 시작하지 않는다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 문서 상태를 STATE에, 세션 기록(시작·상태 변화·활동)을 `vibe` 명령으로만(`beat`·`claim`·`inbox`·`log`) 남기고 SESSIONS.md를 직접 고치지 않는다. 워커는 STATE·SSOT·세션 기록 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. gusta-start가 맡긴 실행(실행기·loop 단위 포함)에서는 묻지 않는다 — 추천안으로 진행하고 inbox(`vibe inbox add`)와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(gusta-start 3절). 사용자가 직접 부른 스킬(gusta-sketch 등)은 묻는다.
5. **읽기**: status 요약·`vibe brief <T###|ID-n|ID@rev> --summary`로 필요한 범위를 찾는다. 큰 brief는 `--section decisions|tasks --offset <n> --limit <n>`으로 원문 블록째 읽고 모든 필요 블록의 coverage를 확인한다. 전체 brief의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 보고서도 필요한 절만 읽고, 출력은 요약·tail, 전체 로그는 파일로 남긴다.

CLI는 `npx @haeram/gusta` 뒤에 붙인다. 실행기의 cliCommand가 있으면 그 경로를 사용한다.

## 1. 시작 — 보여 주고 바로 실행
`vibe status --tag <tag> --json`으로 cfg·다른 세션·inbox 수·runnable·남은 일만 본다. 앞선 원격은 깨끗한 트리에서 sync한다. 실행기 밖 초기화·선점은 필요할 때만 [세션 절차](references/session.md)를 읽는다.
- SETTINGS `usage-measurement`가 true인 시작 대화는 분기 전에 [사용량 기준선](references/usage.md)을 시작하고 아래 조기 종료에도 5절의 Markdown 보고·채팅 요약/링크를 붙인다(false면 실행하지 않음).
- 기획 변경 요청 인자 없이 실행할 태스크가 없으면(route `sketch-first`) "실행할 태스크가 없습니다 — /gusta-sketch로 먼저 구상하고 태스크까지 만드세요" 한 줄로 끝낸다. 미룬 구상(open/ready ideation)·태스크로 아직 안 쪼갠 SSOT 변경·채택 review가 있으면 그 목록도 붙인다. 여기서 기획·태스크를 만들지 않는다.
- route `design`(이 checkout이 디자인 중)이면 디자인 변경을 건드리지 않고 "디자인이 열려 있습니다 — /gusta-design-mode로 마감한 뒤 다시 실행하세요"로 끝낸다.
- `settings.unset`에 `agents`가 있으면 맡김을 시작하지 않고 gusta-init으로 보낸다(쓸 AI 목록이 없으면 CLI가 단위를 배정하지 못한다 — loop·work run은 `needs-init`으로 멈춘다).
- 실행 전에 한 번 보여 준다 — 질문이 아니므로 답을 기다리지 않고 바로 시작한다: 대상 태스크(ID·제목, 인자로 범위를 줬으면 그 범위), dep 순서와 병렬 여부(작업 묶음이면 lane), 마감·예약 시간, 검증 단계(태스크 단계·최종 관문 명령 요약), 반영 설정(SETTINGS land·land-via·push), 단위별 배정(`vibe loop --dry-run`의 `routing`: 태스크·추천·실제 조합), 다른 세션·기기의 진행(`others` — `pushed:false`는 "아직 push 안 됨")과 건너뛸 태스크(`held`·`unlanded` — 가로채지 않는다), 결정함 미확인 수, 완료 알림 연결 여부.
- 검증의 `declared`·`partial`과 적용 지침의 미연결 명령·조건을 확인한다. 빠진 실행 범위가 있으면 [검증 절차](references/verification.md)대로 실제 명령과 ARCH 단계/계획을 연결하고 지원 한계를 밝힌다. 부분 성공을 잃는 외부 스크립트를 새로 만들지 않으며, 기존 단계 명령으로 충분하면 유지한다.
- 인자로 태스크 ID(`T012 T013`)·시간 한도(`4시간`·마감 시각)·작은 수정 요청·기획 변경 요청을 받는다. 묻지 않는다. 인자가 없으면 STATE·태스크대로 실행한다. 규칙·동작을 바꾸는 요청이면 [요청 실행](references/request.md)을 읽고 SSOT·태스크부터 만든 뒤 그 범위만 실행한다.
- preflight가 사람만 고칠 수 있는 문제(needsUser: 헤드리스 권한 규칙·인증·원격 등)로 실패하면 그 목록과 고칠 방법을 한 번 묻는다 — 사용자가 방금 불렀으니 아직 자리에 있다. 실행 중 유일한 질문이며, 고쳐지지 않으면 실행하지 않고 멈춘다.
단위1·hostManaged가 아니면 **시작한 대화가 오케스트레이터**다. 사용자 목표·마감·총 회복 예산·검증·원격 결과를 끝까지 책임진다. `vibe loop --tag <tag> --json`은 새 단위 세션·active·보고서·관문을 돕는 실행기다(단위의 도구·모델·에포트는 CLI가 태스크 `run:`대로 정한다 — `--provider`를 붙이지 않는다). 도구/하네스의 완료 대기로 종료 결과를 받아 판단하고, CLI 종료를 사용자 작업 완료로 보고하지 않는다. `--detach`는 이 대화로 완료를 돌려 실제 후속 턴을 여는 연결이 있을 때만 쓴다. 연결이 없으면 자동 후속·통지가 안 됨을 밝히고 기다릴 수 있는 실행 방식을 쓴다. 작업 묶음 조건이면 [조정자 절차](references/coordinator.md)를 읽는다.
loop를 띄우기 전(마감 예약·`--tasks`·단위 상한·권한 모드)과 실행 중 설정 변경·취소·정지는 [세션 절차](references/session.md)의 loop 옵션을 먼저 읽는다.
`/gusta-start 맡김 단위1` 또는 `GUSTA_VIBE_UNIT=1`이면 시작 질문 없이 배정된 **태스크 1개 done** 또는 그 회복(이어가기·쪼개기)이 요구한 **기획 한 조각**만 끝낸다. 기획 조각은 gusta-update-ssot(필요하면 gusta-create-ssot)+gusta-create-task를 같은 세션에서 끝내고 읽은 결정을 재사용한다. 태스크로 안 쪼갠 SSOT 변경·review·ideation은 기획하지 않는다(사용자의 /gusta-sketch가 태스크로 만든다). 그 뒤 구현으로 넘어가지 않는다. 구현을 부하 에이전트에 분할하지 않는다.
hostManaged 실행기에서는 초기화·active·보고서 생성/종료·묶음 검증·완료 push·CI를 호스트에 맡긴다. 같은 tag·보고서를 잇고 재초기화하지 않는다. 헤드리스 세션 권한은 SETTINGS `permission-mode`(기본 bypass — 권한 창·sandbox 없음)를 따르고 따로 묻지 않는다. acceptEdits면 allow 목록만 쓴다.

## 2. 무엇을 실행하나
인자를 먼저 해석하고 없으면 route·dep을 따른다.

| 상황 | 다음 |
|---|---|
| spec 없음·실행할 태스크 없음(route sketch-first) | 1절 안내로 마감 — /gusta-sketch |
| route design | 1절 안내로 마감 |
| route repair(issues: FORMAT 밖 st, 손으로 닫은 태스크) | 문서·STATE 상태를 FORMAT에 맞게 복구하고 gusta-implement-task 5절 마감(`vibe task start`→`vibe task done`) 후 lint; 정상 완료 기록은 보존 |
| dep 충족 todo·자기 doing | vibe brief T### → gusta-implement-task 1개 |
| 작은 버그·문구·스타일 수정 요청 | 아래 경량 경로 |
| 규칙·동작을 바꾸는 요청(시작 대화) | [요청 실행](references/request.md): 기획 한 조각 → 그 태스크 실행 |
| 기획·기술 판단으로 blocked | 추천안으로 기획 한 조각을 끝내고 해당 태스크를 재개 가능하게 복구 |
| inbox 정리 요청 | `vibe inbox list`의 항목 중 확인받은 것만 `vibe inbox resolve --id <id> --log '<한 줄>'`(결정을 바꾸는 요청은 /gusta-sketch) |
| 원격에서 이어가기·현재 상태 보존만 요청 | `vibe checkpoint --handoff --tag <tag>`; 수정·최종 반영을 시작하지 않고 원격 브랜치·SHA·검증 상태·다음 작업 반환 |
| 일 없음·parked만 남음 | 미반영 CI 수정·해결 가능한 blocked부터 확인. 일반 조정자 세션에서 활성·기한 도래한 지속 개선 위임이 있으면 gusta-self-improve-remote 한 사이클, 아니면 마감(다음 구상은 /gusta-sketch); 위임 없이 새 일을 만들지 않는다 |

경량 경로는 모두 만족할 때만: SSOT 규칙·계약·저장 형식·마이그레이션 변경 없음, 새 결정 없음, 버그/문구/스타일 수정, 코드+테스트 3파일·추가+삭제 100줄 이하(STATE 제외). 태스크·rev 없이 구현 → 영향 테스트+빠른 검사 → 커밋 하나 → `vibe log --text 'fix <area>: <what>'`. 조건이 깨지거나 결정·기획 공백이 나오면 추천안으로 기획 한 조각(gusta-update-ssot+gusta-create-task)을 끝내고 태스크로 올린다.
작업 묶음은 단위1에서 만들지 않는다. 사용자의 병렬 요청 또는 독립 단위 2개 이상·각 태스크 3개 이상·touches 분리·explore 제외일 때만 [조정자 절차](references/coordinator.md)를 읽는다.
지속 개선 자동 진입은 저장된 ARCH 정책과 대상 프로젝트의 에이전트 지침이 연결된 일반 조정자 세션에만 적용한다. hostManaged·단위1은 배정된 한 단위만 끝내며 자체 개선 사이클·리뷰·push를 시작하지 않는다. `vibe loop`의 no-work·needs-sketch 종료는 그대로다. 세션 밖 반복은 gusta-self-improve-remote의 실행기 연결 절차로 설정한다.

## 3. 맡김 규칙
실행 중 질문은 0회이며 **되돌릴 수 있는 기획·기술 판단도 위임받은 것**이다. "사용자 의사결정 필요"만으로 blocked·parked·마감하지 않는다. 스킬이 만든 질문은 해당 스킬에서 추천안으로 결정하고 inbox decided에 질문·선택·대안·이유를 남긴다(`vibe inbox add --kind decided|parked --ref <ID> --text '<줄>'` 한 번 호출, 따옴표·`|`가 섞이면 `--file`). SSOT에는 일반 [o]만 쓴다. 공백·모순은 gusta-update-ssot+gusta-create-task 한 조각으로 해소하고 태스크·STATE의 base·dep·st를 맞춰 다음 단위에서 재개한다.
- 문서 마감·결과 수정·커밋 잔여·단위 시간 소진은 외부 의존성이 아니다. 시작 대화/호스트의 기존 이어받기 경로로 같은 tag·원래 마감·누적 상한 안에서 끝내며, `blocked`에는 실제 외부 의존성과 재개 조건을 적는다. 전체 예산 소진은 그 한도로 보고한다.
- 사용자가 중단·먼저 반영·보고 등 새 지시를 주면 기본 계획을 재평가한다. [제어 계약](references/loop-control.md)으로 소유한 실행을 취소하고 하위 검사 정리를 확인한 뒤 지시를 처리한다. 남은 검사를 자동 재개하지 않으며, 명시한 검증 예외·미완료 검사를 정확히 보고하고 하드 관문·권한은 우회하지 않는다.
- 이미 승인된 후속 작업이 CI를 막으면 실제 선행 결과·touches·진행 중 소유권을 확인하고 미착수 태스크의 순서를 조정한다. 태스크와 STATE의 dep을 함께 갱신한다. 완료기준을 낮추거나 검사를 빼서 통과시키지 않는다.
- 과금·데이터 삭제·개인정보·보안 정책은 [?]+parked. 배포·게시·force push·브랜치 삭제·전역 설정·외부 메시지·공유 데이터 변경 등 되돌리기 어려운 일, 실제 권한·인증 부재도 해당 작업만 parked로 남기고 다른 실행 가능한 태스크로 간다.
- **권한 창을 만들지 않는다.** 맡김의 권한 확인 창은 질문과 같다 — 사람이 없으니 세션이 멈추고, 그동안 캐시가 식어 토큰이 다시 든다. 위험해서 확인이 필요해 보여도 묻지 않고, 창이 뜰 만한 호출 자체를 하지 않는다:
  - 셸 호출 하나에 일 하나. `cd`를 `;`·`&&`·파이프로 다른 명령과 섞지 않고 절대 경로·`git -C`를 쓴다. 읽기와 쓰기·삭제를 한 호출에 섞지 않는다.
  - 쓰기·삭제는 현재 checkout(워커는 배정된 worktree)과 세션 임시 폴더 안에서만. 상위 폴더·다른 worktree·홈·시스템 경로는 건드리지 않는다.
  - `rm -rf`·`kill`/`pkill`·`sudo`·`chmod`·`curl`/`wget`(다운로드·웹 조회)·전역 설치·`git push --force`/`reset --hard`/`clean`/브랜치 삭제·권한 설정 파일 수정은 하지 않는다(쓰지 않는 브랜치 정리는 `vibe prune`이 설정대로 한다). 프로세스·CI·작업 상태는 `ps`나 웹 조회 대신 `work board`·`vibe ci wait`·백그라운드 완료 알림으로 본다.
  - 부하 에이전트(Agent 도구)를 띄우지 않는다 — 그 도구 호출의 권한 창도 이 세션을 멈춘다. 병렬은 헤드리스 실행기(`work run`)로만 한다.
  - 그래도 필요한 일(디스크 정리, 다른 worktree 정리, 권한 추가, 프로세스 종료)은 하지 않고 inbox parked·보고서에 남긴 뒤 다른 일로 간다. 실행 가능한 일이 없으면 마감한다.

## 4. 커밋·검증·push
적용되는 프로젝트 지침·운영 문서가 패키지 기본과 실제로 충돌하면 [규칙 대조](../gusta-update/references/project-rules.md)대로 기본 절차 정리를 권유하고 승인받는다. 실행 중에는 묻지 않으므로 미승인 차이를 parked로 남긴다(정리는 사용자가 /gusta-update로). 이 절차는 그 충돌에만 적용하며 매 태스크마다 전체 문서를 다시 조사하지 않는다.
- 커밋: 태스크·기획 조각·경량 수정마다 관련 파일만 커밋한다. 실행기 밖에서는 태스크의 doing을 첫 작업 커밋에 포함하고(선점·세션 행은 커밋할 것이 없다) 보고서는 태스크 3개(기본)·기획 조각의 태스크 소진·세션 끝 중 먼저 온 묶음 경계에 갱신한다.
- 기획 문서는 SETTINGS plan 브랜치(미정이면 land, land도 브랜치가 아니면 저장소 기본 브랜치)에 항상 최신으로 둔다: 기획 조각은 `vibe plan-sync`로 시작하고, 기획 커밋은 spec/만 담아 커밋 직후 `vibe plan-push`한다. 코드 반영 규칙(SETTINGS land·push)과 무관하다. ID 충돌로 거절되면 고른 기획 스킬이 다시 채번해 올린다. 충돌·권한 문제로 실패하면 inbox parked에 남기고 구현으로 넘어가지 않는다(번호가 정본에 없는 태스크를 구현하지 않는다).
- 끝난 작업의 반영은 SETTINGS `land`·`land-via`·`push`가 정한다. 세션 끝·반복기 멈춤에 최종 검증 뒤 `vibe push --verified-commit <SHA>`를 한 번 실행한다. push가 true면 원격, false면 로컬 land 브랜치, pr이면 PR로 반영하고, 할 일이 없으면 CLI가 none으로 끝낸다. 반영 대상은 묻지 않는다. push마다 원격 CI가 돌아 빌드 시간을 쓰므로 묶음 경계마다 push하지 않는다. land가 미정이면 현재 브랜치에 커밋만 한 뒤 inbox parked에 남긴다(정하는 것은 /gusta-init).
- "배포해줘"(`vibe deploy`)는 [세션 절차](references/session.md)를 읽고 한다.
- 검증: 태스크 단계는 gusta-implement-task 4절(영향 단위 테스트+빠른 검사). 통합·e2e·전체 스위트·CI는 작업을 시작한 **조정자/loop 호스트 하나가 최종 통합 후보에서 push 직전**(커밋만 남기면 전체 완료 관문) 한 번 — 관문·CI 대기(`vibe ci wait`)는 [조정자 검증 절차](references/verification.md). ARCH 검증 단계를 고치는 기획 조각도 그 이관 규칙을 읽는다.
- 실행기 실패·종료 뒤에도 시작 대화가 목표와 남은 일을 대조한다. 회복 가능한 CLI 문제면 새 하위 단위/일반 스킬 절차로 이어서 끝낸다. 이미 쓴 시도·원래 마감·검증·권한은 유지하고, 무진행·총 한도를 재시작으로 초기화하지 않는다. CLI 결함은 익명화해 보고서에 남겨 나중에 패키지에서 고친다; 대상 프로젝트 작업에 패키지 수정을 끼워 넣지 않는다. 실제 권한 부재·마감·회복 한도에 닿으면 미완료 사유와 재개 작업을 명시한다.
- 1시간마다, 긴 명령 전 `vibe checkpoint --tag <tag>` 유지(push 브랜치가 없으면 로컬 `wip/<tag>`에만 남는다). 무관한 사용자 변경은 커밋하지 않는다.

## 5. 마감
측정을 시작한 최상위 대화는 [사용량 보고](references/usage.md)로 Markdown 파일을 저장하고 최종 **채팅**에 summary·reportFile 링크를 전달한다(할 일 없음·실패·주차도 동일, JSON artifact만으로 끝내지 않음).
단위1은 다음 단위로 넘어가지 않고 JSON 한 줄(호스트가 요구하면 스키마 결과):
`{"kind":"task","id":"T001","outcome":"completed","pushed":false,"next":"implementation"}`
kind=task|planning|inbox|fix|none, outcome=completed|parked|blocked|no_work. pushed는 실제 여부. 시작 대화는 종료 영수증을 받아 사용자 목표의 완료 또는 실제 중단 사유를 확인한 뒤 보고한다: 검증 실패/시도 횟수·남은 수정 태스크·push 여부·원격 SHA·보고서. 자동 통지 연결 여부도 실행 전에 밝힌다. 종료 뒤 돌아오는 사용자는 새 대화에서 `/gusta-start`로 이어갈 수 있다 — 상태는 보고서·결정함·loop.json에 남긴다.
