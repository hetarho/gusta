# haeram-spec-creator

> **AI가 만들고, 우리는 고른다 — 우리의 취향이 곧 제품이다.**
> *We curate. Our taste is the product.*

아이디어를 구현 가능한 스펙으로 발전시키고, **요구사항 → 설계 → 작업 계획 → 구현 → 검증**을 일관된 흐름으로 연결하는 스펙 주도 개발(Spec-Driven Development)용 Agent Skills 모음입니다.

Claude Code와 Codex가 바로 코드를 작성하기 전에 목표, 범위, 제약, 결정 사항, 완료 조건을 먼저 명확히 하고 각 단계의 결과를 다음 단계의 입력으로 이어 가도록 돕습니다. 이 저장소의 핵심은 라이브러리 API가 아니라 AI 에이전트가 필요할 때 불러 쓰는 스킬이며, npm 패키지는 여러 프로젝트에 그 스킬을 안전하게 설치하고 동기화하기 위한 배포 수단입니다.

> [!TIP]
> 설치: `npx haeram-spec-creator@latest install`([npm](https://www.npmjs.com/package/haeram-spec-creator), Node 프로젝트가 아니어도 됩니다). 사용자가 부르는 스킬은 다섯 — **`/start-vibe`**(작업 시작) · **`/start-design`**(화면 보며 디자인) · **`/ideation`**(아이디어) · **`/self-improve`**(PR 중심 지속 개선) · **`/self-improve-local`**(제안 승인 후 로컬 통합). 나머지 10종은 start-vibe가 골라 쓰며 이름으로 직접 부를 수도 있습니다([개발 흐름](#개발-흐름)).

## 철학

### 제품 철학 — 우리는 큐레이터다

기획 초안도, 코드도, 검증도 AI가 만듭니다. 사람이 하는 일은 **무엇을 남길지 고르는 것**입니다. 같은 기능이라도 무엇을 넣고 무엇을 뺄지, 어떤 결정을 받아들이고 어떤 결정을 돌려보낼지가 제품을 정합니다. 그래서 이 스킬셋은 사람의 시간을 타이핑이나 대기가 아니라 판단에 쓰도록 설계되어 있습니다.

- 함께 모드는 결정 지점마다 추천안과 선택지를 모아 묻고, 맡김 모드는 추천안으로 진행한 뒤 받았어야 할 질문과 고른 답을 **결정함**에 남깁니다. 돌아온 사람은 결정함을 보며 고르기만 하면 됩니다.
- 아이디어(`ideation`)는 AI가 능동적으로 제안하지만 결정은 사람이 합니다. 리팩토링 제안(`review-code`)과 문서 정리(`doc-review`)도 채택은 사람이 합니다.
- 결과 의미·공개 계약·검증 범위를 바꾸는 큰 변화는 AI가 스스로 적용하지 않습니다. 근거와 대안을 갖춘 제안으로 사람의 판단을 기다립니다.

### 구현 철학 — 문서 먼저 · 적은 토큰 · 빠른 구현

1. **spec이 1급 문서다.** 다른 SDD 프로세스와 같습니다. 코드보다 문서가 먼저 바뀝니다. 결정은 SSOT에, 진행은 STATE에, 구현 계획은 태스크에 먼저 쓰고, 코드는 그 결과물입니다. 구현 중 기획 공백이 보이면 코드로 임의로 확정하지 않고 update-ssot로 올립니다.
2. **최소한의 토큰으로 최고의 결과.** 필요한 것만 읽습니다. 구현 세션은 문서 전체가 아니라 태스크가 기대는 결정 블록만 담은 브리핑(`vibe brief`)을 받고, FORMAT은 필요한 발췌만 봅니다. spec은 영어 압축 표기로 쓰고, 명령 출력은 요약과 마지막 몇 줄만 봅니다. 조정자(오케스트레이터)는 코드를 직접 읽거나 고치지 않고 탐색·구현·리뷰를 새 세션에 맡겨 결론만 받습니다 — 읽은 것은 이후 모든 턴에 다시 실리기 때문입니다. 맡김은 단위마다 새 세션을 띄워 대화가 쌓이지 않게 하고, 같은 트리에서 통과한 검사는 다시 돌리지 않으며, CI·긴 명령을 기다리는 동안에는 모델을 부르지 않습니다.
3. **spec을 위해 속도를 포기하지 않는다.** 시간은 구현에 씁니다. 태스크마다 도는 것은 **변경 영향 단위 테스트와 빠른 검사(typecheck·lint·format)뿐**이고, 통합·e2e·전체 스위트·CI는 main(대상 브랜치)에 push하기 직전(push가 없으면 세션 끝)에 조정자가 한 번 실행합니다. 30분짜리 전체 테스트를 태스크 10개마다 돌리면 그것만으로 5시간이 사라집니다. 대신 맡김의 마지막 구간만 **마감 관문**(전체 검증·push·CI)에 남겨 둡니다. 그 길이는 고정 비율이 아니라 실측입니다 — 전체 검증 실측 시간 + 실패하면 고칠 단위 하나 + 다시 돌릴 시간(+CI). 30분짜리 스위트라면 10시간 중 약 1.5시간만 예약하고 나머지는 구현에 씁니다.

### 코드 원칙 — 낮은 결합, 높은 응집

빠른 구현은 코드가 단위 테스트로 검증될 수 있을 때만 가능합니다. 한 모듈은 한 가지 책임만 지고(높은 응집), 다른 모듈의 내부를 알지 못하며, DB·네트워크·파일·시간·난수 같은 바깥 세계는 경계에서 주입합니다(낮은 결합). 그러면 단위 테스트가 실제 서비스 없이 몇 초 안에 돌고, 태스크마다 돌릴 영향 테스트도 작아집니다. 테스트하기 어려운 코드는 테스트를 무겁게 만들어 해결하지 않고 구조를 고칩니다. ARCH가 모듈 경계와 의존 방향을 정하고, `create-task`가 그 경계를 따라 태스크를 나누고, `implement-task`가 그렇게 구현하고, `review-code`가 결합·응집·테스트 용이성을 점검합니다.

## 핵심 개념

위 철학은 다섯 가지 설계 원칙으로 구현되어 있습니다.

1. **역할 분리** — SSOT(기획)는 **기획자** 역할의 에이전트가 기획 관점 질문(목적·타겟·범위·플로우·정책)으로 만들고, 태스크(구현 계획)는 **엔지니어** 역할의 에이전트가 개발 관점 질문(데이터 모델·API·엣지·마이그레이션)으로 만듭니다. 기획 문서에 기술 결정이, 구현 단계에 기획 재논의가 섞이지 않습니다. 기획 쪽에 변경을 제안하는 `ideation`이 있듯, 개발 쪽에는 코드 품질을 대변해 리팩토링을 주장하는 **리뷰어**(`review-code`)가, 문서 쪽에는 의미를 보존하며 문장을 다듬는 **편집자**(`doc-review`)가 있습니다. 지속 개선을 명시적으로 위임하면 self-improve가 그 범위 안의 동작 보존 개선을 스스로 채택하고 독립 검토를 거쳐 PR로 만듭니다.
2. **사용자 수준 적응** — 최초 1회 캘리브레이션으로 `expert / mid / novice`를 정하면 모든 질문과 보고가 그 수준에 맞춰집니다. expert에게는 선택지를 용어로만 나열하고 세부·엣지까지 직접 묻고, mid에게는 선택지에 장단점을 한 줄씩 붙이고, novice에게는 기술명 대신 "무엇이 어떻게 되는지"를 물은 뒤 기술 결정은 에이전트가 내리고 한 줄로 보고합니다.
3. **문서 먼저** — 단독 작업과 기획 공간은 진행 문서(`spec/STATE.md`)에 시작과 상태 변화를 기록합니다. 작업 묶음의 워커는 공유 실행 기록에 상태를 남깁니다. 세션을 이어 받아도 "다음 태스크 구현해줘", "SSOT 변경분 태스크로 쪼개줘"가 통하도록 현재 checkout의 맥락을 보존합니다. STATE 수정은 원자적 선점이 아니며, 다른 worktree의 변경은 자동으로 공유되지 않습니다.
4. **정책 단위 문서** — SSOT의 한 결정은 **독립적으로 이해하고 검증할 수 있는 정책 하나**입니다. 조건이 많으면 줄을 합치지 않고 하위 항목이나 표로 폅니다(줄바꿈을 없애는 것은 간결화가 아닙니다). 대신 누가 언제 요청했는지, 과거 논의와 폐기된 방식의 상세, 미사여구는 남기지 않습니다 — 호환성·실패 조건·보안·과금·수치와 단위·부정 표현·필요한 근거는 반대로 반드시 남깁니다. 구조는 `lint`가 강제하고, 의미 품질은 `lint`가 **검토 후보**로만 표시한 뒤 `doc-review`가 사람과 함께 판단합니다.
5. **결정할 사람이 있는지로 나뉘는 두 모드** — `/start-vibe`는 시작할 때 한 번 묻습니다. **함께**는 결정 지점마다 선택지를 모아 묻고, **맡김**은 그 뒤로 한 번도 묻지 않습니다 — 기획·기술 모두 추천안으로 진행하고, 받았어야 할 질문과 고른 답을 **결정함**(STATE `## inbox`)과 **보고서**(`spec/reports/`)에 남깁니다. 태스크마다 커밋하고, 검증·push는 [검증과 push](#검증과-push)를 따릅니다. cfg push에 브랜치가 있으면 다른 세션이 보일 때 선점 정보부터 원격에 공유해 다른 기기에서도 보입니다.

## 개발 흐름

| 순서 | 스킬 | 역할 | 하는 일 | 산출물 |
| --- | --- | --- | --- | --- |
| 진입점 | `start-vibe` | 진행자 | 원격의 다른 기기 진행 확인 → 모드 질문 → 다음 스킬 선택 → 태스크별 커밋 → 마감 관문(전체 검증, cfg push 브랜치가 있으면 push 한 번). 맡김이면 결정함·보고서 | STATE `## active`·`## inbox`, `spec/reports/` |
| 디자인 | `start-design` | 디자인 진행자 | 이 checkout만 디자인 중으로 표시하고 말하는 대로 코드만 즉시 수정(테스트·커밋·push 없음) → 디자인 끝이면 전체 테스트 후 커밋 하나. 커밋·push 전엔 항상 디자인이 끝났는지 묻는다 | checkout 로컬 디자인 상태, 디자인 커밋 |
| 아이디어 | `ideation` | 기획 전문가 | 흐릿한 아이디어를 발산·수렴 루프로 함께 구체화, SSOT 전환용 도메인 분할까지 | `spec/ideation/<slug>.md` |
| 지속 개선 | `self-improve` | 개선 조정자 | 실행 기록·코드·업무 흐름에서 문제 발견 → 제한된 측정·구현 → 별도 세션 검토 → PR. 큰 변화는 사람 판단 | 기존 review/task/report + 개선 PR |
| 로컬 개선 | `self-improve-local` | 호출 세션이 오케스트레이터 | 하위 탐색의 제안 → 오케스트레이터 승인 → 승인 범위 구현·독립 리뷰 → 현재 브랜치 통합 | 승인 기록 + 로컬 커밋·검증·보고서 |
| 0 | `create-architecture` | 엔지니어 | `spec/` 초기화 + 사용자 수준 캘리브레이션 + 아키텍처 인터뷰 | `spec/STATE.md` `spec/FORMAT.md` `spec/ssot/ARCH.md` |
| 1 | `create-ssot` | 기획자 | 기획 인터뷰로 도메인 SSOT 작성 | `spec/ssot/<ID>.md` |
| 수시 | `update-ssot` | 기획자 | 기획 변경 반영 — rev+1, 변경 로그, 파급 표시 | 갱신된 SSOT + STATE pending |
| 2 | `create-task` | 엔지니어 | SSOT 변경분(pending)과 채택된 리뷰 finding을 개발 인터뷰와 함께 태스크로 분해 | `spec/tasks/T###.md` |
| 3 | `implement-task` | 엔지니어 | 태스크 선점(doing) → 구현 → 검증(영향 단위 테스트·typecheck·lint·format. 전체 스위트·CI는 마감 관문) → done | 코드 + 갱신된 태스크/STATE |
| 수시 | `review-code` | 리뷰어 | 코드를 ARCH 컨벤션·개발 관점에서 점검해 우선순위 붙은 리팩토링 finding을 제안, 사용자가 채택 | `spec/review/<slug>.md` |
| 수시 | `doc-review` | 편집자 | 기존 SSOT를 의미 보존 원칙 아래 정리 — 복합 결정 분해, 과거 흔적·중복 제거. 정책이 바뀌어야 하는 문제는 `update-ssot`로 넘김 | 다듬어진 `spec/ssot/*.md` (rev 불변) |
| 제출물 리뷰 | `review-task` | 리뷰어 | 제출 커밋 검토 → 승인 또는 수정 요청 | 커밋·상위 기준에 고정된 리뷰 기록 |
| 병렬 작업 | `manage-work` | 작업 조정자 | 상위 브랜치·태스크 worktree 배정 → 검증·통합 → 정리 | 작업 묶음 + 공유 실행 기록 |
| 필요시 | `create-narrative` | 작가 | spec 전체를 사람이 읽기 좋은 한국어 이야기로 엮음 | `spec/NARRATIVE.md` |
| 세션 끝 | `haeram-report` | 회고자 | 이 세션에서 haeram 스킬·CLI가 어떻게 동작했는지 돌아보고 개선 사항을 근거와 함께 보고(읽기 전용·익명화) | markdown 코드 블록 하나 |

설치된 프로젝트에는 다음 구조가 생깁니다.

```text
spec/
├── STATE.md      # 관제탑: cfg(사용자 수준·push 브랜치) · 실행 중 세션(active) · 결정함(inbox) · SSOT rev 현황 · 태스크 보드 · next · log
├── FORMAT.md     # 모든 spec 문서의 압축 표기 규칙 (ID, 기호, 골격, 상태 규칙)
├── ideation/     # (선택) 활성 아이디어 — open(구체화 중), ready(SSOT 반영 대기·진행 중)
│   └── done/     # 전체 SSOT 반영을 확인한 converted 문서 보존 — STATE에서는 제거
├── ssot/         # 도메인별 SSOT — 결정([o]/[?]/[x])과 근거만, rev로 변경 추적
├── review/       # (선택) 코드/자율 개선 finding — 사용자 채택 또는 명시적 사전 위임 범위의 [o]가 create-task의 재료
├── reports/      # (선택) 맡김 세션 보고서 — 한 일·잠정 결정·주차한 일·검증 결과 (owner가 읽는 사용자 언어)
└── tasks/        # 남은 태스크(todo·doing·blocked)만 — 완료기준·구현메모·결과, base 스탬프로 신선도 검증
    └── done/     # 완료된 태스크 아카이브 — STATE 표는 항상 남은 일만 보여줍니다
```

`tasks/done/`은 **당시의 의도와 실제 구현·검증을 비교할 수 있는 역사 기록**입니다. 평가와 회귀 조사를 위해 보존하지만, 현재 규칙의 근거는 아닙니다(`st`·`base`는 완료 시점의 값입니다). 그래서 일반 구현 작업은 완료 태스크를 기본 입력으로 읽지 않고, 특정 태스크·회귀 원인·이전 검증 방법을 조사할 때만 해당 파일을 골라 엽니다. 지금도 지켜야 하는 계약이 완료 태스크에만 남아 있다면 그건 SSOT로 올라가야 할 신호입니다.

ideation은 `open`(구체화 중) → `ready`(SSOT 반영 대기·진행 중) → `converted`(채택 범위 전체 반영)로 구분합니다. create-ssot·update-ssot는 실제 SSOT와 반영 범위를 대조하고, 모든 채택 도메인에 매핑이 있고 미정·열린 질문이 처리됐을 때만 `ideation/done/`으로 옮기며 STATE 행을 제거합니다. 일부만 반영했으면 `ready`로 유지합니다. 완료 문서는 과거 논의 조사에만 사용하며 현재 규칙은 SSOT에서 읽습니다. 기존 converted 문서도 같은 확인 후 이동하고, 예전 domains의 상태 없는 줄은 채택으로 취급합니다. 프로젝트 FORMAT 이관은 [기존 프로젝트 이관](#기존-프로젝트-이관)을 따릅니다.

SSOT의 `rev`(현재 개정)와 STATE의 `tasked`(태스크로 소화된 개정)의 차이가 곧 "아직 구현 계획에 반영되지 않은 기획 변경"입니다. 그래서 어느 세션에서든 "SSOT 변경사항 태스크로 쪼개줘"라고만 해도 에이전트가 무엇이 어떻게 바뀌었는지 스스로 찾아냅니다.

`spec/` 문서는 영어, 인터뷰·확인·보고는 사용자 언어(`cfg.lang`)입니다. 예외는 사람용 산문 `spec/NARRATIVE.md`(create-narrative, 새 결정 없음)와 맡김 보고서 `spec/reports/`입니다.

## 빠른 시작

### 1. 에이전트에게 설치 요청하기

Claude Code나 Codex를 설치하려는 프로젝트에서 열고 다음 프롬프트를 붙여 넣으세요.

```text
이 프로젝트에 haeram-spec-creator 스킬셋을 설치해줘.
의존성으로 추가하지 말고 npx로 실행해줘.

먼저 `npx -y haeram-spec-creator@latest install --dry-run`으로 설치 계획과 충돌 여부를 확인하고,
기존 스킬과 충돌하면 덮어쓰지 말고 나에게 알려줘.
문제 없으면 `npx -y haeram-spec-creator@latest install`로 설치한 뒤,
`npx -y haeram-spec-creator@latest check`로 스킬 목록과 동기화 상태까지 검증해줘.
```

에이전트가 제시한 변경 계획을 확인한 뒤 실행을 승인하면 됩니다.

### 2. 새 세션 시작하기

설치된 스킬이 발견되도록 Claude Code나 Codex 세션을 다시 시작합니다. 스킬은 요청 내용과 `SKILL.md`의 설명이 일치하면 에이전트가 자동으로 불러오며, 필요할 때 스킬 이름을 직접 지정할 수도 있습니다.

### 3. `/start-vibe`로 시작하기

```text
/start-vibe
/start-vibe 태그 기능 만들자          ← 요청 문장이 있으면 STATE보다 먼저 해석합니다
/start-vibe 맡김                     ← 인자로 답한 질문은 묻지 않습니다 (헤드리스 실행·오케스트레이터용)
```

1. 원격을 가져와 다른 기기에서 진행 중인 세션(STATE `## active`, `wip/<tag>` 스냅샷)을 확인합니다.
2. **질문은 한 번에** 합니다: 모드(함께/맡김), 기획 거리와 구현 거리가 둘 다 있으면 무엇부터, 다른 기기가 진행 중이면 이어받을지. push 대상은 묻지 않습니다(기본은 커밋만).
3. 맡김이면 사용자가 떠나기 전에 점검합니다(`vibe preflight`: 디자인 중 여부·작업 트리·lint·검증 명령·절전 방지, cfg push가 있으면 push 권한·CI 접근, 작업 묶음이면 헤드리스 워커의 명령 실행 권한 실측). 정할 것이 있으면 이때 한 번 더 묻고, 그 뒤로는 묻지 않습니다.
4. STATE를 보고 다음 일을 고릅니다 — 아무것도 없으면 `/ideation`으로 안내, 전환 안 된 아이디어가 있으면 기획(create-ssot → create-task), 태스크·변경분이 있으면 구현(implement-task). 함께는 이 대화에서 태스크를 하나씩 진행합니다. 맡김은 이 대화가 직접 반복하지 않고 [`vibe loop`](#오래-맡기기--vibe-loop)가 단위마다 새 세션을 띄웁니다. 독립 줄기가 충분히 클 때만 작업 묶음으로 병렬 처리합니다.
5. 태스크마다 커밋합니다. 보고서는 태스크 3개(기본)·기획 조각 소진·세션 끝에 갱신하고, 전체 검증과 push는 세션 끝에 한 번입니다([검증과 push](#검증과-push)). cfg push 브랜치가 있고 다른 세션이 보이면 선점 정보 공유와 원격 판정을 먼저 합니다. 1시간 넘는 작업은 `wip/<tag>`로 스냅샷합니다(원격에는 cfg push 브랜치가 있을 때만 올라갑니다).

| 모드 | 결정 | 사용자가 없을 때 |
| --- | --- | --- |
| 함께 | 결정 지점마다 선택지를 모아서 묻습니다 | — |
| 맡김 | 추천안으로 진행하고 결정함·보고서에 남깁니다 | 기다리지 않습니다. 과금·데이터 삭제·개인정보·보안 정책, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일(force push, 브랜치 삭제, 배포·게시 등)만 주차하고 다른 일을 계속합니다 |

"나 나갈게"라고 하면 맡김으로, 돌아와 말을 걸거나 `/start-vibe`를 다시 실행하면 결정함부터 보여 주는 함께로 바뀝니다. 결정함에서 승인하면 그 줄이 지워지고, 고치면 update-ssot로 확정합니다. SSOT에는 잠정 결정도 일반 결정으로만 들어가며, 잠정이라는 사실은 결정함이 결정 ID로 가리킵니다.

보정·튜닝·밸런스처럼 돌려 보고 정하는 일은 **explore 태스크**(`explore:2h` + `exit:` 완료 조건)로 만들어 메인 세션에서 시간 제한 안에 끝냅니다 — 기준을 못 맞추면 측정값을 기록하고 마감합니다.

SSOT·계약·저장 형식·결정이 바뀌지 않는 작은 버그/문구/스타일(3파일·추가+삭제 100줄 이하)은 태스크 파일 없이 영향 검사·커밋 하나·STATE fix log로 처리합니다. 조건이 깨지면 정식 기획/태스크로 전환합니다.

### 아이디어는 `/ideation`

```text
/ideation 작업 기록에서 기간별 비교를 할 수 있으면 좋겠다
```

생각날 때마다 아이디어를 받아 적습니다. 더 이야기하고 싶으면 발산·수렴 루프를 돌고, 쌓인 문서는 `/start-vibe`가 기획으로 가져갑니다.

### 디자인은 `/start-design`

```text
/start-design 랜딩 페이지 히어로 영역
```

화면을 띄워 두고 말하는 대로 바로 코드만 고치는 함께 모드 전용 흐름입니다.

1. `vibe design start`로 이 checkout이 디자인 중임을 표시합니다. 이 상태는 checkout의 Git 디렉터리에만 저장되고 STATE에는 쓰지 않으므로, 기획 커밋·plan-push를 타고 다른 worktree로 퍼지지 않습니다. 개발 서버(hot reload)를 띄워 두고 결과를 실시간으로 봅니다.
2. 디자인하는 동안에는 테스트·e2e·typecheck·커밋·push를 하지 않습니다. 그 checkout에서는 `vibe push`가 거절되고, 맡김 preflight는 실패하며 `vibe loop`는 멈춥니다. 다른 worktree의 작업은 영향을 받지 않습니다. 중간 저장이 필요하면 `vibe checkpoint`로 `wip/<tag>`에만 스냅샷합니다.
3. 커밋·push가 필요해지면(직접 요청, 다른 스킬로 전환, 마감) 어떤 스킬이든 먼저 **"디자인 끝났나요?"** 를 묻습니다.
4. 디자인이 끝나면 `vibe design verify`로 ARCH의 task·batch 명령 전부를 미커밋 작업 트리에서 한 번씩 돌립니다(빠른 검사가 실패하면 무거운 검사는 미룸, 같은 트리는 캐시). 디자인 때문에 바뀐 기대값은 테스트를 고치고, 깨진 기능은 코드를 고칩니다. 통과하면 `vibe design end` 후 디자인·테스트 수정·STATE log(`- YYMMDD design <area>: <what>`)를 커밋 하나로 남깁니다. push는 요청했거나 cfg push가 브랜치일 때만 합니다.

### 스킬을 직접 부르기

원하는 결과를 설명하거나 스킬 이름을 대면 그 스킬을 씁니다. 모드를 정하지 않았으면 함께 모드입니다.

```text
새 프로젝트야. spec을 초기화하고 아키텍처부터 잡아줘.   → create-architecture
```

```text
사용자가 저장한 글을 태그로 분류하는 기능을 기획하고 싶어.  → create-ssot
```

```text
무료 플랜에도 태그 기능 열어주는 걸로 기획 바꾸자.        → update-ssot
```

```text
SSOT 변경사항 태스크로 쪼개줘.                        → create-task
```

```text
다음 태스크 구현해줘.                                → implement-task
```

```text
리팩토링할 데 있는지 코드 점검해줘.                   → review-code
```

```text
THEME SSOT가 너무 길어. 의미 바꾸지 말고 정리해줘.      → doc-review
```

```text
/haeram-report                                     → haeram-report
```

haeram 스킬을 쓴 세션 끝에 부르면, 그 세션에서 스킬·CLI가 어떻게 동작했는지 돌아보고 개선 사항(오류·모호한 지시·토큰/시간 낭비·사람이 판단 아닌 일에 쓴 시간)을 근거와 함께 markdown 코드 블록 하나로 돌려줍니다. 파일은 바꾸지 않고, 대상 프로젝트 이름·도메인·ID는 익명화하므로 그대로 이 저장소의 이슈로 옮길 수 있습니다.

## PR 없이 현재 브랜치에서 개선하기

`/self-improve-local`을 실행한 세션이 오케스트레이터가 됩니다. 하위 세션이 먼저 근거·수정 범위·비용·위험을 제안하고, 오케스트레이터가 승인한 작업만 다른 worktree에서 구현합니다. 별도 세션의 코드 리뷰와 단위 검사를 통과한 변경은 호출한 현재 브랜치에 통합하고, 마지막 전체 관문까지 통과해야 완료로 보고합니다. 제안 승인과 코드 리뷰 승인은 별개입니다.

```text
/self-improve-local
성능·테스트 비용·반복 작업의 문제를 하위 세션이 찾아 제안하게 해줘.
네가 검토해 동작을 보존하는 작은 개선만 승인하고 현재 브랜치에 통합해줘.
큰 변화는 근거와 대안을 보고하고, 원격 push는 하지 마.
```

PR이나 GitHub CLI가 없어도 로컬 구현·리뷰·통합을 할 수 있습니다. 하위 세션은 에이전트의 하위 세션 도구로, 없거나 맡김이면 헤드리스 `work scout`(읽기 전용 탐색, 제안 JSON만 반환)·`work run`(구현·리뷰)으로 띄웁니다. 오케스트레이터는 코드를 직접 훑지 않습니다. 기존 작업 묶음의 `--workspace current --tasks '<approved IDs>' --review all --push -`를 사용해 승인 범위 밖 todo를 소비하지 않으며, 그 todo가 남아 있어도 승인 범위를 마칠 수 있습니다. 실행 도구가 없으면 하위 세션을 가장하지 않고 제안 패킷과 필요한 연결을 보고합니다.

기본은 현재 브랜치의 로컬 커밋까지입니다. 원격 코드 반영은 별도 요청 또는 사용자가 지정한 cfg push가 있을 때 조정자가 최종 검증 후 한 번 수행합니다. 기획 문서의 cfg plan 정책은 유지합니다. 실제 origin/main이 갱신됐는지와 로컬에만 반영됐는지를 구분해 보고합니다. [실행 절차](skills/self-improve-local/SKILL.md)에 역할·승인·통합 경계가 있습니다.

## 지시 없이 문제를 찾는 지속 개선

`/self-improve`는 느린 엔진·과도한 테스트 비용·반복 실패·재작업을 기록과 코드에서 찾아 개선합니다. 먼저 한 번 범위와 예산을 위임하면, 그 안의 동작 보존 개선은 후보마다 다시 묻지 않고 측정·태스크·구현·별도 세션 검토·PR 작성으로 이어집니다. 일반 `review-code`는 사용자가 제안을 채택하는 기존 흐름을 유지합니다.

```text
/self-improve 지속 개선 켜줘. 내가 따로 시키지 않아도 실행 기록과 코드를 보고
성능·테스트 비용·반복 작업의 문제를 찾아줘. 동작을 보존하는 작은 개선은
별도 세션에서 검토하고 개선 브랜치의 PR로 만들어줘.
정확도·결과 의미·공개 계약·검증 범위를 바꾸는 큰 변화는 근거와 대안을 갖춰 보고해줘.
```

정책은 대상 프로젝트의 ARCH 결정에, 자동 진입 조건은 그 프로젝트의 에이전트 지침에 연결합니다. 기본은 24시간마다 문제 하나, 사이클 60분·하루 누적 120분·단일 명령 15분이며 사용자가 준 예산이 우선합니다. 테스트 개수를 줄이는 것이 목표가 아니고, 정확도·샘플을 줄여 얻은 속도는 동작 보존 개선으로 치지 않습니다. 기본 종료점은 PR이고 자동 merge는 별도 사전 위임과 모든 보호 규칙·필수 관문을 충족할 때만입니다. 측정·실험 규칙은 [운영 정책](skills/self-improve/references/operation.md)과 [실험 도구](skills/self-improve/references/experiments.md)에 있습니다.

**스킬 설치만으로 백그라운드 실행이 생기지는 않습니다.** 활성화 후 일반 조정자 세션에서 사용자 작업이 끝나거나 유휴 상태일 때 기한을 확인해 한 사이클을 실행합니다. 세션이 없어도 계속 돌리려면 실제 스케줄러/CI/에이전트 실행기를 연결해야 합니다. 스킬은 연결 가능 여부를 확인하고, 연결하지 못했으면 미연결이라고 보고합니다. 내장 `vibe loop`는 기존 태스크가 소진되면 끝나며 개선 스케줄러로 바뀌지 않습니다. 독립 검토자·권한·예산이 없으면 검토 패킷/초안을 남기고 완료로 가장하지 않습니다.

기존 프로젝트의 FORMAT 이관은 [기존 프로젝트 이관](#기존-프로젝트-이관)을 따릅니다.

## 검증과 push

- **태스크마다**: 변경 영향 단위 테스트와 빠른 검사(typecheck·lint·format)만 돌립니다. 테스트는 스크립트 이름이 아니라 격리 범위·의존성으로 분류하고, 실행하지 않은 통합/e2e는 result limits에 남겨 마감 관문에 넘깁니다. `vibe check --tier task`는 ARCH batch 단계에만 있는 명령(전체 스위트)을 거절하고, 5분 넘는 태스크 검사에는 `slow`·`hint`를 붙입니다(사용자가 별도 실행을 명시하면 `--allow-final`).
- **마감 관문**: 통합·e2e·전체 스위트는 조정자/loop 호스트 하나가 최종 후보에서 한 번 실행합니다(단독 `vibe check --tier batch`, 묶음 `--group-verify`). 같은 트리·같은 명령의 통과는 재사용하고, 무거운 검사는 clone 공용 락으로 하나씩 돌립니다. 구현·리뷰 세션은 세션이 끝났다고 브라우저·전체 검사를 띄우지 않습니다. 검증 없는 코드 push는 중단합니다.
- **push**: 기본은 커밋만(cfg `push: -`). cfg push에 브랜치가 있으면 검증한 SHA로 한 번 push하고(`vibe push --verified-commit <SHA>` — 그 뒤 코드가 바뀌면 거절) CI를 한 번 기다립니다(`vibe ci wait`: gh → 토큰 API → 공개 페이지 순, 기본 no-run 유예 2분·제한 1시간, 대기 중 모델 호출 없음). 단위별 push는 사용자가 명시할 때만입니다(`vibe loop --push-each-unit`, 묶음 `--push`).
- 단계는 ARCH의 task/batch/CI 하위 줄이 정합니다. 단계가 없는 legacy ARCH는 package.json의 verify/test 스크립트를 batch로 보거나 `--verify '<command>'`를 씁니다. 세부 절차는 [조정자 검증 절차](skills/start-vibe/references/verification.md)에 있습니다.

```bash
npx haeram-spec-creator vibe check --tier task --diff-base <task-start-sha> -- pnpm run typecheck
npx haeram-spec-creator vibe check --tier batch --diff-base <batch-start-sha> -- pnpm run test
npx haeram-spec-creator vibe push --verified-commit <SHA> --wait-ci --diff-base <batch-start-sha>
```

## 오래 맡기기 — `vibe loop`

```bash
npx haeram-spec-creator vibe loop --tag k3f9 --provider claude --dry-run --json
npx haeram-spec-creator vibe loop --tag k3f9 --provider codex --max-units 30 --max-hours 8 --detach --json
# 실행 중 변경: 현재 단위를 끝낸 같은 호스트가 적용합니다. pending은 적용 완료가 아닙니다.
npx haeram-spec-creator vibe loop --tag k3f9 --configure --push-each-unit --wait-ms 30000 --json
npx haeram-spec-creator vibe loop --tag k3f9 --status --json
# 현재 단위와 마감 검증을 끝낸 뒤 정지
npx haeram-spec-creator vibe loop --tag k3f9 --stop-after-unit --json
# 즉시 취소(실행 중 단위도 종료, 새 마감 검증·push 없음)
npx haeram-spec-creator vibe loop --tag k3f9 --stop --json
```

반복기는 preflight·active·보고서를 한 번 준비한 뒤 태스크 하나, 기획 한 조각(SSOT+create-task), inbox 정리마다 새 세션을 시작합니다. 시간 한도의 마지막 구간은 **마감 관문 전용**입니다 — 그 구간에 들어서면 새 단위를 시작하지 않고(`reason: final-window`, 실행 중이던 단위는 마칩니다) 모은 코드 전체를 한 번 검증한 뒤 push·CI까지 진행합니다. 관문이 실패하면 근거를 담은 수정 태스크를 만들어 그 구간 안에서 한 번 고치고 다시 검증합니다(두 번째 실패는 push 없이 보고). 구간 길이는 실측입니다: `vibe check --tier batch`·`work finish`·`vibe design verify`가 기록한 전체 검증 시간×2 + 최근 단위 시간 + (push 브랜치가 있으면) CI 대기 시간. 아직 한 번도 측정되지 않았을 때만 max-hours의 20%를 쓰고, 측정은 단위 경계마다 다시 읽습니다. `--final-reserve-hours`로 직접 정할 수 있습니다.

어디서 시간이 갔는지도 남깁니다. 단위마다 걸린 시간·그 안의 `vibe check` 시간·토큰 수를 기록하고, `loop.json`·결과 JSON의 `time`과 마감 보고서 checks의 한 줄(`- time: 5h00m — implementation 2h30m/2 (model 2h00m, task checks 30m), planning 40m/1, gate 30m, CI 6m, host 9m; slowest T### 1h30m`)로 구현·기획·태스크 검사·마감 관문·CI·호스트 몫을 나눠 보여 줍니다. 다음 속도 개선은 이 숫자에서 고릅니다(`vibe check`를 거치지 않은 명령은 모델 시간에 포함됩니다).

`.git/haeram/v1/loops/<tag>/loop.json`에 상태·로그·세션 ID·정지 파일 경로를 남깁니다. `--detach`는 부모 터미널과 분리하고 macOS에서는 caffeinate를 사용합니다. STOP 표식은 재시작 전에 직접 지웁니다. headless 세션은 프로젝트 설정을 사용할 수 있는 메인 checkout에서 권한을 실측하며 기본은 Claude acceptEdits+허용 목록, Codex workspace-write입니다. 필요한 명령은 `--allow-tool 'Bash(pnpm *)'`처럼 추가합니다. 사용자가 명시한 `--permission-mode bypass`만 권한 우회를 켭니다.

실행 중에는 `--status`로 heartbeat·요청/적용 설정·운영 오류를 보고, `--configure --push-each-unit|--no-push-each-unit`로 단위별 push를 바꿉니다 — 현재 단위가 끝난 뒤 같은 호스트에 적용되며 receipt의 `status:applied`로 확인합니다(pending은 적용 전). cfg push가 `-`이면 이 옵션도 원격 게시를 켜지 않습니다. `--stop`·SIGINT·SIGTERM은 즉시 취소라 새 마감 검증·push를 시작하지 않고, `--stop-after-unit`은 현재 단위와 마감 관문까지 마친 뒤 멈춥니다. 호스트는 자기가 쓴 보고서와 자기 active 행만 정리하고, 그 밖의 변경이 남으면 보존한 채 다음 단위와 게시를 멈춥니다. 종료된 호스트는 `--recover-metadata`로 정리합니다(모델·push·재시작 없음). 독립 감시자·실패 알림(`--notify-command`)·복구 계약은 [loop 제어 계약](skills/start-vibe/references/loop-control.md)에 있습니다.

맡김의 결정·주차 규칙은 위 [모드 표](#3-start-vibe로-시작하기)와 같습니다. 구현이 판단 문제로 막히면 기획 한 조각으로 해소해 재개하고, CI 실패는 근거를 담은 수정 태스크로 만들어 다음 단위로 먼저 실행합니다. 시간·단위·반복 실패 한도에 닿으면 `loop.json`과 보고서에 우선 재개할 태스크를 남깁니다.

## 결정 브리핑 — `vibe brief`

구현 세션은 SSOT 문서·STATE·FORMAT을 통째로 읽는 대신 **그 태스크가 기대는 결정 블록**을 한 번에 받습니다. 단독은 `vibe brief`, 작업 묶음 워커는 `work brief`(실행기가 자동 전달), `vibe loop`의 단위가 같은 조립기를 씁니다.

```bash
npx haeram-spec-creator vibe brief T201                 # 작업 트리 기준(미커밋 포함), 마크다운
npx haeram-spec-creator vibe brief T201 --ref HEAD      # 그 커밋만 기준
npx haeram-spec-creator vibe brief AUTH-4               # 결정 하나 + 필수 의존 + 이 결정을 가리키는 곳(referrers)
npx haeram-spec-creator vibe brief AUTH@3               # r3 이후 chg 줄과 바뀐 결정 (create-task 델타)
npx haeram-spec-creator vibe brief T201 --deep --json   # 미분류 참조까지 끝까지, JSON
```

브리핑에는 태스크 본문, 인용 도메인의 현재 결정 원문 블록(cfg `brief: domain`, 기본) 또는 인용 결정만(`brief: cited`), 필수(`→!`)·정본(`→=`) 참조를 끝까지, 인용 결정을 가리키는 결정, 전역 규칙(cfg `always`, 없으면 ARCH 전체), 관련 도메인의 flow·constraints, 뒤처진 base 이후 chg, 관련 결정함 줄이 들어갑니다. 빠진 것은 `## not included`, 문제는 `## issues`(complete:no, 종료 코드 1)에 남고 크기 때문에 잘라내지 않습니다 — 마지막 `end … chars:N` 줄이 없으면 출력이 잘린 것입니다. 참조 표기(`→!`·`→=`·`→~`·`→`)는 [FORMAT](skills/create-architecture/assets/FORMAT.md) Notation에 있고, 기존 `→`는 추측으로 분류하지 않고 결정을 고칠 때 하나씩 표시합니다.

**범위와 전역 규칙** (STATE cfg): `- brief: domain|cited`, `- always: ARCH-1 ARCH-4 SEC`(결정 ID나 도메인, `-`는 없음). 둘 다 없으면 `domain`·ARCH 전체입니다. `cited`는 훨씬 작지만 **태스크가 지켜야 할 결정을 빠짐없이 인용할 때만** 안전합니다 — 기존 태스크가 그렇지 않다면 `domain`으로 두세요. 측정과 한계는 [0.7.0 보고](docs/0.7.0.md)에 있습니다.

## 기존 프로젝트 이관

1. `npx haeram-spec-creator@latest install --dry-run` → `install` → `check`. 설치는 `.claude/skills`·`.codex/skills`만 바꾸고, 로컬에서 고친 스킬 파일은 충돌로 보고하며 `--force` 없이 덮어쓰지 않습니다. `spec/`은 건드리지 않습니다.
2. `lint`로 기존 문서를 검사합니다. 새 검사는 기존 문서를 오류로 만들지 않고 경고·검토 후보로 알립니다.
3. `spec/FORMAT.md`·`STATE.md`는 자동 이관되지 않습니다. 설치된 `.claude/skills/create-architecture/assets/FORMAT.md`와 비교해 새 표기·골격·State rules·Reading·Autonomous improvement 줄만 옮기고 프로젝트가 고친 규칙은 그대로 둡니다. 옮기기 전까지 스킬은 프로젝트 FORMAT에 없는 표기(예: `→!`·`→=`·`→~`)를 쓰지 않습니다. 새 cfg 키·STATE 섹션은 필요하지 않습니다(cfg `brief`·`always`는 선택).
4. 버전별 이관 항목은 [CHANGELOG](CHANGELOG.md)에 있습니다.

## 직접 설치하기

### 기본: npx (권장 — Node 프로젝트가 아니어도 됩니다)

이 패키지는 스킬을 프로젝트의 `.claude/`·`.codex/`로 복사하는 방식이라, 설치가 끝나면 패키지 자체는 프로젝트에 남을 필요가 없습니다. `package.json` 없이도(Python, Flutter, Go …) 동작하고 `node_modules`도 만들지 않습니다.

```bash
cd my-project
npx haeram-spec-creator@latest install   # 최초 설치와 이후 업데이트 모두 이 명령
npx haeram-spec-creator@latest check     # 동기화 확인
```

`@latest`가 실행 때마다 최신 버전을 확인하므로 업데이트도 같은 명령을 다시 실행하면 됩니다. 직접 수정하지 않은 스킬 파일만 새 버전으로 갱신되고, 수정한 파일은 충돌로 알려 줍니다.

### 옵션: 개발 의존성으로 버전 고정

CI에서 `lint`를 돌리거나 스킬셋 버전 변경을 PR 리뷰로 관리하고 싶은 Node 프로젝트라면 의존성으로 고정할 수 있습니다.

```bash
npm install --save-dev haeram-spec-creator   # pnpm add --save-dev haeram-spec-creator
npx haeram-spec-creator install
```

기본 설치 대상은 현재 프로젝트의 Claude Code와 Codex입니다.

```text
<project>/
├── .claude/skills/<skill-name>/...
├── .codex/skills/<skill-name>/...
└── .haeram-spec-creator-lock.json
```

잠금 파일에는 이 패키지가 설치한 파일과 해시만 기록합니다. 다른 스킬 폴더는 건드리지 않으며, 프로젝트에서 직접 수정한 파일과 충돌하면 설치를 중단합니다.

<details>
<summary>CLI 명령 보기</summary>

```bash
# 포함된 스킬 확인
npx haeram-spec-creator list

# Claude Code와 Codex 양쪽에 설치
npx haeram-spec-creator install

# 한 에이전트에만 설치
npx haeram-spec-creator install --agent claude
npx haeram-spec-creator install --agent codex

# 다른 프로젝트를 대상으로 설치
npx haeram-spec-creator install --target ../my-project

# 파일을 바꾸지 않고 설치 계획 확인
npx haeram-spec-creator install --dry-run

# 설치본이 현재 패키지와 같은지 확인
npx haeram-spec-creator check

# spec/ 문서가 FORMAT 불변식을 지키는지 검사 (ID·상태 형식, rev/tasked 정합, 참조 무결성, chg 연속성, SSOT 골격 밖 섹션·산문)
npx haeram-spec-creator lint
npx haeram-spec-creator lint --target ../my-project

# 의미 품질 신호(검토 후보)까지 전부 보기 — 기본은 앞 10건만 출력하고 종료 코드에는 영향이 없습니다
npx haeram-spec-creator lint --hints

# 현재 Git/worktree 환경 조회 (외부 도구 연동용 JSON도 지원)
npx haeram-spec-creator context --json

# 현재 checkout의 태스크 파일에서 읽기 전용 보드 파생
npx haeram-spec-creator board
npx haeram-spec-creator board --target ../my-worktree --json

# 충돌한 로컬 파일을 패키지 버전으로 명시적으로 교체
npx haeram-spec-creator install --force

# start-vibe 세션 도구
npx haeram-spec-creator vibe status --tag k3f9        # 다른 기기의 세션·남은 일·추천 경로
npx haeram-spec-creator vibe brief T012                # 태스크가 기대는 결정 블록·전역 규칙·flow·constraints·stale base 이후 chg
npx haeram-spec-creator vibe plan-sync                # 기획 브랜치(cfg plan, 기본 main)의 최신을 합침 — 기획·채번 전
npx haeram-spec-creator vibe plan-push                # spec/만 담은 기획 커밋을 기획 브랜치에 올림 (태스크 ID 충돌이면 거절)
npx haeram-spec-creator vibe push                     # 원격을 합치고(STATE는 섹션 단위) cfg push 브랜치로 push
npx haeram-spec-creator vibe claim --tag a1b2 --task T001 # 선점 정보만 공유하고 미검증 로컬 코드는 남김
npx haeram-spec-creator vibe checkpoint --tag k3f9    # 작업 트리 스냅샷을 wip/k3f9로 (현재 브랜치는 그대로)
npx haeram-spec-creator vibe design start --tag d7 --scope "landing hero"  # 이 checkout만 디자인 중으로 (STATE·다른 worktree는 그대로)
npx haeram-spec-creator vibe design verify            # 디자인 마감: ARCH task·batch 명령 전부를 미커밋 트리에서
npx haeram-spec-creator vibe design end               # 디자인 중 표시 해제 — 이어서 커밋 하나
npx haeram-spec-creator vibe check --tier batch -- pnpm run test:e2e   # 같은 트리에서 통과한 검사는 생략, 무거운 검사는 하나씩
npx haeram-spec-creator vibe preflight --probe 'pnpm run test' --allow-tool 'Bash(pnpm run *)'
```

`--force`는 로컬 수정 내용을 덮어쓸 수 있으므로 충돌 내용을 확인한 뒤 사용하세요.

</details>

## 혼자 여러 AI 작업 진행하기

특정 실행기는 필요 없습니다. 일반 터미널에서 Git worktree를 직접 만들거나, Orca 등 외부 도구가 만든 공간을 그대로 사용할 수 있습니다. 작은 단독 작업은 기존 스킬 흐름을 유지하고, 여러 태스크를 묶어 진행할 때 `manage-work`를 사용합니다.

```text
로그인 개편을 작업 묶음으로 시작하고, 독립적인 태스크는 worktree로 나눠 진행해줘.
완료된 결과는 작업 묶음 브랜치에 검증해서 통합해줘.
```

에이전트는 기본 `auto`로 작업 공간을 선택합니다. 매번 모드를 고를 필요는 없습니다.

| workspace 옵션 | 동작 |
|---|---|
| `auto` (기본) | start는 기존 linked worktree를 기획 공간으로 연결하거나 새 기획 공간을 생성합니다. claim은 미배정 linked worktree를 연결하거나 새 worker 공간을 생성합니다. |
| `current` | 현재 checkout과 브랜치를 사용합니다. 기획 공간을 워커와 공유하는 배정은 거부합니다. |
| `new` | 별도 브랜치와 worktree를 생성합니다. |

새 작업 공간은 기본적으로 저장소 옆 `.haeram-worktrees/` 아래에 생성합니다. `--path`로 바꿀 수 있습니다. 이름·분기 기준을 지정하려면 start에 `--branch`·`--base`를 사용합니다. 자동 생성이 실패하면 경로와 원인을 보고하며 현재 checkout을 전환하거나 같은 폴더에서 병렬 쓰기를 시작하지 않습니다. Git이 없으면 기존 단독 흐름을 사용합니다.

다음은 CLI로 직접 진행하는 예입니다. `login`, `T042`, 경로, 검증 명령은 프로젝트에 맞게 바꿉니다. 시작 전 계획을 커밋하고, 생성 후 반환된 경로에서 작업합니다.

```bash
# 상위 작업 브랜치와 기획 공간 생성/연결
npx haeram-spec-creator work start login --json

# 어디서 실행해도 상위 브랜치 기준의 진행 상황 조회
npx haeram-spec-creator work board --work login --json

# 독립 태스크마다 실행: 반환된 workspace와 id를 해당 작업자에게 전달
npx haeram-spec-creator work claim T042 --work login --owner agent-a --json

# 워커는 코드와 자기 태스크의 acceptance/result를 작성하고 커밋
# 실제 실행 ID를 변수에 넣은 뒤 검증·제출 (예: npm 프로젝트)
ATTEMPT_ID='claim이 반환한 id'
# --verify는 선택: 이 태스크의 영향 단위 테스트만 (최종 통합/e2e는 조정자 finish 관문)
npx haeram-spec-creator work submit --attempt "$ATTEMPT_ID" --verify 'npx vitest run src/login' --json

# 리뷰어가 고정된 제출물을 선점하고 review-task로 검토
npx haeram-spec-creator work review-claim --work login --attempt "$ATTEMPT_ID" --owner reviewer --json
REVIEW_ID='review-claim이 반환한 id'
# 실제 리뷰 결과를 저장소 밖 JSON 파일에 작성한 뒤 기록
npx haeram-spec-creator work review-finish --review "$REVIEW_ID" --result-file /tmp/review-result.json --json

# 승인된 변경을 별도 후보에서 재검증하고 상위 브랜치에 반영
# 후보 worktree에는 의존성이 없으므로 필요한 설치도 명시
npx haeram-spec-creator work integrate --attempt "$ATTEMPT_ID" --verify 'npm ci && npm run lint' --json

# 모든 단위가 통합되면 묶음 전체 검증을 한 번 실행하고 검증 커밋을 기록
npx haeram-spec-creator work finish --work login --verify 'npm ci && npm run ci' --json

# 작업자가 종료한 뒤 공간 정리
npx haeram-spec-creator work cleanup --attempt "$ATTEMPT_ID" --json
```

상태 흐름은 `doing → ready → reviewing → approved → integrated`입니다. 수정 요청은 `changes_requested → doing → ready`로 재검증·재리뷰합니다. `ready`는 워커 검증을 마친 리뷰 대기 상태이고, `integrated`가 되어야 태스크 파일이 `done/`으로 이동하고 후속 의존성이 열립니다.

`work start`(또는 `work configure`)에 `--push main`처럼 push 브랜치를 주면 **통합된 단위마다 그 브랜치로 바로 반영하고 push합니다** — 원격이 앞서 있으면 후보에서 먼저 합친 뒤 단위 검증을 돌립니다. 막힌 단위 하나가 끝난 단위들을 붙잡지 않고, 진행이 원격에 바로 보입니다. `--push`가 없으면 CLI는 로컬 작업 브랜치까지만 통합하고 main 반영·PR·push는 프로젝트의 기존 흐름을 따릅니다.

리뷰는 기본적으로 위험한 단위만 받습니다(`--review risky`). 변경 300줄 초과(`--review-lines`), touches 밖 변경이나 touches 미선언, `--review-path`로 지정한 계약 경로 변경, 테스트 파일 변경 없음, 수정 요청·통합 실패 이력, 맡김에서 내린 잠정 결정이 걸린 태스크 — 하나라도 해당하면 리뷰, 아니면 정책 승인 후 통합 검증만 합니다. 전부 리뷰하려면 `--review all`. 수정 후 재제출은 고친 커밋부터의 변경만 태스크 단계에 넘깁니다. explore 태스크와 그 후속은 묶음에 배정하지 않습니다.

진행 중 기록과 상태 변화 이력은 `<git-common-dir>/haeram/v1/state.json`에 저장됩니다. 같은 clone의 worktree들이 공유하고 runtime 자체는 Git에 커밋하지 않습니다. 태스크 통합과 실행기 종료 시 `spec/work/<묶음>.json` 상세 기록 및 `STATE.md`의 작업 묶음 요약을 Git에 저장합니다. CLI는 원자적 예약으로 동일 태스크 및 동일 작업 공간의 이중 배정을 막습니다. 워커는 STATE·SSOT를 바꾸지 않으며, 기획 변경·채번은 하나의 기획 공간에서 진행합니다.

검증 명령은 사용자가 지정한 `--verify`를 셸에서 순서대로 실행합니다(여러 번 지정 가능, 명령별 기본 1시간 제한, `--verify-timeout-ms`로 변경). ARCH에 정의된 실제 검사와 필요한 환경 준비를 넣어야 합니다. 워커 HEAD가 변경되거나 검사가 미커밋 변경을 만들면 제출이 실패합니다. 통합은 별도 후보에서 수행하며, 충돌·검증 실패·상위 브랜치 이동이 있으면 후보를 보존합니다. 검증은 지정한 명령의 성공을 보장하며, 어떤 테스트가 충분한지는 프로젝트의 acceptance/ARCH가 정합니다.

중단·정리 명령도 제공합니다.

```bash
npx haeram-spec-creator work status --json
npx haeram-spec-creator work update --attempt "$ATTEMPT_ID" --status blocked --reason 'API contract needs a planning decision'
npx haeram-spec-creator work update --attempt "$ATTEMPT_ID" --status doing
npx haeram-spec-creator work release --attempt "$ATTEMPT_ID" --reason 'worker stopped'
npx haeram-spec-creator work recover --attempt "$ATTEMPT_ID"
npx haeram-spec-creator work recover --work login
npx haeram-spec-creator work --help
```

`release` 전에 기존 작업자를 종료해야 하며 heartbeat가 오래됐다는 이유만으로 선점을 빼앗지 않습니다. `recover`는 중단된 검증·통합·정리를 조정하고, `cleanup`은 미커밋·미추적 파일이 남은 공간을 보존합니다. 락 회수·외부 worktree·실패 후보 처리는 [작업 묶음 절차](skills/manage-work/references/workflow.md)에 있습니다.

`context --json`은 Git/worktree와 현재 작업 모드를 보여 줍니다. 일반 `board`는 현재 checkout의 파일만 읽는 조회 명령이고, `work board`가 작업 묶음의 기준 커밋과 공유 실행 기록을 함께 보여 줍니다. 보드의 claimable은 조회 시점의 후보이며 선점 자체는 claim이 수행합니다. JSON의 `schemaVersion`은 1입니다.

작업 묶음의 원자적 선점은 같은 로컬 clone 안에서 동작합니다. 다른 기기(clone)와의 중복은 cfg push 브랜치가 있으면 `/start-vibe`가 막습니다 — 세션은 STATE `## active` 행과 doing tag를 먼저 push해 선점하고, 다른 기기는 시작할 때 그 행과 `wip/<tag>` 스냅샷으로 진행 중인 일을 알아챕니다. fan-out 경쟁 구현은 포함하지 않습니다. 자동 실행은 아래의 기본 실행기 또는 command 어댑터로 연결합니다. 기획 공간의 수동 Git 작업은 CLI 예약을 따르지 않으므로 통합 중 같은 checkout에서 다른 변경을 실행하지 않아야 합니다. 기존 프로젝트의 `spec/FORMAT.md`·`STATE.md`는 install로 자동 이관되지 않으며, 작업 묶음은 기존 task 골격을 이용하는 선택 기능입니다. 다른 clone에도 Git에 저장된 태스크·실행 이력 체크포인트가 남지만 현재 프로세스·선점 소유권과 명령 출력 로그는 전파되지 않습니다.

### 줄기(lane)로 나누고 단계별로 검증하기

병렬 묶음은 **기반 → 줄기 → 통합**으로 분해합니다. 여러 줄기가 함께 쓰는 공통 계약을 기반 태스크로 먼저 만들고, 독립적인 흐름은 태스크 인용줄에 `lane:<이름>`을 붙여 줄기로 묶고, 줄기 결과를 잇는 태스크는 lane 없이 각 줄기에 dep을 겁니다.

```text
T001 (기반) → lane:a [T002 → T003 → T004]
            → lane:b [T005 → T006 → T007]  → T011 (통합)
            → lane:c [T008 → T009 → T010]
```

- 줄기 하나가 배정·리뷰·통합의 단위입니다. 한 작업자가 한 worktree에서 줄기의 태스크를 순서대로 구현하며, 줄기 안의 dep은 통합을 기다리지 않습니다. 줄기의 마지막 태스크까지 구현한 뒤 `submit`을 한 번 하면 완료된 태스크 전부가 기록되고 리뷰 대기(`ready`)가 됩니다. 태스크마다 제출해도 되며, 그때는 같은 공간에 다음 `taskId`를 돌려줍니다.
- 줄기는 바깥 dep이 모두 통합된 뒤에만 시작하므로 줄기 도중에 다른 줄기를 기다리며 멈추지 않습니다. 두 줄기가 서로의 태스크를 기다리면(T009(c)→T005(b), T006(b)→T009(c)) `lint`와 `work board`가 `lane 순환` 오류를 내고 배정을 거부합니다. 공통 선행은 기반으로, 소비 태스크는 통합 단계로 옮기거나 줄기를 합칩니다.
- 검증은 세 단계입니다. **태스크**: 그 태스크가 추가·수정·영향을 준 테스트만 실행합니다. **단위**: 줄기마다 통합할 때 빠른 검사만 실행합니다. **묶음**: 모든 통합 뒤 최종 검증을 한 번 실행합니다. 명령은 `work start`(또는 `work configure`)의 `--task-verify`·`--verify`·`--group-verify`로 묶음에 저장하고, 각 명령에는 `HAERAM_TIER`·`HAERAM_DIFF_BASE`·`HAERAM_TASK(S)`가 전달됩니다. 예를 들어 태스크 단계를 `pnpm vitest related --run $(git diff --name-only "$HAERAM_DIFF_BASE" HEAD)`로 두면 호스트가 영향받는 테스트를 직접 실행합니다.
- 상위 브랜치가 바뀌어도 바뀐 파일이 제출물의 변경이나 SSOT와 겹치지 않으면 리뷰 승인이 유지되고, 겹치면 재리뷰합니다. 줄기 여러 개를 연달아 통합해도 재리뷰가 반복되지 않습니다.

### 세션 여러 개로 진행하기 (터미널·Orca)

세션을 여러 개 열고 각각 "남은 태스크 구현해줘"라고 요청하면 같은 루프가 알아서 일을 나눕니다. 태스크에 `lane:`이 있거나 활성 묶음이 있으면 implement-task가 `work next --owner <세션 이름> --wait 540`을 반복합니다.

```text
세션 A: 기반 T001 구현 → 제출 ─────────────────→ 줄기 a 구현 ...
세션 B: (대기) ───────→ T001 리뷰·승인 → (통합 대기) → 줄기 b 구현 ...
CLI   :                               └ 백그라운드 통합(빠른 검사)
```

- next는 자기 단위 → 수정 요청 → 다른 세션 제출물 리뷰 → 다음 단위 순으로 `action`(`implement`·`review`·`blocked`·`wait`·`complete`·`stalled`)을 돌려줍니다. 받을 일이 없으면 모델 호출 없이 기다립니다.
- 승인된 단위의 통합과 마지막 묶음 검증은 CLI가 백그라운드 프로세스로 실행하므로 세션은 구현과 리뷰에만 집중합니다. 통합이 실패하면 그 줄기의 작업자에게 수정 요청으로 돌아갑니다.
- 활성 묶음이 없으면 첫 세션의 `next --start`가 만들고, 같은 커밋에서 시작한 다른 세션은 그 묶음에 합류합니다.
- 자기 작업은 스스로 승인할 수 없습니다. 세션이 하나뿐이면 `needs-reviewer`가 돌아오므로 세션을 하나 더 열거나 리뷰 서브에이전트를 씁니다.
- Orca 같은 오케스트레이터는 이 요청을 받은 에이전트 N개를 유지하고, `wait`·timeout으로 끝난 에이전트만 다시 띄우면 됩니다. 배정·리뷰·통합 판단은 CLI가 합니다.

설계 배경은 [협업 설계 검토](https://github.com/hetarho/haeram-spec-creator/blob/main/docs/worktree-collaboration-review.md)에 기록합니다.

## 워커 4개와 리뷰어 1개로 대기 작업 계속 처리하기

`STATE.next`는 사람이 재개할 때 볼 안내입니다. 개별 에이전트의 배정은 공유 runtime이 관리합니다. `claim-next`는 의존성이 충족된 단위(줄기 하나 또는 lane 없는 태스크 하나) 중 후속 작업을 많이 여는 단위, 오래된 ID 순으로 하나를 선택하고 원자적으로 선점합니다. 동시에 요청해도 같은 태스크를 배정하지 않습니다. `next`는 resume과 claim-next를 합치고 `--wait`로 대기할 수 있습니다.

```bash
npx haeram-spec-creator work start feature --workers 4 --reviewers 1 --max-pending 8 --json
npx haeram-spec-creator work claim-next --work feature --owner worker-a --json
npx haeram-spec-creator work resume --work feature --owner worker-a --json
npx haeram-spec-creator work next --work feature --owner worker-a --wait 540 --json
```

수정 요청이 있으면 resume로 먼저 처리합니다. 리뷰 대기가 max-pending에 도달하면 새 배정을 멈춥니다. 태스크 인용줄에 선택 필드 `touches:src/auth/ prisma/schema.prisma`를 적으면 겹치는 영역은 통합/해제될 때까지 직렬화합니다. 생략은 영향 범위가 알려지지 않았다는 뜻입니다. claimable은 보드의 후보 표시이며, 실제 배정은 용량·적체·신선도를 다시 검사합니다.

`work run`은 설치된 Codex·Claude CLI로 빈 워커 슬롯 보충, 줄기의 다음 태스크를 같은 공간에 이어 배정, 완료 후 검증·리뷰, 수정 재배정, 승인 후 직렬 통합, 묶음 완료 검증까지 수행합니다. 단계 명령은 [줄기 절](#줄기lane로-나누고-단계별로-검증하기)과 같습니다. 작업자와 리뷰어의 도구를 다르게 지정할 수 있습니다.

```bash
npx haeram-spec-creator work doctor --json
npx haeram-spec-creator work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --dry-run --json
npx haeram-spec-creator work run --work feature --provider codex --reviewer-provider claude --task-verify 'npm run lint' --verify 'npm ci && npm run lint' --group-verify 'npm ci && npm run ci' --json
```

doctor와 dry-run은 모델을 호출하지 않습니다. `--autopilot`이면 사람이 없다는 전제로 돕니다 — 기획 결정이 필요한 워커는 결정 요청을 남기고 다른 단위가 계속되며, 조정자 세션(`work next --coordinator --autopilot`)이 잠정 결정해 `work update --status doing --note`로 재개하면 실행기가 기획 브랜치를 합치고 **같은 세션**을 이어 실행합니다. 같은 lane의 다음 태스크와 수정도 세션을 이어 쓰고, 워커에게는 태스크·인용 결정·검증 명령을 묶은 브리핑(`work brief`)을 넘깁니다. timeout 전에는 작업 공간을 스냅샷하고 진행분을 커밋해 이어 가며, macOS에서는 실행 중 절전을 막습니다. 새 worktree에는 프로젝트의 권한 허용 목록이 적용되지 않으므로 워커가 실행할 명령은 `--allow-tool`로 묶음에 저장합니다. provider를 생략하면 호환되는 Codex, Claude 순으로 선택하며, reviewer-provider를 생략하면 같은 도구를 사용합니다. 모델은 각 CLI 기본 설정을 사용하거나 `--model`·`--reviewer-model`로 지정합니다. CLI 로그인과 모델 접근 권한은 별도 준비가 필요합니다. 기본 어댑터의 워커는 파일을 편집하고, 호스트가 계약·변경 범위를 검사한 뒤 커밋·검증·제출합니다.

다른 실행기는 `--adapter <json-file>`로 연결할 수 있습니다. [실행 설정과 Orca 연결 방법](skills/manage-work/references/runner.md)에 설정 예·출력 규약·권한·복구 절차가 있습니다. Orca에서는 coordinator가 같은 선점·리뷰 CLI를 호출할 수 있습니다. doctor는 macOS Orca 앱에 포함된 CLI도 찾아 확인하지만 Orca pane/task/dispatch 자동 생성 어댑터는 아직 포함하지 않습니다.

### 태스크 30개를 워커 6개로 실행하기

```sh
npx haeram-spec-creator work start feature --workers 6 --reviewers 1 --max-pending 12 --json
# Claude만 실행하려면 --provider claude, Codex만 실행하려면 --provider codex
npx haeram-spec-creator work run --work feature --providers codex,claude --verify 'npm run lint' --group-verify 'npm test' --json
```

혼합 목록은 슬롯에 반복 배정합니다. `codex,claude`는 각각 3개, `codex,claude,claude`는 Codex 2개와 Claude 4개가 됩니다. 모델을 생략하면 각 CLI의 설정을 사용하며, 도구별 모델은 [adapter workers 설정](skills/manage-work/references/runner.md#단일-도구와-혼합-워커)에 지정합니다. 리뷰어는 워커 6개와 별도로 실행됩니다.

태스크를 미리 5개씩 묶지 않고 빈 슬롯이 다음 가능한 단위(lane이면 줄기 전체)를 가져갑니다. 작업 시간 차이로 일부 슬롯이 더 많은 일을 처리할 수 있고, 의존성·예상 변경 경로·리뷰 적체 때문에 동시 실행 수가 줄어들 수 있습니다.

```sh
npx haeram-spec-creator work board --work feature --json
npx haeram-spec-creator work history --work feature --task T001 --json
# 수동으로 실행했다면 작업 명령이 멈춘 체크포인트에서 Git에 저장
npx haeram-spec-creator work sync --work feature --json
```

보드의 `summary`는 총량·완료·남은 일·실행·리뷰·blocked 수를 보여 줍니다. STATE의 선택적 `## work` 표는 같은 요약과 상세 JSON 링크를 저장합니다. 완료 태스크의 acceptance·검증 근거는 `tasks/done/`, 배정·실행 도구·수정 요청·재시도 이력은 `spec/work/feature.json`에 남습니다. STATE는 마지막 저장 시점의 체크포인트이고 실행 중 최신 상태는 보드에서 확인합니다.

실행기는 통합할 때마다 기록을 저장하고 정상 완료·한도 도달·처리한 종료 신호 뒤 최종 기록을 커밋합니다. 저장에 실패하면 결과의 `snapshotError`와 `failures`에 원인을 남깁니다. 미커밋 기획 변경을 정리한 뒤 `work sync`로 다시 저장할 수 있습니다. 실행 중 수동 sync는 거부합니다. sync 커밋은 STATE와 실행 기록만 바꾸므로 리뷰 승인을 무효화하지 않습니다. 새 clone에서도 `work history`로 저장된 이력을 조회할 수 있지만 과거 워커의 실행 권한을 복원하지는 않습니다.

리뷰는 제출 커밋에 묶입니다. P1/P2 finding이 있으면 승인할 수 없고, 코드 변경은 재제출이 필요합니다. 합친 결과는 통합 검증이 다시 확인합니다. 이 리뷰는 기존 review-code의 사용자 채택형 개선 제안과 별도로 동작합니다.

runner는 대기 중 모델을 반복 호출하지 않고 프로세스 완료를 기다립니다. 작업자가 긴 작업 중 최신 정책을 읽는 절차는 스킬에서 수행하며, heartbeat만으로 에이전트의 문맥이 자동 갱신되지는 않습니다. 전부 통합하면 completed, 더 진행할 수 없는 작업이 남으면 needs-attention과 목록을 반환합니다. 재시도/실행 횟수 제한과 중단 복구를 지원합니다. 자동 cleanup은 하지 않으며, 대상 브랜치 반영·push는 묶음에 `--push <branch>`가 있을 때만 통합 단위마다 합니다.

## 저장소 개발

스킬은 [Agent Skills 형식](https://agentskills.io/)을 따릅니다 — `skills/<name>/SKILL.md`(frontmatter `name`=폴더명·`description`), 선택 `references/`(필요할 때만 읽는 상세)·`assets/`·`scripts/`·`agents/openai.yaml`(Codex 전용).

```bash
npm install
npm test
npm run validate
npm run check
```

- `npm run validate`: 추가된 스킬의 구조와 frontmatter를 검사합니다. 개발 중에는 빈 `skills/`도 허용합니다.
- `npm run check`: 테스트, 스킬 검증, 실제 npm tarball에 포함될 파일을 함께 확인합니다.
- `npm run release:check`: 스킬이 하나 이상 있는지까지 검사합니다.
- `prepublishOnly`: 배포 직전에 `release:check`를 다시 실행합니다.

### 릴리스

`package.json`의 버전을 올려 `main`에 푸시하면 GitHub Actions(`release.yml`)가 npm에 자동 배포합니다. 이미 배포된 버전이면 배포를 건너뛰므로, 버전을 올리지 않은 일반 푸시는 안전합니다.

```bash
npm version patch   # 또는 minor / major — 버전 커밋과 태그가 함께 생성됩니다
git push origin main --follow-tags
```

## 라이선스

[MIT](./LICENSE)
