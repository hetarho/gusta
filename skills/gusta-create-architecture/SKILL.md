---
name: gusta-create-architecture
description: >-
  spec/ 초기화와 아키텍처 SSOT(ARCH: 스택·구조·컨벤션·검증 명령) 작성·변경. gusta-plan·gusta-sketch가 부르는 내부 기획 스킬 — 사용자의 기획 요청은 gusta-plan으로.
---

# gusta-create-architecture — 초기화 + 아키텍처 SSOT

**역할: 엔지니어.** 기술 결정을 이끈다. 무엇을 만들지(기획)는 gusta-create-ssot의 몫이다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 0단계 부트스트랩부터 한다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

## 0. 부트스트랩 (spec/ 없을 때만)
1. `spec/ssot/`, `spec/tasks/`를 만들고 이 스킬의 `assets/STATE.md`, `assets/FORMAT.md`를 `spec/`으로 복사한다. `vibe log --text 'gusta-create-architecture start (spec init)'`.
2. 첫 질문으로 level을 묻고 cfg의 `?`를 답으로 바꾼다(level = 답, lang = 대화 언어):
   - a) **expert** — 용어로 빠르게. 세부 기술까지 내가 직접 결정
   - b) **mid** — 선택지와 장단점을 보고 내가 결정
   - c) **novice** — 뭘 만들지만 말하면 기술은 알아서

spec/이 있으면 ARCH 개정 모드다: 진행·마감은 gusta-update-ssot 규칙(rev+1·chg·STATE pending·[?] 갱신)을 따르고, 작업 묶음의 활성 attempt에 주는 영향을 보고해 워커가 동기화·재검증하게 한다.

기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`.

## 1. 컨텍스트
- 기획 SSOT가 있으면 읽고, 없으면 "무엇을 만드는지 한 줄"만 묻는다.
- 기존 코드베이스면 스택을 스캔해(package.json·디렉토리 구조 등) 정해진 것은 묻지 않고 기록한다.
- 제품 단계·지원 범위를 처음 정하거나 바꾸면 [제품 지원 정책](references/product-support.md)대로 추천하고 고르게 한다.
- 운영 절차를 정하거나 바꾸면 [프로젝트 규칙 대조](../gusta-update/references/project-rules.md)대로 지침·운영 문서·설정·코드·CI를 확인한다.

## 2. 아키텍처 인터뷰 (level별)
결정할 것: 플랫폼(웹/앱/API) · 스택 · 데이터 저장 · 인증 · 폴더 구조와 컨벤션 · 모듈 경계와 의존 방향 · 테스트 정책 · verify 명령(test·lint·format)과 검증 단계 · CI/CD · 배포/인프라.
- **expert**: 이름만 나열해 묻고("DB? PG / SQLite / Mongo") 인덱스·캐시·모노레포 같은 세부도 묻는다.
- **mid**: 선택지+장단점 각 1줄("PG(관계·확장에 강함, 서버 필요) vs SQLite(운영 제로, 단일 서버 한정)").
- **novice**: 기술명 대신 결과로 묻고("사용자가 몇 명쯤 될까요? 서버 비용을 쓸 수 있나요? 폰에서도 쓰나요?") 답으로 스택을 정해 "데이터는 ○○에 저장할게요 — 무료로 시작 가능해요"처럼 한 줄씩 보고만 한다.
답을 모르면 강요하지 않고 [?]로 둔다. 맡김에서는 추천안으로 ARCH를 쓰고 inbox `decided`에 남기되, 스택은 되돌리기 비싸므로 사용자가 inbox를 확인하기 전에는 스캐폴딩 태스크를 구현하지 않는다(inbox `parked`).

## 3. ssot/ARCH.md 작성
gusta-create-ssot의 assets/ssot.md를 `spec/ssot/ARCH.md`로 복사한다(r1). ARCH-n 결정: 스택 / 폴더 구조(트리 압축) / 데이터 저장·스키마 원칙 / 코드 컨벤션(네이밍·상태관리·에러 처리) / 모듈 경계와 의존 방향 / 테스트 정책 / verify 명령 / CI/CD / 배포. ←는 트레이드오프가 있던 결정에만 붙이고, 항목이 여러 개인 결정은 결정 블록(2칸 들여쓴 하위 항목·표)으로 편다.
- 제품 단계·지원 정책은 [기록 형식](references/product-support.md#arch-기록)대로 결정 한 블록에 쓴다.
- 모듈 경계는 낮은 결합·높은 응집으로: 모듈마다 한 책임, 의존은 한 방향, 순수 로직과 I/O(DB·네트워크·파일·시간·난수)를 나누고 바깥 세계는 경계에서 주입한다.
- 새 검증의 기본은 task(변경 영향의 작은 결정론적 검사·빠른 정적 검사, 커밋 직전 한 번) / batch(살아 있는 참여 세션이 모두 ready인 고정 통합 후보의 결정론적 전체 검수 한 번) / CI(최소 자동 E2E와 선언한 지원 브라우저 호환 검사)다. 채택한 단계는 `  - task, before each done commit: ` / `  - batch, before code push or final completion: ` / `  - CI, after code push: ` 뒤에 설명 없이 실행 가능한 백틱 명령·원격 관문으로 쓰고, 전체 스위트·브라우저는 task에 넣지 않는다. task 명령은 `$GUSTA_DIFF_BASE`(태스크 시작 SHA, CLI가 넘긴다)로 바뀐 범위를 고를 수 있다.
- 새 worktree의 검사가 무시된 설치 폴더·생성 코드를 필요로 하면 같은 결정에 `prepare:` 하위 줄(lockfile 고정·offline 설치처럼 트리를 바꾸지 않는 명령)을 둔다.
- AC 검증 주체·단계와 computer use의 E2E 대체는 [검증 절차](../gusta-start/references/verification.md)를 따른다. 새 웹 프로젝트는 별도 요구가 없으면 Chrome 하나를 추천한다.
- 테스트 정책은 기존 테스트로 충분하면 재사용하고 실제 검증 공백에만 새 테스트를 더한다. 저위험 변경에 새 테스트나 소스 문자열·구현을 따라 하는 테스트를 의무로 두지 않되, 통합/e2e 인계를 검증 면제로 보지 않는다.
- 프로젝트에 이미 검증 지침·스크립트·CI가 있으면 [기존 검증 대조](references/existing-verification.md)대로 맞춘다.

## 4. 마감
- STATE: ssot 행 `ARCH | 1 | 0 | all | <[?] 수>`(스캐폴딩도 태스크라 tasked=0), next = 기획 SSOT가 없으면 `gusta-create-ssot`, 있으면 `gusta-create-task ARCH`. `vibe log` 1줄.
- cfg `always`(모든 태스크 brief에 실리는 전역 규칙)는 `ARCH` 전체로 둔다. 일부 태스크만 쓰는 결정이 많아지면 모든 태스크가 지킬 결정(제품 단계·지원 범위·컨벤션·테스트 정책·검증 단계)만 남기고, 이후 결정을 더할 때마다 포함 여부를 정한다.
- 보고는 cfg.level대로 — novice: 무엇을 정했고 이제 뭘 할 수 있는지 풀어서 / expert: 결정 목록만.
