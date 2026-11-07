---
name: start-vibe
description: >-
  작업의 진입점. "/start-vibe, 작업 시작하자, 이어서 해줘, 남은 거 해줘, 나 나갈게 알아서 해줘" 일 때 사용.
  STATE와 원격을 읽어 다른 기기의 진행을 확인하고, 시작할 때 한 번에 묻는다(모드: 함께=내가 결정 / 맡김=묻지 않고
  추천안으로 진행). 그 뒤 기획(create-ssot·update-ssot·create-task)과 구현(implement-task)을 스스로 골라 진행하고
  태스크별로 커밋한다(push는 기본으로 하지 않는다). 맡김이면 결정함(STATE inbox)과 보고서를 남긴다. 아이디어를 쏟아내는 일은 ideation,
  화면을 보며 디자인을 다듬는 일은 start-design. 사전 위임 범위에서 문제를 찾아 지속 개선하는 일은 self-improve.
---

# start-vibe — 작업 진행자

**역할: 진행자.** 다음에 할 일을 고르고(라우팅) 모드·커밋·진행 표시·결정함·보고서를 지킨다. 기획·기술 판단은 하지 않는다 — 고른 스킬이 자기 역할로 한다. 스킬 절차를 여기서 다시 쓰지 않는다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture로 보낸다.
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

기본 검증 소유자는 작업을 시작한 조정자/loop 호스트 하나다. 구현·리뷰 세션은 통합/e2e·전체 스위트를 띄우지 않고, 최종 push 전 검증은 [조정자 검증 절차](references/verification.md)를 따른다. 별도 명시가 없는 단위별 push·세션 종료 e2e는 하지 않는다.

CLI는 `npx haeram-spec-creator` 뒤에 붙인다. 실행기의 cliCommand가 있으면 그 경로를 사용한다.

## 1. 시작·단위1
`vibe status --tag <tag> --json`으로 cfg·active·inbox 수·next·남은 일만 본다. 원격 오류면 선점하지 않는다. 앞선 원격은 깨끗한 트리에서 sync한다. 함께(pair)와 실행기 밖 초기화는 필요할 때만 [세션 절차](references/session.md)를 읽는다.
장기 맡김은 `vibe loop --tag <tag> --provider claude|codex --json`: 바깥 CLI가 단위마다 새 세션을 띄운다. 이 대화 안에서 남은 일을 끝까지 반복하지 않는다.
`/start-vibe 맡김 단위1` 또는 `HAERAM_VIBE_UNIT=1`이면 시작 질문 없이 정확히 **태스크 1개 done / 기획 한 조각 / inbox 정리 / 작은 수정** 중 하나만 끝낸다. 기획 조각은 update-ssot(필요하면 create-ssot)+create-task를 같은 세션에서 끝내고 읽은 결정을 재사용한다. 그 뒤 구현으로 넘어가지 않는다. 구현을 부하 에이전트에 분할하지 않는다.
hostManaged 실행기에서는 초기화·active·보고서 생성/종료·묶음 검증·완료 push·CI를 호스트에 맡긴다. 같은 tag·보고서를 잇고 재초기화하지 않는다. 기본 권한은 acceptEdits+allow 목록, 사용자가 명시한 `--permission-mode bypass`만 우회한다. 메인 checkout의 프로젝트 settings와 실제 실행 권한은 시작 probe로 확인한다.

## 2. 라우팅
인자를 먼저 해석하고 없으면 route·dep을 따른다.

| 상황 | 다음 |
|---|---|
| spec 없음 | create-architecture 초안, 스캐폴딩 parked |
| route design(이 checkout이 디자인 중) | 함께: 디자인이 끝났는지 묻는다 → 끝: start-design 마감 / 아직: start-design 이어서. 맡김: 디자인 변경을 건드리지 않고 inbox parked 후 마감 |
| 화면을 보며 디자인·스타일 다듬기 | start-design(함께 전용) |
| self-improve-local·PR 없이 로컬 개선·하위 제안을 승인 후 통합 | self-improve-local(호출한 세션이 오케스트레이터, 승인 범위만 현재 브랜치에 반영) |
| 자가 개선·지속 개선 설정/실행 요청 | self-improve(저장된 범위·예산·검토·발행 정책 확인) |
| 작은 버그·문구·스타일 수정 | 아래 경량 경로 |
| 새 기능·기획 변경 | create-ssot/update-ssot → create-task 한 조각 |
| pending·채택 review | create-task 한 조각 |
| 활성 open/ready ideation | 다음 미반영 도메인 하나 create-ssot/update-ssot → create-task |
| dep 충족 todo·자기 doing | vibe brief T### → implement-task 1개 |
| inbox 정리 요청 | status --section inbox로 해당 항목만 반영·log |
| 기획·기술 판단으로 blocked | 맡김은 추천안으로 기획 한 조각을 끝내고 해당 태스크를 재개 가능하게 복구 |
| 일 없음·parked만 남음 | 미반영 CI 수정·해결 가능한 blocked부터 확인. 일반 조정자 세션에서 활성·기한 도래한 지속 개선 위임이 있으면 self-improve 한 사이클, 아니면 마감; 위임 없이 새 일을 만들지 않는다 |

경량 경로는 모두 만족할 때만: SSOT 규칙·계약·저장 형식·마이그레이션 변경 없음, 새 결정 없음, 버그/문구/스타일 수정, 코드+테스트 3파일·추가+삭제 100줄 이하(STATE 제외). 태스크·rev 없이 구현 → 영향 테스트+빠른 검사 → 커밋 하나에 STATE log `- YYMMDD fix <area>: <what>`. 조건이 깨지거나 결정·기획 공백이 나오면 즉시 create-task/update-ssot로 올린다.
ideation/done/은 라우팅 후보가 아니다. 기획 조각의 전환 완료 처리는 고른 SSOT 스킬이 맡는다. 기존 converted 문서가 활성 위치에 남아 lint 경고가 나면 create-ssot의 전환 마감 절차로 확인·이관한다.
작업 묶음은 단위1에서 만들지 않는다. 사용자의 병렬 요청 또는 독립 단위 2개 이상·각 태스크 3개 이상·touches 분리·explore 제외일 때만 [조정자 절차](references/coordinator.md)를 읽는다.
지속 개선 자동 진입은 저장된 ARCH 정책과 대상 프로젝트의 에이전트 지침이 연결된 일반 조정자 세션에만 적용한다. hostManaged·단위1은 배정된 한 단위만 끝내며 자체 개선 사이클·리뷰·push를 시작하지 않는다. `vibe loop`의 no-work 종료는 그대로다. 세션 밖 반복은 self-improve의 실행기 연결 절차로 설정한다.

## 3. 모드
맡김은 질문 0회이며 **되돌릴 수 있는 기획·기술 판단도 위임받은 것**이다. "사용자 의사결정 필요"만으로 blocked·parked·마감하지 않는다. 스킬이 만든 질문은 해당 스킬에서 추천안으로 결정하고 inbox decided에 질문·선택·대안·이유를 남긴다. SSOT에는 일반 [o]만 쓴다. 공백·모순은 update-ssot+create-task 한 조각으로 해소하고 태스크·STATE의 base·dep·st를 맞춰 다음 단위에서 재개한다.
- 이미 승인된 후속 작업이 CI를 막으면 실제 선행 결과·touches·진행 중 소유권을 확인하고 미착수 태스크의 순서를 조정한다. 태스크와 STATE의 dep을 함께 갱신한다. 완료기준을 낮추거나 검사를 빼서 통과시키지 않는다.
- 과금·데이터 삭제·개인정보·보안 정책은 [?]+parked. 배포·게시·force push·브랜치 삭제·전역 설정·외부 메시지·공유 데이터 변경 등 되돌리기 어려운 일, 실제 권한·인증 부재도 해당 작업만 parked로 남기고 다른 실행 가능한 태스크로 간다. 모드는 cfg에 쓰지 않는다.
- **권한 창을 만들지 않는다.** 맡김의 권한 확인 창은 질문과 같다 — 사람이 없으니 세션이 멈추고, 그동안 캐시가 식어 토큰이 다시 든다. 위험해서 확인이 필요해 보여도 묻지 않고, 창이 뜰 만한 호출 자체를 하지 않는다:
  - 셸 호출 하나에 일 하나. `cd`를 `;`·`&&`·파이프로 다른 명령과 섞지 않고 절대 경로·`git -C`를 쓴다. 읽기와 쓰기·삭제를 한 호출에 섞지 않는다.
  - 쓰기·삭제는 현재 checkout(워커는 배정된 worktree)과 세션 임시 폴더 안에서만. 상위 폴더·다른 worktree·홈·시스템 경로는 건드리지 않는다.
  - `rm -rf`·`kill`/`pkill`·`sudo`·`chmod`·`curl`/`wget`(다운로드·웹 조회)·전역 설치·`git push --force`/`reset --hard`/`clean`/브랜치 삭제·권한 설정 파일 수정은 하지 않는다. 프로세스·CI·작업 상태는 `ps`나 웹 조회 대신 `work board`·`vibe ci wait`·백그라운드 완료 알림으로 본다.
  - 부하 에이전트(Agent 도구)를 띄우지 않는다 — 그 도구 호출의 권한 창도 이 세션을 멈춘다. 병렬은 헤드리스 실행기(`work run`)로만 한다.
  - 그래도 필요한 일(디스크 정리, 다른 worktree 정리, 권한 추가, 프로세스 종료)은 하지 않고 inbox parked·보고서에 남긴 뒤 다른 일로 간다. 실행 가능한 일이 없으면 마감한다.

## 4. 커밋·검증·push
- 커밋: 태스크·기획 조각·경량 수정마다 관련 파일만 커밋한다. 선점·active는 첫 작업 커밋에 포함, beat는 세션 시작·끝. 보고서 갱신은 태스크 3개(기본), 기획 조각의 태스크 소진, 세션 끝, 반복기 멈춤 중 먼저 온 묶음 경계. loop의 단위 세션 끝은 경계가 아니다.
- 기획 문서는 cfg plan 브랜치(기본 `main`)에 항상 최신으로 둔다: 기획 조각은 `vibe plan-sync`로 시작하고, 기획 커밋은 spec/만 담아 커밋 직후 `vibe plan-push`한다. 코드 push 규칙(cfg push)과 무관하다. ID 충돌로 거절되면 고른 기획 스킬이 다시 채번해 올린다. 충돌·권한 문제로 실패하면 inbox parked에 남기고 구현으로 넘어가지 않는다(번호가 정본에 없는 태스크를 구현하지 않는다).
- push는 기본으로 하지 않는다(cfg push `-`, 미정 `?`도 같다) — push마다 원격 CI가 돌아 빌드 시간을 쓴다. push 대상을 묻지 않는다. 사용자가 cfg push에 브랜치를 직접 적어 둔 경우에만 세션 끝·반복기 멈춤에 한 번 `vibe push`한다. 묶음 경계마다 push하지 않는다.
- strict(cfg push 브랜치가 있고 다른 생존 세션·소유 불명 doing이 보일 때): 세션을 등록·커밋한 뒤 `vibe claim --tag <tag> --task T###`로 원격 선점 정보를 **먼저** 공유한다. claim은 원격 트리의 STATE에 자기 선점만 기록하므로 미검증 로컬 코드는 push하지 않는다. 원격 영수증을 로컬에 합친 뒤 소유권을 재확인한다. 다른 tag면 다른 후보. 원격이 선점을 판정한다. 태스크 검사·보고서는 유지하되 완료 코드의 검증·push는 기본으로 조정자의 최종 관문에 모은다. 단위별 코드 push는 명시적으로 요청받았을 때만이다. push 브랜치가 없으면 이 checkout 혼자 일한다. 같은 checkout의 동시 쓰기 금지.
- 태스크=추가·변경·영향 **단위 테스트**+typecheck·lint·format. 통합·e2e·전체 스위트·CI 대기는 태스크마다 하지 않는다. 테스트 분류는 스크립트 이름이 아닌 격리 범위와 의존성으로 판단한다. 테스트 코드는 필요할 때 함께 수정하고 미실행 통합/e2e 목록은 result limits에 남긴다.
- 통합·e2e·전체 스위트는 **조정자/호스트만 최종 통합 후보에서 push 직전** 한 번 실행한다(커밋만 남기면 조정자의 전체 완료 관문). 워커·리뷰어·위임된 단위 세션은 미실행 명령/spec을 인계한다. CI는 실제 코드 push 뒤 한 번이다. 태스크 커밋·WIP 체크포인트·단위 세션 종료는 이 경계가 아니다. 같은 트리·명령·범위의 성공은 재사용한다. batch/group은 공용 heavy 락으로 실행하고 검증 중 변경은 실패로 취급한다. push에는 검증 SHA를 --verified-commit으로 전달하며, sync로 달라진 코드는 다시 검증한다. 기존 ARCH가 통합/e2e를 task로 요구하면 맡김의 기획 조각에서 batch로 옮기고 근거를 기록한다. ARCH 단계가 없어도 전체 verify를 태스크에 붙이지 않는다.
- work 매핑은 task→task-verify, 단위 verify는 빠른 검사, 통합·e2e는 group-verify(조정자 소유 최종 관문). 기본은 로컬 작업 브랜치에 모은다. 기존 활성 묶음의 잘못된 매핑도 관문이 실행 중이 아닐 때 configure로 정리한다. 묶음 `--push`(통합마다 push·CI)는 사용자가 요청했을 때만 둔다.
- CI는 실제 push당 `vibe ci wait --commit <sha> --diff-base <묶음 시작 SHA> --json` 한 번 또는 push --wait-ci. Claude는 셸 백그라운드+하네스 완료 알림, Codex는 긴 timeout의 단일 블로킹 호출. sleep→조회→보고 모델 루프 금지. 긴 e2e·벤치마크도 완료까지 모델을 깨우지 않는다. 맡김에서 실패는 근거를 담은 수정 태스크를 만들어 **다음 단위로 우선 실행**한다. 수정 태스크 생성만 하고 종료하지 않는다. 기획 판단은 3절대로 해소하고, 실제 권한·외부 작업에 막히면 해당 건만 parked 후 다른 태스크로 간다. 시간·단위 한도와 반복 무진행·실행 실패 제한은 유지한다. run 없는 push는 CLI가 skipped로 마친다.
- 1시간마다, 긴 명령 전 `vibe checkpoint --tag <tag>` 유지(push 브랜치가 없으면 로컬 `wip/<tag>`에만 남는다). 무관한 사용자 변경은 커밋하지 않는다.

## 5. 마감
단위1은 다음 단위로 넘어가지 않고 JSON 한 줄(호스트가 요구하면 스키마 결과):
`{"kind":"task","id":"T001","outcome":"completed","pushed":false,"next":"implementation"}`
kind=task|planning|inbox|fix|none, outcome=completed|parked|blocked|no_work. pushed는 실제 여부. hostManaged 단위는 active·보고서를 닫지 않는다. 반복기만 끝에서 active 정리·보고서 to/next·최종 묶음 검증(push 브랜치가 있으면 push)을 한다. 함께는 단위 완료 시 “다음 단위는 새 대화에서 이어가면 빠르다”고 안내한다.
