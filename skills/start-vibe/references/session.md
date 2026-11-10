# 함께 모드와 실행기 밖 세션

시작 질문은 한 번에 모은다: 함께/맡김, route:choose의 기획/구현 우선순위, 다른 기기의 배정(이어받기는 사용자 지시 필요). 인자로 답한 것은 묻지 않는다. 함께 모드가 기본이며 질문 도구가 없으면 텍스트 질문 뒤 답을 기다린다.

함께는 `vibe status --section inbox --no-fetch --json`으로 결정함만 확인받는다. 승인 항목은 삭제+log, 수정은 update-ssot 후 삭제. 열린 보고서는 to를 채운다. 결정은 cfg.level에 맞춰 모아 묻는다.

맡김으로 전환하면 preflight(push 브랜치가 있으면 push 권한·명령 가용성·실제 헤드리스 권한)를 한 번 돌려 사람이 고쳐야 할 실패를 떠나기 전 확인한다. 그 뒤 직렬은 `vibe loop --detach`가 active·보고서·절전 방지를 준비하고(SKILL 1절), 작업 묶음 조정자만 이 세션에서 active·보고서·awake를 준비한다.

실행기 밖 조정자/단독 시작 세션만 마감 때 보고서 to/next와 STATE next를 채우고 beat --end, 최종 후보의 묶음 검증(push 브랜치가 있으면 검증 SHA로 push 한 번), awake --stop을 한다. 마지막으로 `vibe prune --tag <tag>`를 실행한다. 이 세션의 `wip/<tag>`와 합쳐진 작업 묶음의 브랜치·worktree를 정리하며, 설정이 false면 CLI가 건너뛴다. 보고는 한 일·inbox/parked·다음 일·보고서 경로만 짧게 한다.
