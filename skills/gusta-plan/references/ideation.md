# 미룬 구상 기록

gusta-plan·gusta-sketch가 사용자가 "이렇게 하자"고 정하지 않은 것만 ideation 문서에 남긴다 — "이 부분은 괜찮은데 나중에 다시 고민하자"처럼 미룬 구상, 아직 고르지 않은 방향, 남은 질문, gusta-showcase로 코드까지 만들어 비교할 질문. 정한 것은 SSOT·태스크로 가고 여기에 쓰지 않는다.

- 같은 주제의 open/ready 문서가 있으면 이어 쓴다. 없으면 [템플릿](../assets/ideation.md)을 `spec/ideation/<slug>.md`로 복사해 채운다(slug는 활성·done 양쪽에 중복 금지). STATE에 `## ideation`(`| id | st |`)이 없으면 `## ssot` 바로 앞에 추가하고 행 `<slug> | open@YYMMDD`를 둔다.
- vision에 문제·핵심 가치, explored에 논의한 방향을 [o] 채택(정해서 SSOT로 간 것)·[x] 폐기(이유 필수 — 같은 논의를 반복하지 않게)·[?] 미정으로, 미정 질문은 open에 쓴다. 대화와 시안 HTML은 커밋되지 않으니 다시 볼 핵심(요구사항 원문·화면 구성·흐름)을 말로 남긴다.
- 기록 형식은 `vibe format --section ideation` 발췌를 따른다. ideation 문서와 STATE만 기획 커밋하고 `vibe plan-push`한다.
