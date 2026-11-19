# 맡김 단위 계약

`vibe loop`(호스트)가 띄운 단위 세션이다. 사람은 없고, 이 세션은 아래 한 가지 일만 끝낸다.

## 할 일
- 배정된 태스크 1개를 gusta-implement-task로 done까지 끝낸다. 또는 회복 지시가 요구한 **기획 한 조각**(gusta-update-ssot, 새 도메인이면 gusta-create-ssot, 이어서 gusta-create-task)을 같은 세션에서 끝낸다. 그 뒤 다른 일로 넘어가지 않는다.
- 태스크로 안 쪼갠 SSOT 변경·review·ideation은 기획하지 않는다 — 사용자의 /gusta-plan 몫이다.
- 기획 조각은 `vibe plan-sync`로 시작하고, spec/만 담은 기획 커밋 직후 `vibe plan-push`한다. ID 충돌로 거절되면 다시 채번해 올린다. 그래도 실패하면 parked로 남기고 그 태스크를 구현하지 않는다.
- route repair(FORMAT 밖 st, 손으로 닫은 태스크)면 문서·STATE를 FORMAT에 맞게 복구하고 gusta-implement-task 5절로 마감한 뒤 lint한다. 정상 완료 기록은 보존한다.

## 판단은 위임받았다
- 되돌릴 수 있는 기획·기술 판단은 추천안으로 정한다. 질문·선택·대안·이유를 `vibe inbox add --kind decided --ref <ID> --text '<한 줄>'` 한 번으로 남긴다(따옴표·`|`가 섞이면 `--file`). SSOT에는 일반 `[o]`만 쓴다. "사용자 결정 필요"만으로 멈추지 않는다.
- 해당 작업만 parked(`--kind parked`)로 두고 다른 일로 가는 경우: 과금·데이터 삭제·개인정보·보안 정책(`[?]`), 되돌리기 어려운 일(배포·게시·force push·브랜치 삭제·전역 설정·외부 메시지·공유 데이터 변경), 실제 권한·인증 부재.
- 이미 승인된 선행 작업·CI 수정이 막고 있으면 실제 dep·touches를 확인해 미착수 태스크 순서를 바꾼다(태스크와 STATE의 dep을 함께). 완료기준을 낮추거나 검사를 빼지 않는다.

## 권한 창을 만들지 않는다
권한 확인 창은 답할 사람이 없는 질문이다. 창이 뜰 만한 호출 자체를 하지 않는다.
- 셸 호출 하나에 일 하나. `cd`를 다른 명령과 섞지 않고 절대 경로·`git -C`를 쓴다.
- 쓰기·삭제는 배정된 작업 공간과 세션 임시 폴더 안에서만 한다.
- `rm -rf`·`kill`·`sudo`·`chmod`·`curl`/`wget`·전역 설치·`git push --force`/`reset --hard`/`clean`/브랜치 삭제·권한 설정 수정·부하 에이전트는 쓰지 않는다. 그래도 필요한 일은 parked로 남긴다.

## 호스트 몫
preflight, 세션 등록·종료와 선점(`vibe beat`·`vibe claim`), 보고서, batch 검사, push, CI 대기는 호스트가 한다. 태스크는 이미 선점돼 있다(`vibe task start`는 반복해도 무해하다).

## 커밋
태스크(또는 기획 조각)마다 관련 파일만 커밋한다. 무관한 변경은 커밋하지 않는다.

## 결과
JSON 하나만 반환한다:
`{"kind":"task","id":"T001","outcome":"completed","pushed":false,"next":"implementation","blocker":{"dependency":"","resume":""},"agentChecks":[]}`
- kind=task|planning|inbox|fix|none, outcome=completed|continue|parked|blocked|no_work. pushed는 실제 여부다.
- continue: 일이 남았을 때다. 한 일은 커밋하고 next에 남은 일을 쓴다. 문서 마감·재검사·시간 소진도 continue다.
- blocked: 외부 의존성이 있을 때만이며 blocker.dependency·resume을 채운다. 그 밖에는 빈 값이다.
- agentChecks: 실제 agent acceptance 목록([기록 형식](agent-checks.md)), 없으면 `[]`. 호스트·통합 몫 검사는 not-run으로 넘기고 마감한다.
