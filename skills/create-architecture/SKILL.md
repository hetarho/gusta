---
name: create-architecture
description: >-
  spec 시스템 초기화 + 아키텍처 SSOT(spec/ssot/ARCH.md) 작성. 새 프로젝트를 시작할 때, spec/이 아직
  없을 때, "아키텍처 잡아줘 / 스택 정해줘 / 프로젝트 세팅하자" 요청일 때 사용. 인터뷰로 스택·구조·
  컨벤션·검증 명령을 결정해 이후 모든 태스크가 따를 기준을 만든다. 코드 구현은 하지 않는다
  (그건 implement-task). 기존 ARCH 수정도 이 스킬로.
---

# create-architecture — 초기화 + 아키텍처 SSOT

**역할: 엔지니어.** 기술 결정을 이끈다. 단, 무엇을 만들지(기획)는 정하지 않는다 — 그건 create-ssot의 기획자 몫.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 0단계 부트스트랩. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 산출 문서는 영어로 쓴다(FORMAT 언어 규칙). 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

## 0. 부트스트랩 (spec/ 없을 때만)
1. `spec/ssot/`, `spec/tasks/` 생성. 이 스킬 폴더의 `assets/STATE.md`, `assets/FORMAT.md`를 `spec/`으로 복사. log에 `- YYMMDD create-architecture start (spec init)` 1줄 — 이것이 공통 규칙 2의 시작 기록이다.
2. level 캘리브레이션 — 첫 질문으로 묻는다:
   - a) **expert** — 용어로 빠르게. 세부 기술까지 내가 직접 결정
   - b) **mid** — 선택지와 장단점을 보고 내가 결정
   - c) **novice** — 뭘 만들지만 말하면 기술은 알아서
   cfg의 `?`를 답으로 교체(level = 답, lang = 대화 언어).

spec/이 이미 있으면 0단계 생략, ARCH 개정 모드 — 진행과 마감 모두 update-ssot와 동일 규칙(rev+1·chg·STATE pending·[?] 갱신).

작업 묶음 워커에서 불렸으면 문서 쓰기는 `manage-work`가 반환한 group.path(기획·채번·문서 정리 위치)로 인계하고 워커 checkout의 STATE·SSOT는 바꾸지 않는다. 어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 FORMAT SETTINGS `plan`).

작업 묶음의 ARCH 개정은 공유 보드의 활성 attempt에도 영향을 줄 수 있다. 영향을 보고하고, 변경 후 워커의 동기화·재검증을 요구한다.

## 1. 컨텍스트
- ssot/에 기획 SSOT가 있으면 읽는다. 없으면 "무엇을 만드는지 한 줄"만 묻는다 — 상세 기획은 create-ssot로 미룬다.
- 기존 코드베이스면 스택을 스캔(package.json, 디렉토리 구조 등). 이미 정해진 것은 묻지 않고 기록만 한다.

## 2. 아키텍처 인터뷰 (level별)
결정할 것: 플랫폼(웹/앱/API) · 스택 · 데이터 저장 · 인증 방식 · 폴더 구조와 컨벤션 · 모듈 경계와 의존 방향 · 테스트 정책 · verify 명령(test·lint·format 각각)과 검증 단계 · CI/CD · 배포/인프라.
- **expert**: 이름만 나열해 묻는다. "스택? Next 15 / Remix / SvelteKit / 기타" "DB? PG / SQLite / Mongo". 인덱스·캐시·모노레포 여부 같은 세부도 직접 묻는다.
- **mid**: 선택지 + 장단점 각 1줄. "PG(관계·확장에 강함, 서버 필요) vs SQLite(운영 제로, 단일 서버 한정)".
- **novice**: 기술명으로 묻지 않는다. "사용자가 몇 명쯤 될까요? / 서버 비용을 쓸 수 있나요? / 폰에서도 쓰나요?" 같은 결과 수준 질문 → 답으로 AI가 스택을 결정하고 "데이터는 ○○에 저장할게요 — 무료로 시작 가능해요" 식으로 한 줄씩 보고만.

사용자가 답을 모르면 강요하지 말고 [?]로 등록하고 진행한다.
맡김 모드: 같은 질문에 추천안으로 답해 ARCH를 쓰고 inbox `decided`에 남긴다. 스택은 되돌리기 비싸므로 사용자가 inbox를 확인하기 전에는 스캐폴딩 태스크를 구현하지 않는다(inbox `parked`).

## 3. ssot/ARCH.md 작성
create-ssot 스킬 폴더의 assets/ssot.md 템플릿을 `spec/ssot/ARCH.md`로 복사해 시작한다(r1). ARCH-n 결정으로: 스택 / 폴더 구조(트리 압축) / 데이터 저장·스키마 원칙 / 코드 컨벤션(네이밍·상태관리·에러 처리) / 모듈 경계와 의존 방향 / 테스트 정책 / verify 명령(test·lint·format) / CI/CD / 배포. 근거(←)는 트레이드오프가 있던 결정에만 붙인다. 폴더 구조·컨벤션처럼 항목이 여러 개인 결정은 한 줄로 늘이지 말고 결정 블록(2칸 들여쓴 하위 항목·표)으로 편다. verify 명령은 백틱 코드로, 설명을 섞지 않은 실행 가능한 형태 그대로 적는다.
- 모듈 경계는 낮은 결합·높은 응집으로 정한다: 모듈마다 한 책임, 의존은 한 방향, 순수 로직과 I/O(DB·네트워크·파일·시간·난수)를 나누고 바깥 세계는 경계에서 주입한다. 목적은 태스크 단계의 단위 테스트가 실제 서비스 없이 빠르게 도는 것이다 — 경계가 없으면 태스크마다 무거운 테스트가 필요해진다.
- 검증 단계는 항상 결정한다: task(추가·변경·영향 단위 테스트+typecheck·lint·format) / batch(조정자/호스트가 최종 통합 후보에서 push 직전 통합·e2e·전체 스위트 한 번; 커밋만 남기면 조정자의 전체 완료 관문) / CI(실제 코드 push가 있을 때만 원격 검사 한 번). 태스크 커밋·WIP 저장·단위 종료는 batch 경계가 아니다. 테스트 분류는 이름이 아닌 격리 범위·의존성에 따른다.
- ARCH 개정 시 단계가 없거나 통합/e2e가 task에 있으면 위 단계로 정리한다(맡김은 추천안+inbox). 하위 줄은 `  - task, before each done commit: ` 뒤 실행 명령 목록, `  - batch, before code push or final completion: ` 뒤 전체 명령 목록, `  - CI, after code push: ` 뒤 원격 관문 설명으로 쓴다. 조건부 검사의 적용 조건·경로 선택법은 별도 하위 줄로 보존하되 통합/e2e는 batch에 둔다.
- `$HAERAM_DIFF_BASE`는 태스크 시작 SHA이며 단독·work 모두 CLI가 전달한다. 단계→work 플래그 매핑과 최종 검증 소유는 [검증 절차](../start-vibe/references/verification.md)를 따른다 — 사용자가 통합마다 push(`--push`)를 요청한 묶음만 batch→`--verify`, CI가 최종 관문이면 `--group-verify` 생략.
- 단계가 없어도 태스크에 전체 verify를 붙이지 않는다. **테스트는 기본 의무** — 빼려면 ARCH에 명시적 [o] 결정으로만 가능하고, 그 결정이 없으면 모든 태스크의 acceptance에 테스트가 요구된다. 통합/e2e 실행을 batch로 넘긴 것은 검증 면제가 아니다.

## 4. 마감
- STATE: ssot 행 `ARCH | 1 | 0 | all | <[?] 수>` (스캐폴딩도 태스크로 만들 것이므로 tasked=0), next = 기획 SSOT 없으면 `create-ssot`, 있으면 `create-task ARCH`, log 1줄. cfg `always`(모든 태스크 brief에 실리는 전역 규칙)는 `ARCH` 전체로 둔다 — ARCH가 커져 일부 태스크만 쓰는 결정이 많아지면 모든 태스크가 지킬 결정(컨벤션·테스트 정책·검증 단계)만 남긴다. ARCH 개정으로 결정을 추가할 때도 always 포함 여부를 정한다.
- 보고는 cfg.level대로 — novice: 무엇을 결정했고 이제 뭘 할 수 있는지 풀어서 / expert: 결정 목록만.
