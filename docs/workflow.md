# 개발 흐름

[README](../README.ko.md) · **개발 흐름** · [브랜치·검증](branching.md) · [오래 맡기기](autopilot.md) · [병렬 작업](parallel-work.md) · [자가 개선](self-improve.md) · [CLI](cli.md)

GUSTA는 아이디어를 구현 가능한 스펙으로 발전시키고, **요구사항 → 설계 → 작업 계획 → 구현 → 검증**을 일관된 흐름으로 연결하는 스펙 주도 개발(Spec-Driven Development)용 Agent Skills 모음입니다. Claude Code와 Codex가 바로 코드를 작성하기 전에 목표, 범위, 제약, 결정 사항, 완료 조건을 먼저 명확히 하고 각 단계의 결과를 다음 단계의 입력으로 이어 가도록 돕습니다. 핵심은 라이브러리 API가 아니라 AI 에이전트가 필요할 때 불러 쓰는 스킬이며, npm 패키지는 여러 프로젝트에 그 스킬을 안전하게 설치하고 동기화하기 위한 배포 수단입니다.

## 철학

### 제품 철학 — 우리는 큐레이터다

기획 초안도, 코드도, 검증도 AI가 만듭니다. 사람이 하는 일은 **무엇을 남길지 고르는 것**입니다. 같은 기능이라도 무엇을 넣고 무엇을 뺄지, 어떤 결정을 받아들이고 어떤 결정을 돌려보낼지가 제품을 정합니다. 그래서 GUSTA는 사람의 시간을 타이핑이나 대기가 아니라 판단에 쓰도록 설계되어 있습니다.

- **미리 잘 구상해 두면, 그다음은 알아서 돕니다.** 사람이 고르는 일은 실행 전에 `/gusta-sketch`에서 합니다 — AI가 만들 것을 HTML 시안으로 그려 선택지와 추천을 보여 주고, 사람이 보고 고른 것이 spec 문서와 태스크가 됩니다. 그다음 `/gusta-start`는 그 태스크를 묻지 않고 실행합니다. 실행 중 판단은 추천안으로 정하고 받았어야 할 질문과 고른 답을 **결정함**에 남기므로, 돌아온 사람은 결정함을 보며 고르기만 하면 됩니다.
- 시안의 방향·선택지는 AI가 능동적으로 제안하지만 결정은 사람이 합니다. 리팩토링 제안(`gusta-review-code`)과 문서 정리(`gusta-doc-review`)도 채택은 사람이 합니다.
- 결과 의미·공개 계약·검증 범위를 바꾸는 큰 변화는 AI가 스스로 적용하지 않습니다. 근거와 대안을 갖춘 제안으로 사람의 판단을 기다립니다.

### 구현 철학 — 문서 먼저 · 적은 토큰 · 빠른 구현

1. **spec이 1급 문서다.** 다른 SDD 프로세스와 같습니다. 코드보다 문서가 먼저 바뀝니다. 결정은 SSOT에, 진행은 STATE에, 구현 계획은 태스크에 먼저 쓰고, 코드는 그 결과물입니다. 구현 중 기획 공백이 보이면 코드로 임의로 확정하지 않고 gusta-update-ssot로 올립니다.
2. **최소한의 토큰으로 최고의 결과.** 필요한 것만 읽습니다. 구현 세션은 문서 전체가 아니라 태스크가 기대는 결정 블록만 담은 브리핑(`vibe brief`)을 받고, FORMAT은 필요한 발췌만 봅니다. spec은 영어 압축 표기로 쓰고, 명령 출력은 요약과 마지막 몇 줄만 봅니다. 조정자(오케스트레이터)는 코드를 직접 읽거나 고치지 않고 탐색·구현·리뷰를 새 세션에 맡겨 결론만 받습니다 — 읽은 것은 이후 모든 턴에 다시 실리기 때문입니다. `/gusta-start`의 실행은 단위마다 새 세션을 띄워 대화가 쌓이지 않게 하고, 같은 트리에서 통과한 검사는 다시 돌리지 않으며, CI·긴 명령을 기다리는 동안에는 모델을 부르지 않습니다.
3. **spec을 위해 속도를 포기하지 않는다.** 시간은 구현에 씁니다. 태스크마다 도는 것은 **변경 영향 단위 테스트와 1분 안에 끝나는 빠른 검사를 커밋 직전에 한 번뿐**이고(ARCH 검증 결정이 task/batch/CI 단계를 선언합니다), 통합·e2e·전체 스위트·CI는 끝난 작업을 land 브랜치에 반영하기 직전(반영할 것이 없으면 세션 끝)에 조정자가 한 번 실행합니다. 30분짜리 전체 테스트를 태스크 10개마다 돌리면 그것만으로 5시간이 사라집니다. 대신 시간 한도를 준 실행의 마지막 구간만 **마감 관문**(전체 검증·push·CI)에 남겨 둡니다. 그 길이는 고정 비율이 아니라 실측입니다 — 전체 검증 실측 시간 + 실패하면 고칠 단위 하나 + 다시 돌릴 시간(+CI). 30분짜리 스위트라면 10시간 중 약 1.5시간만 예약하고 나머지는 구현에 씁니다.

### 코드 원칙 — 낮은 결합, 높은 응집

빠른 구현은 코드가 단위 테스트로 검증될 수 있을 때만 가능합니다. 한 모듈은 한 가지 책임만 지고(높은 응집), 다른 모듈의 내부를 알지 못하며, DB·네트워크·파일·시간·난수 같은 바깥 세계는 경계에서 주입합니다(낮은 결합). 그러면 단위 테스트가 실제 서비스 없이 몇 초 안에 돌고, 태스크마다 돌릴 영향 테스트도 작아집니다. 테스트하기 어려운 코드는 테스트를 무겁게 만들어 해결하지 않고 구조를 고칩니다. ARCH가 모듈 경계와 의존 방향을 정하고, `gusta-create-task`가 그 경계를 따라 태스크를 나누고, `gusta-implement-task`가 그렇게 구현하고, `gusta-review-code`가 결합·응집·테스트 용이성을 점검합니다.

## 핵심 개념

위 철학은 다섯 가지 설계 원칙으로 구현되어 있습니다.

1. **역할 분리** — SSOT(기획)는 **기획자** 역할의 에이전트가 기획 관점 질문(목적·타겟·범위·플로우·정책)으로 만들고, 태스크(구현 계획)는 **엔지니어** 역할의 에이전트가 개발 관점 질문(데이터 모델·API·엣지·마이그레이션)으로 만듭니다. 기획 문서에 기술 결정이, 구현 단계에 기획 재논의가 섞이지 않습니다. 기획 쪽에 시안을 그려 선택지를 내미는 `gusta-sketch`가 있듯, 개발 쪽에는 코드 품질을 대변해 리팩토링을 주장하는 **리뷰어**(`gusta-review-code`)가, 문서 쪽에는 의미를 보존하며 문장을 다듬는 **편집자**(`gusta-doc-review`)가 있습니다. 지속 개선을 명시적으로 위임하면 gusta-self-improve-remote가 그 범위 안의 동작 보존 개선을 스스로 채택하고 독립 검토를 거쳐 PR로 만듭니다.
2. **사용자 수준 적응** — 최초 1회 캘리브레이션으로 `expert / mid / novice`를 정하면 모든 질문과 보고가 그 수준에 맞춰집니다. expert에게는 선택지를 용어로만 나열하고 세부·엣지까지 직접 묻고, mid에게는 선택지에 장단점을 한 줄씩 붙이고, novice에게는 기술명 대신 "무엇이 어떻게 되는지"를 물은 뒤 기술 결정은 에이전트가 내리고 한 줄로 보고합니다.
3. **문서 먼저** — 단독 작업과 기획 공간은 문서 상태(SSOT rev·태스크 보드·next)를 진행 문서(`spec/STATE.md`)에, 세션 기록(시작·선점·결정함·log)을 `vibe` 명령으로 조정 브랜치의 `SESSIONS.md`에 남깁니다. 작업 묶음의 워커는 공유 실행 기록에 상태를 남깁니다. 세션을 이어 받아도 "다음 태스크 구현해줘", "SSOT 변경분 태스크로 쪼개줘"가 통하도록 현재 checkout의 맥락을 보존합니다. STATE 수정은 원자적 선점이 아니며 다른 worktree에 자동으로 공유되지 않습니다 — 선점과 세션 기록은 [조정 브랜치](branching.md#조정-브랜치)가 맡아 같은 clone의 worktree에는 즉시, 다른 기기에는 CLI의 push로 보입니다.
4. **정책 단위 문서** — SSOT의 한 결정은 **독립적으로 이해하고 검증할 수 있는 정책 하나**입니다. 조건이 많으면 줄을 합치지 않고 하위 항목이나 표로 폅니다(줄바꿈을 없애는 것은 간결화가 아닙니다). 대신 누가 언제 요청했는지, 과거 논의와 폐기된 방식의 상세, 미사여구는 남기지 않습니다 — 호환성·실패 조건·보안·과금·수치와 단위·부정 표현·필요한 근거는 반대로 반드시 남깁니다. 구조는 `lint`가 강제하고, 의미 품질은 `lint`가 **검토 후보**로만 표시한 뒤 `gusta-doc-review`가 사람과 함께 판단합니다.
5. **구상은 사람과, 실행은 혼자** — 묻는 일은 `/gusta-sketch`에서 끝냅니다(요청 한 줄로 충분하면 `/gusta-start <요청>` — 요청문이 곧 사람의 결정입니다). `/gusta-start`는 한 번도 묻지 않습니다 — 기획·기술 모두 추천안으로 진행하고, 받았어야 할 질문과 고른 답을 **결정함**(조정 브랜치의 inbox — `vibe inbox`)과 **보고서**(`spec/reports/`)에 남깁니다. 태스크마다 커밋하고, 검증·push는 [검증과 push](branching.md#검증과-push)를 따릅니다. 선점과 진행은 SETTINGS push와 무관하게 조정 브랜치로 공유돼 다른 worktree·다른 기기에서도 보입니다.

## 스킬과 흐름

사용자가 직접 부르는 스킬입니다.

| 스킬 | 역할 | 하는 일 | 산출물 |
| --- | --- | --- | --- |
| `gusta-sketch` | 기획 진행자 | 만들 것을 HTML 시안 한 페이지로 그려 로컬 포트 하나에 띄움(갈리는 선택이 있으면 시안을 나란히) → 사용자가 고르고 다듬음 → 내부 스킬로 ARCH·SSOT·태스크까지. 미룬 구상은 ideation 문서로. 제품 코드는 고치지 않음 | `.tmp/sketch/<slug>/`(커밋 안 함), `spec/ssot/`·`spec/tasks/`·`spec/ideation/` |
| `gusta-start` | 실행자 | 다른 세션·기기 진행 확인 → (변경 요청이 있으면 SSOT·태스크부터) → 실행 정보를 보여 주고 묻지 않고 실행 → 태스크별 커밋 → 마감 관문(전체 검증 뒤 SETTINGS land로 반영 한 번). 실행 중 판단은 결정함·보고서. 태스크가 없으면 `/gusta-sketch` 안내 | 조정 브랜치의 세션 행·결정함, `spec/reports/` |
| `gusta-design-mode` | 디자인 진행자 | 이 checkout만 디자인 중으로 표시하고 말하는 대로 코드만 즉시 수정(테스트·커밋·push 없음) → 디자인 끝이면 전체 테스트 후 커밋 하나. 커밋·push 전엔 항상 디자인이 끝났는지 묻는다 | checkout 로컬 디자인 상태, 디자인 커밋 |
| `gusta-showcase` | 비교 진행자 | 문제 하나를 변형 2~6개로 실제 코드까지 병렬 구현(하위 세션·변형별 worktree, UI는 공용 mock scaffold 위) → 변형마다 포트 하나씩 띄워 비교 페이지(hub)에 나란히, 또는 같은 측정을 번갈아 → 고른 변형만(scaffold 제외) 현재 브랜치에 merge하고 문서도 맞춤 | `ab/<slug>/<v>` 브랜치, 채택 merge·log 한 줄 |
| `gusta-self-improve-remote` | 개선 조정자 | 실행 기록·코드·업무 흐름에서 문제 발견 → 제한된 측정·구현 → 별도 세션 검토 → PR. 큰 변화는 사람 판단 | 기존 review/task/report + 개선 PR |
| `gusta-self-improve` | 호출 세션이 오케스트레이터 | 하위 탐색의 제안 → 오케스트레이터 승인 → 승인 범위 구현·독립 리뷰 → 현재 브랜치 통합 | 승인 기록 + 로컬 커밋·검증·보고서 |
| `gusta-init` | 설정 인터뷰 | 브랜치 전략(개발 브랜치를 운영하는지 — land·병합 방식·push·배포 브랜치·기획 브랜치), 자동 버전 관리, CLAUDE.md·AGENTS.md의 gusta 안내 블록 중 미정인 것만 묻고 저장. 다른 스킬도 미정이면 먼저 이리로 보냄 | `spec/SETTINGS.md` |
| `gusta-preference` | 설정 안내 | 이 프로젝트의 패키지 동작 설정(`spec/SETTINGS.md`)을 표로 보여 주고, 말한 값만 바꿈 | `spec/SETTINGS.md` |
| `gusta-update` | 업데이트 담당 | npm 새 버전 확인 → 스킬 재설치 → spec/ 구조 이관(`migrate`)·FORMAT 병합 → lint → 커밋 | 설치·이관 커밋 |
| `gusta-send-issue` | 회고자 | 이 세션에서 GUSTA 스킬·CLI가 어떻게 동작했는지 돌아보고 개선 사항을 근거와 함께 익명화해 보여 준 뒤, 확인받으면 이슈로 올림 | hetarho/gusta 이슈 1건 |

나머지는 `/gusta-sketch`·`/gusta-start`(와 작업 묶음)가 부르는 내부 스킬입니다. 숨기지는 않지만 평소에 직접 부를 일은 없습니다.

| 부르는 곳 | 스킬 | 역할 | 하는 일 | 산출물 |
| --- | --- | --- | --- | --- |
| sketch(spec/ 없음·스택 변경) | `gusta-create-architecture` | 엔지니어 | `spec/` 초기화 + 사용자 수준 캘리브레이션 + 아키텍처 인터뷰(스택·구조·컨벤션·검증 명령) | `spec/STATE.md` `spec/FORMAT.md` `spec/ssot/ARCH.md` |
| sketch(새 도메인) | `gusta-create-ssot` | 기획자 | 고른 시안을 도메인 SSOT로 — 시안에서 정하지 못한 공백만 기획 인터뷰 | `spec/ssot/<ID>.md` |
| sketch·start·design-mode·showcase 마감·doc-review 보류 | `gusta-update-ssot` | 기획자 | 기획 변경 반영 — rev+1, 변경 로그, 파급 표시 | 갱신된 SSOT + STATE pending |
| sketch(마지막 단계)·start(실행 중 공백) | `gusta-create-task` | 엔지니어 | SSOT 변경분(pending)과 채택된 리뷰 finding을 개발 인터뷰와 함께 태스크로 분해(dep·lane·검증 포함) | `spec/tasks/T###.md` |
| start·작업 묶음 워커 | `gusta-implement-task` | 엔지니어 | 태스크 선점(`vibe task start`) → 구현 → 검증(커밋 직전 영향 단위 테스트·빠른 검사 한 번. 빌드·전체 스위트·CI는 마감 관문) → done(`vibe task done`이 보관·STATE 갱신) | 코드 + 갱신된 태스크/STATE |
| 작업 묶음 | `gusta-review-task` | 리뷰어 | 제출 커밋 검토 → 승인 또는 수정 요청 | 커밋·상위 기준에 고정된 리뷰 기록 |
| start(병렬 조건) | `gusta-manage-work` | 작업 조정자 | 상위 브랜치·태스크 worktree 배정 → 검증·통합 → 정리 | 작업 묶음 + 공유 실행 기록 |
| 요청 시 | `gusta-review-code` | 리뷰어 | 코드를 ARCH 컨벤션·개발 관점에서 점검해 우선순위 붙은 리팩토링 finding을 제안, 사용자가 채택(채택분은 `/gusta-sketch`가 태스크로) | `spec/review/<slug>.md` |
| 요청 시 | `gusta-doc-review` | 편집자 | 기존 SSOT를 의미 보존 원칙 아래 정리 — 복합 결정 분해, 과거 흔적·중복 제거. 정책이 바뀌어야 하는 문제는 `gusta-update-ssot`로 넘김 | 다듬어진 `spec/ssot/*.md` (rev 불변) |
| 요청 시 | `gusta-create-narrative` | 작가 | spec 전체를 사람이 읽기 좋은 한국어 이야기로 엮음 | `spec/NARRATIVE.md` |

## `spec/` 구조

설치된 프로젝트에는 다음 구조가 생깁니다.

```text
spec/
├── STATE.md      # 관제탑: cfg(사용자 수준) · SSOT rev 현황 · 태스크 보드 · next (실행 중 세션·결정함·log는 조정 브랜치의 SESSIONS.md)
├── FORMAT.md     # 모든 spec 문서의 압축 표기 규칙 (ID, 기호, 골격, 상태 규칙)
├── SETTINGS.md   # (선택) 패키지 동작 설정 — 없는 키는 기본값. /gusta-preference로 보기·바꾸기
├── ideation/     # (선택) gusta-sketch가 미룬 구상 — open(미정), ready(일부 SSOT 반영·진행 중)
│   └── done/     # 전체 SSOT 반영을 확인한 converted 문서 보존 — STATE에서는 제거
├── ssot/         # 도메인별 SSOT — 결정([o]/[?]/[x])과 근거만, rev로 변경 추적
├── review/       # (선택) 코드/자율 개선 finding — 사용자 채택 또는 명시적 사전 위임 범위의 [o]가 태스크의 재료
├── reports/      # (선택) /gusta-start 실행 보고서 — 한 일·잠정 결정·주차한 일·검증 결과 (owner가 읽는 사용자 언어)
└── tasks/        # 남은 태스크(todo·doing·blocked)만 — 완료기준·구현메모·결과, base 스탬프로 신선도 검증
    └── done/     # 완료된 태스크 아카이브 — STATE 표는 항상 남은 일만 보여줍니다
```

`tasks/done/`은 **당시의 의도와 실제 구현·검증을 비교할 수 있는 역사 기록**입니다. 평가와 회귀 조사를 위해 보존하지만, 현재 규칙의 근거는 아닙니다(`st`·`base`는 완료 시점의 값입니다). 그래서 일반 구현 작업은 완료 태스크를 기본 입력으로 읽지 않고, 특정 태스크·회귀 원인·이전 검증 방법을 조사할 때만 해당 파일을 골라 엽니다. 지금도 지켜야 하는 계약이 완료 태스크에만 남아 있다면 그건 SSOT로 올라가야 할 신호입니다.

ideation 문서는 gusta-sketch가 사용자가 아직 정하지 않고 미룬 구상만 기록합니다(정한 것은 바로 SSOT·태스크로 갑니다). `open`(미정) → `ready`(SSOT 반영 대기·진행 중) → `converted`(채택 범위 전체 반영)로 구분합니다. gusta-create-ssot·gusta-update-ssot는 실제 SSOT와 반영 범위를 대조하고, 모든 채택 도메인에 매핑이 있고 미정·열린 질문이 처리됐을 때만 `ideation/done/`으로 옮기며 STATE 행을 제거합니다. 일부만 반영했으면 `ready`로 유지합니다. 완료 문서는 과거 논의 조사에만 사용하며 현재 규칙은 SSOT에서 읽습니다. 기존 converted 문서도 같은 확인 후 이동하고, 예전 domains의 상태 없는 줄은 채택으로 취급합니다. 프로젝트 FORMAT 이관은 [기존 프로젝트 이관](cli.md#기존-프로젝트-이관)을 따릅니다.

SSOT의 `rev`(현재 개정)와 STATE의 `tasked`(태스크로 소화된 개정)의 차이가 곧 "아직 구현 계획에 반영되지 않은 기획 변경"입니다. `/gusta-sketch`는 이 차이를 남은 기획 재료로 보여 주고, 태스크로 쪼갤 때 무엇이 어떻게 바뀌었는지 스스로 찾아냅니다. `/gusta-start`는 이 차이를 기획하지 않습니다 — 실행할 태스크 없이 이것만 남으면 `/gusta-sketch`를 안내하고 멈춥니다.

`spec/` 문서는 영어, 인터뷰·확인·보고는 사용자 언어(`cfg.lang`)입니다. 예외는 사람용 산문 `spec/NARRATIVE.md`(gusta-create-narrative, 새 결정 없음)와 실행 보고서 `spec/reports/`입니다.

## 구상하기 — `/gusta-sketch`

```text
/gusta-sketch 작업 기록에서 기간별 비교를 할 수 있으면 좋겠다
/gusta-sketch                       ← 요청이 없으면 남은 기획 재료를 보여 주고 고르게 합니다
```

기획의 진입점입니다. 보고 고르는 일을 여기서 끝내 두면 `/gusta-start`는 묻지 않고 실행합니다. 제품 코드·테스트는 고치지 않습니다.

1. `vibe status`를 봅니다. `spec/`이 없거나 스택·구조·검증 명령을 정해야 하면 gusta-create-architecture부터 합니다 — 검증 명령이 있어야 `/gusta-start`가 태스크를 끝까지 검증합니다. 같은 주제의 미룬 구상(open/ready ideation 문서)이 있으면 이어서 씁니다. 요청 없이 부르면 미룬 구상, 태스크로 아직 안 쪼갠 SSOT 변경(pending), 채택된 review, 결정함의 잠정 결정을 보여 주고 고르게 합니다. 잠정 결정을 바꾸는 것도 여기서 합니다.
2. **시안**: 화면·흐름·데이터처럼 보면 빨리 정해지는 것은 HTML 한 페이지 `.tmp/sketch/<slug>/index.html`로 그립니다. 외부 리소스 없는 한 파일(인라인 CSS·SVG)이고, 동작하는 코드가 아니라 보이는 기획입니다 — 실제 화면 같은 정적 목업, 사용자 흐름, 상태별 화면(빈·오류·많음), 필요하면 다이어그램. 실제로 갈리는 선택이 있으면 시안을 같은 페이지에 나란히 두고(말한 개수대로, 아니면 2~3개) 이름·한 줄 접근·장단점과 추천 하나를 붙입니다. 정책 문구처럼 볼 것이 없는 변경은 시안 없이 바로 5번으로 갑니다.
3. **포트 하나**: `vibe sketch serve <slug>`가 그 폴더를 127.0.0.1의 포트 하나로 띄웁니다(캐시 없음, 같은 slug의 살아 있는 서버는 재사용, 기본 8시간 뒤 스스로 종료). 페이지를 고치면 새로고침만 하면 됩니다. `.tmp/`는 `.git/info/exclude`로 무시되므로(`.gitignore`는 고치지 않음) 시안은 커밋되지 않습니다.
4. **고르기**: 한 라운드 = 시안 갱신 → 짧은 요약과 선택지 질문 2~3개 → 답 반영. 넓히기(놓친 방향·유사 사례)·좁히기(핵심 하나·안 할 것·v1 경계)·검증(허점·가장 위험한 가정)을 오가며 사용자가 고를 때까지 돕니다. 기술 구현 결정은 하지 않고 실현 가능성 우려만 태스크 단계로 넘깁니다.
5. **문서와 태스크**: 고른 시안을 새 도메인은 gusta-create-ssot, 기존 도메인은 gusta-update-ssot로 옮기고(인터뷰는 시안에서 정하지 못한 공백만), 이어서 gusta-create-task가 dep·lane·검증을 갖춘 태스크까지 만듭니다. 개발 질문도 이 세션에서 받습니다 — `/gusta-start`는 묻지 않으니까요. 시안 HTML은 커밋되지 않으므로 핵심 화면의 기대 모습은 태스크 acceptance에 말로 적습니다. 기획 커밋은 spec/만 담아 `vibe plan-push`로 기획 브랜치에 올리고, 코드 반영(`vibe push`)은 하지 않습니다.
6. **미룬 구상**: 사용자가 "이렇게 하자"고 정하지 않은 것 — "이 부분은 괜찮은데 나중에 다시 고민하자"처럼 미룬 구상, 아직 고르지 않은 시안의 방향, 남은 질문 — 은 SSOT·태스크로 옮기지 않고 `spec/ideation/<slug>.md`에만 적습니다. 시안의 방향을 채택 `[o]`(SSOT로 간 것)·폐기 `[x]`(이유 필수 — 같은 논의를 반복하지 않게)·미정 `[?]`으로 남기고, 다시 볼 화면 구성·흐름도 말로 적습니다. 다음 sketch의 재료가 됩니다.
7. **마감**: `vibe sketch stop <slug>`로 서버를 내립니다. 시안 파일은 `.tmp`에 남아 다시 부르면 이어서 고칩니다. 고른 것·버린 것(이유)·미룬 것·바뀐 SSOT rev·만든 태스크를 요약하고 `/gusta-start`로 넘깁니다.

## 실행하기 — `/gusta-start`

```text
/gusta-start
/gusta-start T012 T013 4시간 안에      ← 태스크 범위와 시간 한도(또는 마감 시각)
/gusta-start 로그인 버튼 문구 고쳐줘      ← 작은 수정 요청은 태스크 없이 경량 경로로
/gusta-start 알림을 하루 한 번 묶어 보내줘  ← 규칙·동작 변경 요청은 기획부터 구현까지
```

이미 만들어 둔 태스크를 사람 없이 끝까지 실행합니다. 시작할 때 묻지 않습니다. 인자 없이 부르면 STATE와 태스크를 보고 시작합니다.

규칙·동작을 바꾸는 요청과 함께 부르면 **요청 실행**입니다: 요청 해석(바꿀 도메인·결정, 추천안으로 채울 공백)을 실행 정보와 함께 보여 주고, gusta-update-ssot(새 도메인이면 gusta-create-ssot)와 gusta-create-task로 SSOT·태스크를 만들어 기획 브랜치에 올린 뒤, 그 태스크(와 그것이 기다리는 미완료 선행 태스크)만 아래 절차로 구현합니다. 요청에 적은 것은 사용자 결정으로 그대로 반영하고, 요청이 정하지 않은 공백만 추천안으로 정해 결정함에 남깁니다. 과금·데이터 삭제·개인정보·보안 정책은 요청에 적은 것만 반영하고 나머지는 주차합니다. 화면을 보고 골라야 할 만큼 갈리는 기획은 `/gusta-sketch`가 낫습니다.

1. `vibe status`로 다른 worktree·다른 기기에서 진행 중인 세션(조정 브랜치의 세션 행 — 브랜치·커밋과 그 커밋이 아직 push 안 됐는지, `wip/<tag>` 스냅샷)을 확인합니다. 남이 잡았거나 끝내고 아직 land에 들어가지 않은 태스크는 건너뜁니다 — 가로채지 않습니다.
2. **실행 정보를 한 번 보여 주고 바로 시작합니다**: 대상 태스크(인자로 준 범위), dep 순서와 병렬 여부(작업 묶음이면 lane), 마감·예약 시간, 검증 단계(태스크 단계·최종 관문 명령), 반영 설정(SETTINGS land·land-via·push), 다른 세션·기기의 진행과 건너뛸 태스크, 결정함 미확인 수, 완료 알림 연결 여부. 질문이 아니므로 답을 기다리지 않습니다. 반영 대상도 묻지 않습니다(land 미정이면 현재 브랜치에 커밋만 하고 결정함에 남깁니다 — 정하는 것은 `/gusta-init`).
3. 요청도 실행할 태스크도 없으면 멈추고 `/gusta-sketch`로 먼저 구상하라고 안내합니다(미룬 구상·태스크로 안 쪼갠 SSOT 변경·채택된 review가 있으면 그 목록도). 여기서 기획·태스크를 만들지 않습니다. 이 checkout이 디자인 중이면 `/gusta-design-mode`로 마감한 뒤 다시 실행하라고 하고 끝냅니다.
4. 태스크를 dep 순서로 gusta-implement-task가 구현합니다. 시작한 대화가 오케스트레이터로 목표·마감·검증을 끝까지 책임지고, [`vibe loop`](autopilot.md#오래-맡기기--vibe-loop)는 단위마다 새 세션을 띄우는 보조 실행기입니다. 실행 전 점검(`vibe preflight`: 디자인 중 여부·작업 트리·lint·검증 명령·절전 방지, push가 켜져 있으면 push 권한·CI 접근, 작업 묶음이면 헤드리스 워커의 명령 실행 권한 실측)은 loop가 준비합니다. 독립 줄기가 충분히 클 때만 [작업 묶음](parallel-work.md)으로 병렬 처리합니다.
5. 실행 중 판단은 묻지 않고 추천안으로 정해 결정함·보고서에 남깁니다. 구현이 기획·기술 판단으로 막히면 그 태스크를 풀기 위한 기획 한 조각(gusta-update-ssot + gusta-create-task)으로 해소해 재개합니다 — 요청 실행이 아니면 새 기능의 기획은 하지 않습니다. 권한 확인 창도 질문이라 창이 뜰 만한 명령은 실행하지 않고 주차합니다.
6. 태스크마다 커밋합니다. 보고서는 태스크 3개(기본)·기획 조각 소진·세션 끝에 갱신하고, 전체 검증과 반영은 세션 끝에 한 번입니다([검증과 push](branching.md#검증과-push)). 선점은 SETTINGS push와 무관하게 조정 브랜치에서 합니다(`vibe task start` — 다른 세션이 잡았으면 거절되고 다른 태스크로 갑니다). 1시간 넘는 작업은 `wip/<tag>`로 스냅샷합니다(원격에는 SETTINGS push가 켜져 있을 때만 올라갑니다).

| 결정 지점 | 실행 중 처리 |
| --- | --- |
| 되돌릴 수 있는 기획·기술 판단 | 추천안으로 진행하고 결정함(`decided`)·보고서에 질문·선택·대안·이유를 남깁니다 |
| 과금·데이터 삭제·개인정보·보안 정책 | 정하지 않고 `[?]`로 두고 주차합니다 |
| 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일(force push, 브랜치 삭제, 배포·게시 등), 실제 권한·인증 부재 | 그 작업만 주차(`parked`)하고 다른 태스크를 계속합니다 |

돌아오면 결정함부터 봅니다. 승인한 항목은 `/gusta-start inbox 정리`로 그 줄을 지우고(`vibe inbox resolve`, log에 남김), 결정을 바꾸려면 `/gusta-sketch`로 갑니다(gusta-update-ssot로 확정한 뒤 그 줄을 지웁니다). SSOT에는 잠정 결정도 일반 결정으로만 들어가며, 잠정이라는 사실은 결정함이 결정 ID로 가리킵니다. 끝난 뒤에는 새 대화에서 `/gusta-start`로 이어갈 수 있습니다 — 상태는 보고서·결정함·`loop.json`에 남습니다.

보정·튜닝·밸런스처럼 돌려 보고 정하는 일은 **explore 태스크**(`explore:2h` + `exit:` 완료 조건)로 만들어 메인 세션에서 시간 제한 안에 끝냅니다 — 기준을 못 맞추면 측정값을 기록하고 마감합니다.

태스크 하나는 새 세션 하나에 넉넉히 들어가는 크기입니다: 관심사·모듈 경계 하나, 테스트를 뺀 touches 5개 이하, 단위 상한(기본 60분) 안, `vibe brief T### --json`의 `size.budget`(brief 40k자 기준)을 넘지 않게 — 넘으면 도메인·모듈별로 쪼갭니다. 기획할 때 gusta-create-task가 `gusta agents --json`(SETTINGS `agents`에 든 도구의 모델·에포트, 싼 순서)에서 그 태스크에 충분한 가장 싼 조합을 골라 인용줄에 `run:claude/sonnet@high`처럼 적어 둡니다 — 판단은 기획 때 문서에 남기고, 실행 때 모델을 즉흥으로 고르지 않습니다 — `vibe loop`·`work run`이 그 `run:`대로 단위를 배정합니다(못 쓰면 score가 가장 가까운 조합, [오래 맡기기](autopilot.md#오래-맡기기--vibe-loop)). 쓸 도구와 순서는 `/gusta-init`이 정하고, 정하지 않았으면 맡김은 `needs-init`으로 시작하지 않습니다.

SSOT·계약·저장 형식·결정이 바뀌지 않는 작은 버그/문구/스타일(3파일·추가+삭제 100줄 이하)은 태스크 파일 없이 영향 검사·커밋 하나·fix log 한 줄(`vibe log`)로 처리합니다. 조건이 깨지면 기획 한 조각으로 태스크를 만들어 올립니다.

## 디자인 — `/gusta-design-mode`

```text
/gusta-design-mode 랜딩 페이지 히어로 영역
```

화면을 띄워 두고 말하는 대로 바로 코드만 고치는 흐름입니다. 사람이 화면을 봐야 하므로 사용자가 직접 부를 때만 쓰고, `/gusta-start`의 실행 단위·작업 묶음 워커에서는 시작하지 않습니다.

1. `vibe design start`로 이 checkout이 디자인 중임을 표시합니다. 이 상태는 checkout의 Git 디렉터리에만 저장되고 STATE에는 쓰지 않으므로, 기획 커밋·plan-push를 타고 다른 worktree로 퍼지지 않습니다. 개발 서버(hot reload)를 띄워 두고 결과를 실시간으로 봅니다.
2. 디자인하는 동안에는 테스트·e2e·typecheck·커밋·push를 하지 않습니다. 그 checkout에서는 `vibe push`가 거절되고, `/gusta-start`의 preflight는 실패하며 `vibe loop`는 멈춥니다. 다른 worktree의 작업은 영향을 받지 않습니다. 중간 저장이 필요하면 `vibe checkpoint`로 `wip/<tag>`에만 스냅샷합니다.
3. 커밋·push가 필요해지면(직접 요청, 다른 스킬로 전환, 마감) 어떤 스킬이든 먼저 **"디자인 끝났나요?"** 를 묻습니다.
4. 디자인이 끝나면 `vibe design verify`로 ARCH의 task·batch 명령 전부를 미커밋 작업 트리에서 한 번씩 돌립니다(빠른 검사가 실패하면 무거운 검사는 미룸, 같은 트리는 캐시). 디자인 때문에 바뀐 기대값은 테스트를 고치고, 깨진 기능은 코드를 고칩니다. 통과하면 `vibe design end` 후 디자인·테스트 수정을 커밋 하나로 남기고 `vibe log`에 `design <area>: <what>` 한 줄을 씁니다. 반영(`vibe push`)은 요청했거나 SETTINGS land·push가 반영을 정해 둔 경우에만 합니다.

## 여러 안을 띄워 고르기 — `/gusta-showcase`

말로 고르기 어려운 것은 만들어 보고 고릅니다. 문제를 말하면 서로 다른 접근의 변형을 2개(최대 6개) 실제 코드로 병렬 구현하고, 변형마다 포트 하나씩 띄워(변형 4개면 포트 4개) 나란히 보여 줍니다. 디자인·UX·UI·기능 비교는 브라우저로, 성능 비교는 같은 측정 명령을 번갈아 돌린 중앙값으로 봅니다. 고른 변형만 합치고 문서도 맞추므로 문서부터 코드까지 한 번에 끝납니다.

| | `/gusta-sketch` | `/gusta-showcase` |
| --- | --- | --- |
| 보여 주는 것 | HTML 시안 한 페이지(코드 없음), 시안은 그 페이지에 나란히 | 실제 코드로 구현한 변형 2~6개 |
| 포트 | 하나 | 변형마다 하나 |
| 결과 | spec 문서와 태스크(미룬 구상은 ideation 문서) — 구현은 `/gusta-start` | 고른 변형을 현재 브랜치에 merge, SSOT도 갱신 |

```text
/gusta-showcase 가격표 페이지를 카드형과 표형 두 가지로 만들어서 띄워줘
/gusta-showcase 검색 응답이 느려. 캐시 방식 세 가지로 구현해서 벤치마크로 비교해줘
```

1. 변형마다 `ab/<slug>/<a|b|…>` 브랜치와 형제 worktree, 포트(4101부터 빈 포트)가 생기고 의존성 설치(`--setup`)가 병렬로 돕니다(`vibe ab start`). 목표·제약·지킬 결정·볼 화면처럼 변형 공통 글은 `--shared-file`로 한 번만 쓰고, 변형마다는 접근만 씁니다. lockfile이 그대로면 `--reuse node_modules`가 설치 대신 이 checkout의 의존성 폴더(git이 무시하는 것만)를 복사합니다.
   - 백엔드·로그인 없이는 화면이 뜨지 않는 UI 비교면 `--scaffold-prompt <file>`로 세션 하나가 먼저 그 화면을 mock 데이터·인증 stub으로 띄우는 커밋(`ab/<slug>/base`)을 만들고(가능하면 `?mock=empty|error` 상태도) 변형은 모두 그 위에서 시작합니다. 이미 있는 커밋은 `--scaffold <ref>`. 변형은 scaffold를 고치지 않습니다.
2. 변형마다 새 하위 세션이 자기 worktree만 고칩니다(`vibe ab run --all`이 한 번에 병렬로, 헤드리스 Claude·Codex 또는 에이전트의 하위 세션). 커밋은 CLI가 변형 브랜치에 하고, 진행자에게는 요약과 "어디를 보면 되는지"만 돌아옵니다. 변형이 scaffold 줄을 고쳤으면 결과의 `scaffoldTouched`를 보고 보여 주기 전에 되돌리게 합니다.
3. `vibe ab serve`가 변형마다 개발 서버를 `$PORT`로 띄우고 볼 화면이 HTTP로 응답하면 비교 페이지(hub) 하나를 엽니다. 사용자는 그 URL 하나에서 변형을 나란히(데스크톱·모바일 폭) 보고 메모를 남기거나 choose를 누릅니다. `vibe ab exec --repeat 3`은 변형을 번갈아 실행해 시간 중앙값·최소값을 모으고 hub에도 보여 줍니다. 진행자는 변형 | 접근 | 측정값 | 볼 곳 | 장단점 비교표 하나로 보여 줍니다.
   - 한 변형을 고쳐 달라고 하면(말이나 hub 메모) `vibe ab run --variant b --follow-up-file <요청>`이 접근·지난 요약·메모를 붙여 같은 변형을 이어 고치고, `vibe ab serve --variant b`가 떠 있는 서버로 다시 확인합니다.
   - "A의 레이아웃에 B의 색"처럼 섞고 싶으면 `vibe ab add --from a`가 A에서 이어지는 새 변형을 만들고 그것만 run합니다.
4. choose는 의사 표시일 뿐입니다 — 진행자가 `vibe ab status`로 읽고 사용자에게 확인한 뒤 `vibe ab pick`이 서버·hub를 끄고 그 변형만 현재 브랜치에 merge 커밋으로 합친 뒤 worktree를 정리합니다(브랜치는 `prune-branches` 설정대로, 기본은 삭제). scaffold는 줄·파일 단위로 빼고 합칩니다. 변형 코드에 scaffold의 mock 줄·경로가 옮겨져 남으면(`scaffoldResidue`) pick이 거절하니 지우는 후속 수정 뒤 다시 고르고, 사용자가 그 줄을 보고 받아들이면 `--accept-residue`입니다. 실제 데이터 연결은 gusta-create-task로 이어집니다.
5. 채택은 결정이라 pick이 log에 `- YYMMDD ab <slug>: adopt <v> — <approach>` 한 줄을 남기고(접근 문구는 `--approach`), SSOT 규칙이 바뀌었으면 gusta-update-ssot로 이어집니다. 전체 테스트는 합친 뒤 평소 마감 관문에서 한 번입니다.

변형마다 구현 세션 하나만큼 토큰·시간이 들고, 고를 사람이 있어야 하므로 사용자가 직접 부를 때만 씁니다(`/gusta-start` 실행 중에는 비교 요청을 결정함에 주차합니다). 변형은 spec/을 고치지 않으며 미커밋 변경이 있으면 시작하지 않습니다.

## 스킬을 직접 부르기

원하는 결과를 설명하거나 스킬 이름을 대면 그 스킬을 씁니다. 기획·태스크·구현 스킬(gusta-create-ssot·gusta-create-task·gusta-implement-task 등)은 `/gusta-sketch`와 `/gusta-start`가 부르므로 직접 부를 일이 없습니다.

```text
새 프로젝트야. 이런 앱을 만들고 싶어.                 → gusta-sketch (spec/ 초기화·아키텍처부터)
무료 플랜에도 태그 기능 열어주는 걸로 기획 바꾸자.       → gusta-sketch (gusta-update-ssot → gusta-create-task)
남은 태스크 해줘. / 이어서 해줘.                        → gusta-start
랜딩 히어로를 화면 보면서 다듬자.                       → gusta-design-mode
리팩토링할 데 있는지 코드 점검해줘.                     → gusta-review-code (채택한 finding은 /gusta-sketch가 태스크로)
THEME SSOT가 너무 길어. 의미 바꾸지 말고 정리해줘.       → gusta-doc-review
/gusta-send-issue                                  → gusta-send-issue
/gusta-preference                                  → gusta-preference (설정 표)
/gusta-preference prune-branches false             → 그 값만 바꾸고 커밋
```

`/gusta-send-issue`는 GUSTA 스킬을 쓴 세션 끝에 부르면, 그 세션에서 스킬·CLI가 어떻게 동작했는지 돌아보고 개선 사항(오류·모호한 지시·토큰/시간 낭비·사람이 판단 아닌 일에 쓴 시간)을 근거와 함께 정리해 미리 보여 줍니다. 대상 프로젝트 이름·도메인·ID는 익명화하고, 확인하면 `gh issue create`로 [hetarho/gusta](https://github.com/hetarho/gusta/issues)에 이슈를 올립니다. 확인 없이는 올리지 않고, `gh`가 없거나 로그인이 안 돼 있으면 새 이슈 링크와 본문만 돌려줍니다. 대상 프로젝트의 파일은 바꾸지 않습니다.

### 설정 — `/gusta-preference`

설정은 `spec/SETTINGS.md`에 한 줄씩 남고, 파일이나 키가 없으면 기본값을 씁니다. [브랜치 전략](branching.md#브랜치-전략)과 [자동 버전](branching.md#자동-버전)(`version`), [조정 브랜치](branching.md#조정-브랜치)(`coord`·`coord-push` — 묻지 않고 기본값을 씁니다) 말고는 `permission-mode`·`headless-mcp`·`prune-branches`·`agent-block`이 있습니다.

`agent-block`(기본 `?` — `/gusta-init`이 한 번 묻습니다)은 이 프로젝트의 에이전트 지침 파일에 gusta 안내 블록을 둘지입니다. `true`면 `gusta agent-block`이 `<!-- gusta:begin … -->`와 `<!-- gusta:end -->` 사이에 짧은 안내(spec 우선, `gusta-sketch`·`gusta-start`, 설정은 `spec/SETTINGS.md`)를 쓰고, 마커 밖은 한 글자도 바꾸지 않습니다. 대상은 Claude 설치면 루트 `CLAUDE.md`(없으면 `.claude/CLAUDE.md`), Codex 설치면 `AGENTS.md`입니다. `AGENTS.md`만 있는 프로젝트에는 `CLAUDE.md`를 새로 만들지 않고 `AGENTS.md`에만 씁니다 — Claude Code는 `CLAUDE.md`가 없을 때만 `AGENTS.md`를 읽기 때문입니다. `CLAUDE.md`가 `AGENTS.md`의 링크이거나 `@AGENTS.md`를 import해도 `AGENTS.md`에만 씁니다. `/gusta-update`가 새 버전 문구로 갱신하고, `gusta check`는 블록이 없거나 낡았거나 마커가 훼손됐으면 실패합니다. 훼손된 마커는 추측해서 고치지 않습니다. `false`면 그 파일들을 쓰지 않으며, 이미 넣은 블록은 `gusta agent-block --remove`로 지웁니다. 맡김 실행은 미정이면 묻지도 쓰지도 않습니다.

`permission-mode`(기본 `bypass`)는 CLI가 띄우는 헤드리스 작성 세션 — `vibe loop` 단위, `work run` 워커, gusta-showcase 변형·scaffold, `vibe preflight --probe` — 의 권한입니다. 이 세션들에는 권한 창에 답할 사람이 없으므로 기본은 권한 확인과 sandbox를 건너뜁니다(Claude bypassPermissions, Codex `--dangerously-bypass-approvals-and-sandbox`, 네트워크 허용). `acceptEdits`로 바꾸면 Claude는 편집+`--allow-tool` 목록만, Codex는 workspace-write sandbox(네트워크 없음)에서 돕니다. 리뷰어는 어느 쪽이든 읽기 전용이고, 명령의 `--permission-mode`는 그 실행에만 적용됩니다.

`headless-mcp`(기본 `isolate`)는 같은 헤드리스 Claude 세션(리뷰어·`work scout` 포함)이 싣는 MCP 서버입니다. 기본은 `--strict-mcp-config`만 붙여 MCP 서버를 하나도 싣지 않습니다 — 사용자·계정에 연결된 서버도, checkout의 `.mcp.json`도 싣지 않습니다(`.mcp.json`은 워커가 커밋할 수 있는 코드라, 직접 넘기면 승인 없이 그 커밋을 검토하는 리뷰어나 다음 단위에서 실행됩니다). 권한 확인 없이 도는 세션이 프로젝트 밖 서비스를 바꾸지 못하고, 쓰지 않는 도구 정의만큼 프롬프트도 줄어듭니다. 이 flag가 없는 예전 CLI에는 붙이지 않습니다. 헤드리스 세션에 MCP가 필요한 프로젝트는 `inherit`로 사용자 설정을 그대로 씁니다. 스킬·CLAUDE.md·플러그인·훅은 어느 쪽이든 그대로이고, Codex 세션은 바뀌지 않습니다.

`prune-branches`(기본 `true`): 작업이 끝나면 CLI가 자기가 만든 것 중 더 이상 쓰지 않는 것을 지웁니다. 작업이 끝나는 시점은 실행기 종료, `work cleanup`, `vibe loop` 종료, 세션 마감의 `vibe prune`, gusta-showcase 채택입니다. 지우는 것은 이미 합쳐진 단위·묶음 브랜치, 그 worktree(설치·빌드 산출물 포함), 체크포인트 ref, 이 세션의 `wip/<tag>`입니다. 원격의 `wip/<tag>`는 HEAD가 push된 뒤에만 지웁니다. 합쳐지지 않은 커밋, 미커밋 변경, 진행 중인 작업은 남기고 이유를 `kept`로 보고합니다.
