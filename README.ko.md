# GUSTA

[English](README.md) | **한국어**

> *Gustum usque sere, tuum aperi.*
> 취향을 늘 심어 가꾸고, 네 취향을 세상에 열어 보여라.

**코드 큐레이터를 위한 스펙 주도 개발(SDD) 프레임워크 — 취향을 가꾸고, 전시하세요.**

기획 초안도, 코드도, 검증도 이제 AI가 만듭니다. 사람에게 남은 일은 **무엇을 남길지 고르는 것**입니다. 무엇을 넣고 무엇을 뺄지, 어떤 결정을 받아들이고 어떤 결정을 돌려보낼지가 제품을 정합니다. GUSTA는 개발자를 코드를 치는 사람이 아니라, 취향을 기르고 좋은 스펙과 코드를 골라 배치하는 **큐레이터**로 봅니다. 제안·구현·검증은 AI가 만들고, 고르는 것은 사람입니다.

라틴어 *gusta*는 "맛보라!", 스페인어 *me gusta*는 "내 마음에 든다"입니다 — 표어의 첫 글자를 모으면 G·U·S·T·A가 됩니다. GUSTA는 개발자 자신의 취향과 기준을 체계로 만드는 SDD 프레임워크입니다. Claude Code·Codex용 Agent Skills가 아이디어를 스펙으로 키우고 **요구사항 → 설계 → 작업 계획 → 구현 → 검증**을 한 흐름으로 이어, 각 단계의 결과를 다음 단계의 입력으로 넘깁니다. npm 패키지는 그 스킬을 여러 프로젝트에 설치하고 동기화하는 배포 수단일 뿐입니다.

## 왜 GUSTA인가

- **spec이 1급 문서입니다.** 결정은 SSOT에, 진행은 STATE에, 구현 계획은 태스크에 — 코드보다 먼저 바뀝니다. 구현 중 기획 공백이 보이면 코드로 임의로 확정하지 않고 spec으로 올립니다.
- **AI가 만들고, 당신이 고릅니다.** *함께* 모드는 결정 지점마다 추천안과 선택지를 모아 묻습니다. *맡김* 모드는 묻지 않고 추천안으로 진행한 뒤, 받았어야 할 질문과 고른 답을 **결정함**에 남깁니다. 돌아와서 고르기만 하면 됩니다. 결과 의미·공개 계약·검증 범위를 바꾸는 큰 변화는 스스로 적용하지 않고 제안으로 남깁니다.
- **맡기고 떠나도 됩니다.** `vibe loop`는 태스크·기획 조각마다 새 세션을 띄워 맥락이 쌓이지 않습니다. 태스크마다 도는 것은 변경 영향 단위 테스트와 빠른 검사뿐이고, 전체 스위트·push·CI는 마지막 마감 관문에서 한 번 — 그 길이는 어림이 아니라 실측입니다.
- **눈으로 보고 고릅니다.** 디자인 모드는 화면을 보며 말하는 대로 코드를 바로 고칩니다. `gusta-showcase`는 변형 2~6개를 병렬로 만들어 나란히 띄우고, 고른 것만 합칩니다.
- **가볍습니다.** 구현 세션은 태스크가 기대는 결정 블록만 담은 브리핑을 읽습니다. Claude Code와 Codex에서, Node가 아니어도(Python, Flutter, Go …) Git 프로젝트라면 동작하고 `npx`는 `node_modules`를 남기지 않습니다.

## 빠른 시작

**1. 설치.** 프로젝트에서 ([npm](https://www.npmjs.com/package/@haeram/gusta)):

```bash
npx @haeram/gusta@latest install    # 이후 업데이트도 같은 명령
```

또는 Claude Code나 Codex로 프로젝트를 열고 다음을 붙여 넣으세요.

```text
이 프로젝트에 GUSTA 스킬셋을 설치해줘. 의존성으로 추가하지 말고 npx로 실행해줘.
먼저 `npx -y @haeram/gusta@latest install --dry-run`으로 설치 계획과 충돌 여부를 확인하고,
기존 스킬과 충돌하면 덮어쓰지 말고 나에게 알려줘.
문제 없으면 `npx -y @haeram/gusta@latest install`로 설치한 뒤 `npx -y @haeram/gusta@latest check`로 검증해줘.
```

**2. 새 세션을 시작합니다.** 설치된 스킬이 발견되도록 세션을 다시 엽니다.

**3. `/gusta-start`를 실행합니다.**

```text
/gusta-start
/gusta-start 태그 기능 만들자    ← 요청 문장이 있으면 STATE보다 먼저 해석합니다
```

원격에서 다른 기기가 진행 중인 세션을 확인하고, 질문은 한 번에 — 모드, 무엇부터, 이어받을지 — 묻습니다. 그다음 `spec/STATE.md`를 보고 다음 스킬을 고릅니다: 아무것도 없으면 `/ideation`, 아이디어가 있으면 기획, 태스크가 있으면 구현. 태스크마다 커밋하고, 끝난 작업은 세션 끝에 `spec/SETTINGS.md`대로 한 번 반영합니다(기본은 push하지 않음).

## 핵심 개념

### 두 가지 모드

| 모드 | 결정 | 사용자가 없을 때 |
| --- | --- | --- |
| 함께 | 결정 지점마다 선택지를 모아서 묻습니다 | — |
| 맡김 | 추천안으로 진행하고 결정함·보고서에 남깁니다 | 기다리지 않습니다. 과금·데이터 삭제·개인정보·보안 정책, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일(force push, 브랜치 삭제, 배포·게시 등)만 주차합니다 |

"나 나갈게"라고 하면 맡김으로, 돌아와 말을 걸거나 `/gusta-start`를 다시 실행하면 결정함부터 보여 주는 함께로 바뀝니다.

### `spec/` 폴더

| 경로 | 담는 것 |
| --- | --- |
| `STATE.md` | 관제탑: 설정·실행 중 세션·결정함·SSOT rev 현황·태스크 보드·next·log |
| `FORMAT.md` | 모든 spec 문서의 압축 표기 규칙 |
| `SETTINGS.md` | (선택) 패키지 동작 설정(브랜치 전략 등) — 없는 키는 기본값 |
| `ideation/` | 구체화 중인 아이디어 — `done/`은 SSOT 반영을 마친 문서 보존 |
| `ssot/` | 도메인별 단일 진실 공급원 — 결정과 근거만, `rev`로 변경 추적 |
| `tasks/` | 남은 태스크 — `done/`은 완료 태스크를 역사 기록으로 보관 |
| `review/` | (선택) 코드·자율 개선 finding |
| `reports/` | (선택) 맡김 세션 보고서 |

spec 문서는 영어 압축 표기로, 인터뷰·질문·보고는 사용자 언어로 씁니다.

### 직접 부르는 스킬

| 스킬 | 하는 일 |
| --- | --- |
| `/gusta-start` | 진입점. 다른 기기 확인, 모드 질문 한 번, 기획·구현 선택, 태스크별 커밋, 마감 관문 |
| `/gusta-design-mode` | 실시간 디자인: 화면을 보며 말하는 대로 코드만 고치고, 디자인이 끝났다고 하면 테스트 후 커밋 하나 |
| `/gusta-showcase` | 변형 2~6개를 병렬 구현해 나란히 띄우거나 같은 측정으로 비교하고, 고른 것만 합침 |
| `/ideation` | 생각날 때마다 아이디어를 받아 적고, 원하면 발산·수렴 루프로 구체화 |
| `/gusta-self-improve` | 호출한 세션이 하위 세션의 개선 제안을 승인해 현재 브랜치에 통합 — PR 없음 |
| `/gusta-self-improve-remote` | 한 번 위임한 범위·예산 안에서 문제를 찾아 측정·구현·독립 검토 후 PR |
| `/gusta-init` | 브랜치 전략 중 미정인 설정만 묻고 `spec/SETTINGS.md`에 저장 |
| `/gusta-preference` | `spec/SETTINGS.md`를 표로 보여 주고, 말한 값만 바꿈 |
| `/gusta-update` | 새 버전 확인 → 스킬 재설치 → `spec/` 이관 → 프로젝트 규칙 대조 → lint → 커밋 |
| `/gusta-send-issue` | 세션 끝에 GUSTA 스킬·CLI가 어떻게 동작했는지 돌아보고, 익명화한 개선 사항을 보여 준 뒤 확인하면 [hetarho/gusta](https://github.com/hetarho/gusta/issues)에 이슈로 올림 |

나머지 10종 — `gusta-create-architecture`, `gusta-create-ssot`, `gusta-update-ssot`, `gusta-create-task`, `gusta-implement-task`, `gusta-review-code`, `gusta-doc-review`, `gusta-review-task`, `gusta-manage-work`, `gusta-create-narrative` — 은 `/gusta-start`가 골라 씁니다. 이름으로 직접 부르거나 "SSOT 변경사항 태스크로 쪼개줘"처럼 원하는 결과를 말해도 됩니다.

### 핵심 CLI

```bash
npx @haeram/gusta@latest install            # 스킬 설치·업데이트
npx @haeram/gusta check                     # 설치본이 패키지와 같은지 확인
npx @haeram/gusta lint                      # spec/이 FORMAT 불변식을 지키는지 검사
npx @haeram/gusta vibe status --tag k3f9    # 다른 기기의 세션·남은 일·추천 경로
npx @haeram/gusta vibe brief T012           # 태스크가 기대는 결정 블록
npx @haeram/gusta vibe loop --tag k3f9 --provider claude --json    # 맡김: 단위마다 새 세션
npx @haeram/gusta vibe push                 # 끝난 작업을 spec/SETTINGS.md대로 반영
npx @haeram/gusta work run --work feature --provider codex --json  # 병렬 워커와 리뷰어
```

## 문서

| 문서 | 내용 |
| --- | --- |
| [개발 흐름](docs/workflow.md) | 철학, 핵심 원칙, 전체 스킬, `spec/` 구조, 아이디어, 디자인 모드, showcase, 설정 |
| [브랜치·검증](docs/branching.md) | `land` · `land-via` · `push` · `deploy` · `plan`, 단계별 검증과 마감 관문 |
| [오래 맡기기](docs/autopilot.md) | `vibe loop`로 오래 맡기기, `vibe brief` 결정 브리핑 |
| [병렬 작업](docs/parallel-work.md) | 작업 묶음, 줄기(lane), 세션 여러 개, 워커·리뷰어 |
| [자가 개선](docs/self-improve.md) | `gusta-self-improve`, `gusta-self-improve-remote` |
| [CLI](docs/cli.md) | 설치 옵션, 전체 명령, 기존 프로젝트 이관 |
| [기여하기](CONTRIBUTING.md) | 저장소 개발과 릴리스 |

버전별 변경은 [CHANGELOG](CHANGELOG.md), 이전 설계 기록은 [docs/history](docs/history/)에 있습니다.

## 라이선스

[MIT](LICENSE)
