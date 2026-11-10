---
name: implement-task
description: >-
  spec/tasks/의 태스크를 구현하고 검증한다. "구현해줘 / T003 해줘 / 다음 태스크 진행 / 남은 태스크 구현해줘" 일 때 사용.
  단독 작업은 STATE의 다음 todo를 고르고, 작업 묶음이 있거나 태스크에 lane이 있으면 세션 루프로 기반·줄기·리뷰를
  다른 세션과 나눠 맡는다. SSOT 신선도와 완료기준을 확인하고 검증한다. 단독 작업은 done으로 마감하며, 묶음 워커는 제출하고 통합은 CLI가 진행한다.
---

# implement-task — 태스크 구현

**역할: 엔지니어.** SSOT와 ARCH가 법이다. 구현 중 기획 공백은 코드로 임의 확정하지 않고 update-ssot로 올린다. 단독 맡김은 추천안을 기획에 반영하고 create-task로 재개를 준비한다. 함께 모드는 확인을 요청하고, 묶음 워커는 조정자에게 blocked 결정 요청을 돌려준다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

## 1. 선택과 브리핑
`work status --json`이 worker/group/reviewer이거나, 남은 태스크를 맡긴 요청에 활성 묶음 또는 todo `lane:`이 있으면 [작업 묶음 절차](references/work-group.md)만 추가로 읽는다. 단독이면 `vibe status --tag <tag> --json`에서 dep 충족 todo 또는 자기 doing 하나를 고른다. 다른 tag의 doing은 사용자가 지시할 때만 회수한다.
`vibe brief T###` 또는 실행기의 brief가 읽기 범위다: 태스크, 인용 도메인의 현재 규칙(cfg brief `domain`, 기본) 또는 인용 결정만(`cited`), 필수 의존(`→!`)·정본(`→=`)·인용 결정을 가리키는 결정, 전역 규칙(cfg always), flow·constraints, base 이후 chg, ARCH 검증 단계. issues부터 처리한다 — [x]는 규칙이 아니며 [?]에 기대는 구현은 기획 결정이 먼저다.
단독은 태스크 시작 HEAD를 `$HAERAM_DIFF_BASE`로 보존하고 모든 검사에 넘긴다(반복기는 이미 설정). 선점 st=`doing@YYMMDD.tag`를 태스크·STATE에 쓰고, 다시 읽어 다른 tag면 중단한다. solo는 첫 작업 커밋에 포함, strict는 start-vibe의 선점 커밋·push·원격 재확인을 먼저 한다. 같은 checkout에서 동시 쓰기를 하지 않는다.

## 2. 신선도
brief의 stale-base와 history(base 이후 chg 줄)가 델타다 — chg를 따로 읽지 않는다. 무관하면 base만 갱신, 영향 있으면 todo 복귀·log 후 create-task로 갱신한다. 완료 전 관련 rev만 다시 확인한다. 워커는 기획 공간에 인계하며 base를 임의로 바꾸지 않는다.

## 3. 구현
태스크 완료기준과 인용 결정에 맞춰 구현한다. 코드는 `rg`로 위치를 찾고 필요한 줄 범위만 읽는다. 큰 파일·같은 SSOT 전체를 반복 출력하지 않는다.
- **결합은 낮게, 응집은 높게**: 한 모듈은 한 책임만 지고, DB·네트워크·파일·시간·난수 같은 바깥 세계는 인자·의존성 주입으로 경계에서 받는다. 새 로직이 단위 테스트로 바로 검증되지 않으면 테스트를 무겁게(실제 서비스·큰 fixture·timeout 상향) 만들지 말고 touches 안에서 순수 로직을 분리한다. touches 밖 구조 문제는 limits에 남긴다.
- 새 함수·타입·상수를 쓰기 전에 `rg`로 같은 일을 하는 것이 이미 있는지 찾아 재사용한다 — 같은 판단(대상 여부, 검증, 정규화)을 파일마다 다시 정의하지 않는다. impl notes가 가리킨 공용 위치가 있으면 거기에 둔다.
- 공용으로 옮겨야 할 helper를 찾으면 단독은 touches 밖의 공용 파일로 옮기고 result limits에 적는다. 묶음 워커는 touches 밖을 고치지 않고 있는 것을 재사용하거나 limits에 남긴다(다른 줄기와 충돌한다).
- 조정 가능한 수치는 정의된 설정을 이름으로 읽는다. impl notes에 숫자로 적혀 있어도 같은 값의 설정이 있으면 그 설정을 쓰고, 새로 만든 설정은 실제로 읽히게 연결한다. 명령 출력은 요약·tail만 보고 전체 로그는 파일 경로로 남긴다. 완료 태스크는 회귀 근거가 필요한 특정 파일만 조회한다.
기획 공백은 update-ssot, 기술 결정 누락은 create-task로 올린다. 맡김은 추천안+inbox decided, 금지 정책·되돌리기 어려운 일은 parked. 새 문맥은 바깥 반복기가 만든다. 단독 구현을 서브에이전트에 분할하지 않는다. 범위 밖 발견은 result limits/log 한 줄로 남긴다.
explore는 시작 시각·timebox를 기록하고 측정값을 result에 보존한다. 시간이 다 되면 acceptance의 exit대로 끝낸다(함께는 한 번 확인, 맡김은 inbox decided).

## 4. 검증
① 구현한 acceptance를 확인 ② 추가·수정·영향받는 단위 테스트 ③ typecheck·lint·format ④ spec lint ⑤ 통합·e2e·전체 스위트·CI는 묶음 관문에 맡긴다. 미실행 검사를 통과로 쓰지 않는다.
- 커밋 전에 자기 변경(`git diff $HAERAM_DIFF_BASE`)의 hunk만 한 번 훑는다: 다른 파일에 이미 있는 helper·타입의 재정의, 설정이 있는데 숫자로 쓴 값, 정의만 하고 읽히지 않는 설정·export, 동작과 다른 주석, 같은 식의 반복, 바깥 세계와 묶여 단위 테스트로 검증할 수 없는 로직. 고칠 수 있으면 고치고 영향 테스트를 다시 돌린다. touches 밖이면 limits에 남긴다.
- UI·저장소·워커 변경도 태스크에서는 단위 테스트+빠른 검사만 실행한다. 통합/e2e 테스트는 코드와 함께 수정하되 실행할 명령·spec을 result limits에 남겨 묶음 관문에 넘긴다. acceptance의 구현 확인과 통합/e2e 실행 근거를 구분하고 verified에는 실제 실행한 검사만 적는다. brief의 조건부 브라우저 요구도 이 관문에서 검증한다. ARCH에 단계가 없어도 태스크에 전체 스위트를 붙이지 않는다. 빈 단위 테스트 선택은 동작 검증이 아니며 필요한 작은 테스트를 보완한다.
- 테스트 분류는 스크립트 이름이 아닌 격리 범위와 의존성으로 판단한다. 단위 테스트는 필요한 최소 데이터·fixture로 대상 함수·컴포넌트를 독립 검증한다. 통합·e2e 검사를 타임아웃 상향으로 태스크마다 반복하지 않는다.
- 검사는 `vibe check --tier task --diff-base <태스크 시작 SHA> --task T### -- <command>`로 실행한다. `HAERAM_TIER=task`, `HAERAM_DIFF_BASE`와 TASK(S)가 전달된다. 요약의 실패 테스트·마지막 줄만 보고, 필요할 때만 log 경로의 범위를 읽는다. 같은 트리·명령·범위의 성공은 재사용한다.
- ⑤ 통합·e2e·전체 스위트·CI는 조정자/호스트가 최종 통합 후보에서 push 직전 한 번 실행한다(단독 시작 세션만 조정자를 겸한다. 어느 관문인지는 start-vibe [검증 절차](../start-vibe/references/verification.md)). 태스크 커밋·WIP 저장·세션 종료 때 실행하지 않고, 사용자가 별도 실행을 명시한 범위 외에는 인계한다. 긴 명령은 완료 알림까지 모델을 깨우지 않는다(sleep→조회 반복 금지).
- `lint` 오류·경고는 고친다. reviewHints는 의미 검토 후보라 자동 수정하지 않고 next의 doc-review 또는 result limits로 넘긴다.

## 5. 마감
단독 태스크 result는 `- outcome:` / `- at:` 검증 SHA / `- verified:` 실제 검사 / `- limits:` 한계 또는 `-` 네 줄. 이후에도 지킬 계약은 result에 묻지 말고 update-ssot로 올린다. st=done@YYMMDD, tasks/done/으로 이동, STATE 행 삭제·next 갱신·log `- YYMMDD T### done`. 태스크마다 관련 파일만 커밋하며 push·보고서는 start-vibe/호스트의 묶음 경계를 따른다. start-vibe 밖 커밋은 요청받았을 때만 한다.
작업 묶음 워커는 acceptance 체크·result·코드만 갱신하고 제출한다. STATE·SSOT·st·아카이브는 CLI/기획 공간이 소유한다. 함께는 단위 완료 시 새 대화로 이어가면 빠르다고 안내한다.
