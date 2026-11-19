# GUSTA

> ***G**ustum **u**sque **s**ere, **t**uum **a**peri.* — 취향을 늘 심어 가꾸고, 네 취향을 세상에 열어 보여라.
>
> **AI가 만들고, 우리는 고른다 — 우리의 취향이 곧 제품이다.**

## 철학 (모든 변경의 판단 기준)
- **제품**: 사람은 큐레이터다. AI는 추천안·구현·검증을 만들고, 사람은 고른다(결정함·채택·큰 변화의 판단). 사람의 시간은 타이핑·대기가 아니라 판단에 쓰게 한다.
- **구현** — 충돌하면 이 순서로 지키되, 앞의 것을 이유로 뒤의 것을 버리지 않는다:
  1. 문서 먼저: spec이 1급 문서다. 코드보다 SSOT·STATE·태스크가 먼저 바뀐다.
  2. 적은 토큰: 필요한 블록만 읽고(brief·발췌·요약 출력), 단위마다 새 세션을 쓰고, 대기 중에는 모델을 부르지 않는다. 조정자는 탐색·구현·리뷰를 새 세션에 맡기고 결론만 받는다. 스킬 문장도 토큰이다(원칙 14).
  3. 빠른 구현: 태스크는 변경 영향의 작은 결정론적 검사만 한다. 전체 검수는 살아 있는 참여 세션이 모두 준비된 고정 통합 후보에서 한 번 하고, 실패 뒤에는 실패·영향 범위만 다시 본다. 긴 loop는 태스크 몇 개마다 고정 커밋의 전체 검사를 백그라운드로 돌려(단계 검사) 실패를 다음 단계에서 고친다 — 조기 경보일 뿐 최종 관문·시간 예약은 그대로다.
- **코드**: 낮은 결합·높은 응집. 바깥 세계는 경계에서 주입하고(`deps`·`injected`), 테스트가 무거워지면 테스트가 아니라 구조를 고친다.
- **지원 범위**: 제품 단계와 지원 환경·버전·제외·재검토 시점을 ARCH의 승인된 결정 하나에 둔다. 정본은 `skills/gusta-create-architecture/references/product-support.md`다.
- **검증**: 정본은 `skills/gusta-start/references/verification.md`다. 구현은 항상 하위 브랜치에서, gusta-start·두 self-improve는 전용 worktree에서 한다. 실제 수행한 acceptance·증거·미실행만 보고한다.

## 이 저장소
스펙 주도 개발(SDD) 스킬셋 GUSTA를 배포한다. **산출물은 `skills/`의 SKILL.md들**이고, `src/`·`bin/`은 설치·검증·세션 도구 CLI다. 이름: npm `@haeram/gusta`, 명령·폴더 `gusta`, 환경변수·상수 `GUSTA_`, 스킬은 모두 `gusta-` 접두어.

스킬 21종 = spec 스킬 17 + 메타 스킬 4(gusta-send-issue·gusta-preference·gusta-init·gusta-update — 공통 규칙 없음). 진입점은 gusta-plan·gusta-sketch(기획) → gusta-start(실행)다. gusta-design-mode·gusta-showcase는 사용자가 직접 부를 때만 쓴다. 나머지는 진입점이 부르는 내부 스킬이다(이름으로 부를 수는 있다).

## 지도
- `skills/<name>/`: `SKILL.md`(frontmatter `name`=폴더명·`description`), `references/`(필요할 때만 읽는 상세), `assets/`(템플릿), `agents/openai.yaml`(Codex 전용).
- 대상 프로젝트 템플릿: `skills/gusta-create-architecture/assets/{STATE,FORMAT}.md` — FORMAT이 표기 정본이다.
- 맡김 계약: `skills/gusta-start/references/` — `unit.md`(loop 단위 프롬프트에 실리는 유일한 gusta-start 문서)·`verification.md`·`loop-control.md`·`coordinator.md`·`session.md`·`request.md`.
- 세션 프롬프트: `src/agent-adapter.mjs`(unit·worker·reviewer·scout·variant·scaffold).
- spec 문서: `spec-format`(참조 문법)·`spec-lint`·`spec-context`(brief 조립기)·`state-doc`·`task-doc`.
- 설정: `src/settings.mjs` 레지스트리가 SETTINGS 키·기본값·뜻의 정본이다. 브랜치 전략은 `branchPlan`이 해석한다 — 스킬·CLI에 브랜치 이름(`main` 등)을 고정하지 않는다.
- 세션 조정: `coord-doc`·`coord-branch`·`vibe-coord` — 조정 전용 orphan 브랜치의 SESSIONS.md를 CLI만 쓴다.
- 실행: `vibe-loop`·`loop-phase`(단계 검사)·`loop-control`·`loop-metadata`·`provider-limits`(loop), `work-*`(작업 묶음), `agent-catalog`·`agent-route`(도구·모델 선택).
- 그 밖: `agent-block`(대상 CLAUDE.md·AGENTS.md 관리 블록), `migrate`(spec/ 구조 이관 — 구조를 바꾸면 이관 하나를 추가), `prune`, `version-bump`, `verification-plan`, `workspace-prepare`, `vibe-ab*`·`vibe-sketch`·`vibe-design`.
- 모듈별 설계 결정과 그 이유: [docs/design-notes.md](docs/design-notes.md) — 그 모듈을 바꿀 때만 해당 절을 읽는다.

## 스킬 설계 원칙 (수정 시 유지할 것)
1. **역할 분리**: 스킬마다 역할 하나이고, 서로의 영역을 침범하는 지시를 넣지 않는다. gusta-plan·gusta-sketch=기획 진행자(제품 코드는 고치지 않음), gusta-start=맡김 실행자(만든 태스크를 묻지 않고 실행, 요청 인자는 기획 한 조각으로), gusta-design-mode=말한 대로 코드만 고치는 디자인 진행자, gusta-showcase=변형 비교 진행자(고르는 것은 사용자), gusta-create-ssot·gusta-update-ssot=기획자, gusta-create-task·gusta-implement-task=엔지니어, gusta-review-task=제출 커밋 리뷰어, gusta-review-code=리팩토링 제안자(채택은 사용자), gusta-doc-review=의미 보존 편집자, gusta-create-narrative=작가, gusta-manage-work=작업 묶음 조정자, gusta-self-improve·gusta-self-improve-remote=개선 조정자(로컬 공동 통합 / PR). 제안→전환: review-code 채택 → gusta-plan이 태스크화, doc-review의 정책 변경 → gusta-update-ssot.
2. **문서 먼저**: 문서 상태는 `spec/STATE.md`에, 세션 기록은 `vibe` 명령으로만 조정 브랜치 SESSIONS.md에 쓴다. 사용자와 지금 상호작용 중인 상태(디자인 중)는 그 checkout의 Git 디렉터리에 둔다(`src/interactive-state.mjs`).
3. **공통 규칙**: spec 스킬 17개에 같은 5줄이 있다(예외는 gusta-create-architecture 1번). 바꾸면 전부 바꾼다 — `test/skill-rules.test.mjs`가 강제한다. cfg.level(expert/mid/novice)별 질문 방식은 각 스킬에 둔다.
4. **표기 정본은 FORMAT**: 문서 골격은 FORMAT 골격 줄·assets 템플릿·`src/spec-lint.mjs`가 함께 움직인다. SETTINGS는 레지스트리가, SESSIONS는 `coord-doc` 파서와 쓰는 시점 검증이 함께 움직인다. 결정은 한 줄이 아니라 결정 블록(머리줄+들여쓴 하위 항목·표)이다.
5. **SSOT 순수성**: ssot/에는 지금 지켜야 하는 규칙(결정·이유·제약·chg)만 남는다. gusta-create-ssot·gusta-update-ssot의 "최종 점검"은 함께 바꾼다.
6. **lint 세 층**: 오류=구조 위반, 경고=정합성 흔들림, 검토 후보=의미 품질(종료 코드 무관, gusta-doc-review가 판단). 길이 신호는 블록이 아니라 한 줄 길이만 센다.
7. **brief는 하나의 조립기**(`assembleBrief`): 결정은 블록 전체, `→!`·`→=`는 끝까지 싣고, 빠진 것은 이유와 함께 남기며 크기 때문에 잘라내지 않는다. 출처는 한 기준(작업 트리 또는 커밋 하나)만 쓴다.
8. **역사 기록**: `tasks/done/`은 보존하되 현재 규칙의 근거로 쓰지 않는다. ideation은 미룬 구상만 기록한다.
9. **작업 묶음**: 배정·리뷰·통합 단위는 lane이다. 단위는 바깥 dep이 모두 통합된 뒤 시작하고, 단위 사이 순환은 기획 단계에서 막는다. 통합·묶음 검증 같은 기계적 관문은 CLI가 백그라운드로 한다.
10. **언어**: spec 산출 문서(템플릿 포함)는 영어, SKILL.md 본문은 한국어다. 스킬이 인용하는 문서 리터럴은 FORMAT의 영어 값과 같아야 한다. 예외는 NARRATIVE.md·reports/(cfg.lang).
11. **맡김에는 사람 입력을 기다리는 경로가 없다**: 질문은 시작 preflight 실패 1회뿐이고, 그 뒤는 추천안+`vibe inbox add`+보고서다. 과금·데이터 삭제·개인정보·보안 정책과 되돌리기 어려운 일은 주차한다. 권한 창도 질문이다. 헤드리스 세션의 권한·도구·모델·MCP는 CLI가 SETTINGS(`permission-mode`·`agents`·`headless-mcp`)와 태스크 `run:`으로 정한다. 디자인 모드는 맡김에 없다.
12. **반영**: 태스크마다 커밋하고, 반영은 SETTINGS land·land-via·push(기본 push하지 않음)를 따른다. land는 공동 고정 후보로만 전진한다. 조정 브랜치는 `coord-push`로 사건마다 올린다. 기획 문서는 SETTINGS plan 브랜치가 정본이다(`vibe plan-sync`·`vibe plan-push`, 같은 T###는 먼저 올린 쪽이 이긴다).
13. **프로젝트 독립성**: 대상 프로젝트의 이름·도메인·업무 규칙·실제 태스크/결정 ID를 코드·스킬·템플릿·예시·테스트에 넣지 않는다. 사례는 일반 규칙으로만 반영하고, 외부 측정 자료는 익명화한다.
14. **컨텍스트 예산**: 스킬 문장은 실릴 때마다 드는 비용이다.
   - 스킬에는 모델이 할 일(명령·순서·판단·출력)만 쓴다. CLI 내부 동작과 CLI가 거절 메시지로 강제하는 규칙은 쓰지 않는다 — 거절 메시지가 그때의 지시다.
   - 드문 경로는 references로 보내고 언제 읽을지 한 줄만 남긴다. loop 단위에는 `references/unit.md`만 실린다(gusta-start 본문은 시작 대화용).
   - 사고 하나에 문장을 더하기 전에 지울 문장을 찾는다. 규칙을 지우면 흔적("더 이상 ~하지 않는다")도 남기지 않는다.
   - 상한은 `test/context-budget.test.mjs`가 강제한다(스킬 설명·SKILL.md·단위 프롬프트·이 파일). 상한을 올리려면 같은 변경에서 다른 곳을 줄인다.

## 검증
- 스킬 수정은 영향 계약·구조 검사로 확인한다. `npm run check`(전체 테스트+스킬 구조+패키징)는 고정 통합 후보에서 한 번 실행하고, 실패·변경 범위만 재검사한다.
- `node --test`는 파일끼리만 병렬이다 — 느린 테스트는 파일을 나눈다.
- 로컬 설치: `node ./bin/gusta.mjs install --target <경로>` 후 `check --target <경로>`. 대상 spec 검사는 `lint --target <경로> [--hints]`, 브리핑은 `vibe brief <ID>`, 전달량 측정은 `node scripts/measure-brief.mjs --target <경로> [--tokens]`.
- 다른 기기는 bare 원격과 clone 둘로, 맡김 실행기는 가짜 provider로, loop 종료·설정은 `test/vibe-loop-control.test.mjs`(모델 호출 없음)로 재현한다.

## 배포
- `npm version patch` 후 main에 push한다. release.yml은 같은 SHA의 성공한 CI를 재사용하고, npm에 없는 버전만 Trusted Publishing(OIDC)으로 publish한다.
- 배포용 npm은 11.21.2로 고정하고 `scripts/prepare-publish.mjs`가 npm/cli#10078 임시 대응을 한다(npm이 고치면 제거). 세부는 그 스크립트와 [설계 노트](docs/design-notes.md#배포-세부).
