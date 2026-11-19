# 리뷰 finding → 태스크

SKILL.md 1절에서 spec/review/에 st:ready 문서가 있을 때만 읽는다.

- 대상: st:ready 문서(사용자가 `review/<slug>`를 지정하면 그것만)에서 `→T###`가 아직 없는 [o] finding. [x]·[?]는 건드리지 않는다. `vibe log --text 'gusta-create-task review/<slug> start'`.
- gusta-self-improve·gusta-self-improve-remote가 자율 채택한 [o]는 review notes의 정책 참조 또는 로컬 호출 위임·승인 범위·동작 보존 근거를 확인한다. 큰 변화나 근거 없는 [o]는 태스크화하지 않고 [?]로 돌려 인계한다.
- finding 하나 = 태스크 하나가 기본이다. 같은 파일·같은 원인이면 묶고, 한 세션에 못 끝낼 finding은 쪼갠다. 인용줄·impl notes 첫 줄·동작 불변 acceptance는 FORMAT review-sourced tasks대로 쓰고 finding이 요구하는 테스트를 더한다.
- 기획 결정을 바꾸는 finding은 태스크로 만들지 않는다 — gusta-update-ssot로 넘기고 [?]로 되돌린다.
- 마감: STATE tasks 행의 ssot 셀은 `ARCH`. 문서의 finding 끝에 `→T###`, 모든 [o]가 전환되면 문서 st→`converted@YYMMDD` + STATE review 행 갱신. ssot 행(tasked·pending)은 건드리지 않는다.
