# 조정자 절차 — start-vibe가 작업 묶음을 쓸 때

SKILL.md 2절의 조건일 때만 쓴다. 아래 `work ...`·`vibe ...`는 `npx haeram-spec-creator ...`의 축약이다. 조정자는 이 세션 하나다 — 결정·주차·보고와 최종 검증/push 소유권을 맡고 단위를 직접 구현하지 않는다(구현하면 그동안 결정 요청이 쌓인다).

## 1. 시작
- 계획(태스크·STATE)을 커밋한 뒤:
  `work start <slug> --task-verify '<태스크 단계>' --verify '<단위 통합>' [--group-verify '<묶음 완료>'] [--allow-tool '<규칙>' ...] [--review-path <계약 경로> ...] --json`
  - 검증 명령은 ARCH의 단계별 verify 결정에서 가져와 [검증 절차](verification.md)의 매핑대로 둔다(별도 명시가 없으면 자동 적용, 기존 활성 묶음도 확인·정리). 태스크 종료만으로 전체 검사를 실행하지 않는다.
  - `--push <branch>`는 사용자가 통합마다 push를 요청했을 때만 둔다 — 통합마다 push와 원격 CI가 돈다. 기본은 묶음 브랜치에 커밋으로만 모은다.
  - `--allow-tool`은 헤드리스 워커가 묻지 않고 실행할 명령 규칙이다(Claude 형식, 예 `Bash(pnpm run *)`). 워커가 도는 새 worktree는 신뢰된 폴더가 아니라서 프로젝트 `.claude/settings.json`의 허용 목록이 적용되지 않는다.
  - `--review-path`는 계약·마이그레이션처럼 언제나 리뷰가 필요한 경로다. 리뷰는 위험한 단위만 받는다(기본 `--review risky`): 변경 300줄 초과(`--review-lines`), touches 밖 변경이나 touches 미선언, review-path 변경, 테스트 파일 변경 없음, 수정 요청·통합 실패 이력, 이 단위 태스크를 가리키는 inbox `decided` — 하나라도 있으면 리뷰, 없으면 정책 승인 후 통합 검증만 한다.
- 맡김이면 preflight에서 `vibe preflight --probe '<태스크 단계 명령>' --allow-tool '<규칙>'`으로 실제 헤드리스 워커가 그 명령을 권한 확인 없이 실행하는지 실측한다. 거부되면 사용자가 떠나기 전 그 규칙을 허용할지 묻는다.

## 2. 실행
- `work run --work <slug> --autopilot [--provider codex|claude | --providers codex,claude] --json`을 셸 도구의 백그라운드 실행으로 띄운다(함께 모드면 `--autopilot` 없이). 실행기는 배정·같은 세션 resume·통합·검증 캐시/heavy 락·스냅샷·절전 방지를 모델 턴 없이 맡는다([runner.md](../../manage-work/references/runner.md)):
  - 맡김에서 결정 요청만 남으면 모델 호출 없이 결정을 기다린다(기본 15분, `--decision-wait-ms`로 변경). 대기할 attempt와 질문을 stderr·runtime 이력에 남긴다. 통합 실패 후 새로 제출·승인된 제출물은 같은 run에서 다시 통합한다. 같은 제출물의 통합 실패로 승인된 단위가 남으면 결정 대기 없이 `needs-attention`으로 끝낸다. 함께 모드는 결정 대기 없이 반환한다.

## 3. 조정자 루프
`work next --work <slug> --owner <tag> --coordinator [--autopilot] --wait 3300 --json`을 반복하고 `action`대로 한다. 결정 요청이 생기면 바로 반환한다 — Claude는 셸 백그라운드 실행+완료 알림, Codex는 긴 timeout의 단일 블로킹 호출. 55분은 1시간 프롬프트 캐시가 식기 직전에 돌아와 맥락을 싸게 읽는 길이다: 더 짧으면 깨어날 때마다 모델 턴을 쓰고, 1시간을 넘기면 쌓인 맥락 전체를 2배 값으로 다시 캐시에 쓴다.
- `decide`: 워커가 기획 결정을 요청했다(`attempt.decision`: question·options·recommendation).
  - 함께: 사용자에게 선택지형으로 묻는다(여러 건이면 모아서).
  - 맡김: 추천안으로 update-ssot를 진행한다(잠정). inbox `decided`·보고서 decided에 질문·선택·대안을 남긴다. 과금·데이터 삭제·개인정보·보안이면 정하지 않고 inbox `parked`, 그 attempt는 `work release --attempt <id> --reason parked`로 내려놓는다.
  - 기획은 묶음의 기획 공간(`group.path`)에서 하고 커밋한다. 결정을 요청한 태스크는 base를 새 rev로 올리고(내용은 그대로 — create-task의 todo 갱신 규칙) STATE ssot의 tasked도 rev로 맞춘다: 이 델타는 그 태스크가 소화한다. 기획 커밋 직후 `vibe plan-push`로 SETTINGS plan 브랜치에 올리고 바로 `work update --attempt <id> --status doing --note '<결정·rev·순서 조건>'`으로 재개한다. 선행 통합을 기다리겠다고 재개를 붙잡아 두지 않는다. 실행기가 기획 브랜치를 그 워커 공간에 합치고 같은 세션을 이어 실행한다.
  - 통합 순서 같은 의존 관계는 태스크 deps(`dep:`)에 반영해 함께 커밋하고 메모로 넘긴다. 실제 순서를 맞추는 일은 실행기와 runtime이 맡는다.
  - 같은 도메인을 참조하는 다른 진행 중 단위는 다음 제출에서 SSOT가 달라졌다며 blocked로 돌아온다. 그 태스크도 base를 올리고 `work update --status doing --note '<rev> 동기화'`로 재개하면 실행기가 같은 방식으로 합쳐 이어 간다.
- `wait`: 그대로 다시 호출한다.
- `complete`: 보고서에 묶음 브랜치·검증 커밋(push했다면 그 결과)을 남기고 마감한다. 끝난 단위의 worktree·브랜치는 실행기가 이미 정리했다. 묶음 브랜치는 기준 브랜치에 합쳐진 뒤 세션 마감의 `vibe prune`이 지운다.
- `main-session`: 묶음에서 할 일은 끝났다. 남은 explore 태스크와 그 후속을 메인 세션에서 단독으로 진행한다(먼저 `vibe sync`).
- `stalled`: 원인을 inbox `parked`·보고서에 남기고 묶음 밖의 다른 일로 간다 — 기다리지 않는다. 함께 모드는 보고하고 멈춘다.
- 실행기가 끝났는데 남은 일이 있으면 결과의 `outcome`·`failures`를 보고서 checks에 남기고, 검증 명령처럼 프로젝트 안에서 고칠 수 있는 원인은 고쳐 다시 실행한다. 권한·설정 파일·디스크처럼 권한 창이 뜰 일은 고치지 않고 parked로 남긴다(SKILL.md 3절).
