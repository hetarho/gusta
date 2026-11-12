# 브랜치 전략과 검증

[README](../README.ko.md) · [개발 흐름](workflow.md) · **브랜치·검증** · [오래 맡기기](autopilot.md) · [병렬 작업](parallel-work.md) · [자가 개선](self-improve.md) · [CLI](cli.md)

## 브랜치 전략

끝난 작업이 어디로 가는지는 스킬에 고정돼 있지 않고 `spec/SETTINGS.md`가 정합니다. 정해지지 않았으면(`land: ?`) 어느 스킬을 부르든 먼저 `/gusta-init`이 묻습니다. 맡김은 묻지 않고 현재 브랜치에 커밋만 한 뒤 결정함에 남깁니다. 설정은 `/gusta-preference`로 보고 바꿉니다.

| 키 | 값 | 뜻 |
|---|---|---|
| `land` | `?` · `current` · 브랜치 | gusta-start 세션·자가 개선(gusta-self-improve·gusta-self-improve-remote)·작업 묶음이 끝나면 병합될 브랜치 |
| `land-via` | `merge`(기본) · `pr` | land에 직접 병합하거나, 작업 브랜치를 올려 PR |
| `push` | `false`(기본) · `true` | land를 원격에도 올릴지 (push마다 원격 CI) |
| `deploy` | `-`(기본) · 브랜치 | "배포해줘"(`vibe deploy`)가 land로 fast-forward할 브랜치 |
| `plan` | `?` · `-` · 브랜치 | 태스크 번호·SSOT rev를 매기는 기획 브랜치 (미정이면 land) |

```text
바로 main에 병합      land: main  · deploy: -
next 경유 후 배포     land: next  · deploy: main   ("배포해줘" → main을 next로 fast-forward)
PR                   land: main  · land-via: pr
커밋만(예전 기본)      land: current
```

세션 끝의 `vibe push`가 이 설정대로 반영합니다. push가 켜져 있으면 원격 land를 합친 뒤 push하고, 꺼져 있으면 로컬 land 브랜치에 병합합니다(land를 먼저 합쳐 land는 fast-forward만). PR 전략이면 작업 브랜치를 올리고 PR을 엽니다. `vibe deploy`는 deploy 브랜치를 land의 검증된 커밋으로 fast-forward만 하고, deploy에 land에 없는 커밋(핫픽스 등)이 있으면 거절합니다. 그 커밋을 land에 합쳐 검증한 뒤 다시 배포합니다.

기획 문서는 예외입니다. `plan` 브랜치에서 `vibe plan-sync`로 최신을 합친 뒤 기획하고, spec/만 담은 기획 커밋을 `vibe plan-push`로 그 브랜치에 바로 올립니다(태스크 ID 충돌이면 거절). 명령 목록은 [CLI](cli.md#cli-명령)에 있습니다.

## 검증과 push

- **태스크마다**: 변경 영향 단위 테스트와 빠른 검사(typecheck·lint·format)만 돌립니다. 테스트는 스크립트 이름이 아니라 격리 범위·의존성으로 분류하고, 실행하지 않은 통합/e2e는 result limits에 남겨 마감 관문에 넘깁니다. `vibe check --tier task`는 ARCH batch 단계에만 있는 명령(전체 스위트)을 거절하고, 5분 넘는 태스크 검사에는 `slow`·`hint`를 붙입니다(사용자가 별도 실행을 명시하면 `--allow-final`).
- **마감 관문**: 통합·e2e·전체 스위트는 조정자/loop 호스트 하나가 최종 후보에서 한 번 실행합니다(단독 `vibe check --tier batch`, 묶음 `--group-verify`). 같은 트리·같은 명령의 통과는 재사용하고, 무거운 검사는 clone 공용 락으로 하나씩 돌립니다. 구현·리뷰 세션은 세션이 끝났다고 브라우저·전체 검사를 띄우지 않습니다. 검증 없는 코드 push는 중단합니다.
- **반영**: 끝난 작업은 SETTINGS `land`로 갑니다([브랜치 전략](#브랜치-전략)). 세션 끝에 검증한 SHA로 한 번 반영하고(`vibe push --verified-commit <SHA>` — 그 뒤 코드가 바뀌면 거절), push가 켜져 있으면 CI를 한 번 기다립니다(`vibe ci wait`: gh → 토큰 API → 공개 페이지 순, 기본 no-run 유예 2분·제한 1시간, 대기 중 모델 호출 없음). 셋 다 CI를 읽지 못하면(gh·토큰 없는 비공개 저장소, GitHub 원격 아님) 유예 뒤 `unchecked`로 끝내고 진행을 멈추지 않습니다 — 통과로 치지 않고, 보고서 next의 `check CI later`와 종료 알림의 `ciUnchecked`로 확인할 커밋을 알려 줍니다. 단위별 push는 사용자가 명시할 때만입니다(`vibe loop --push-each-unit`, 묶음 `--push`).
- 단계는 ARCH의 task/batch/CI 하위 줄이 정합니다. 단계가 없는 legacy ARCH는 package.json의 verify/test 스크립트를 batch로 보거나 `--verify '<command>'`를 씁니다. 세부 절차는 [조정자 검증 절차](../skills/gusta-start/references/verification.md)에 있습니다.

```bash
npx @haeram/gusta vibe check --tier task --diff-base <task-start-sha> -- pnpm run typecheck
npx @haeram/gusta vibe check --tier batch --diff-base <batch-start-sha> -- pnpm run test
npx @haeram/gusta vibe push --verified-commit <SHA> --wait-ci --diff-base <batch-start-sha>
```
