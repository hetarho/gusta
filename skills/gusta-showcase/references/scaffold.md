# scaffold — 화면에 mock 데이터가 필요할 때

- `vibe ab start`에 `--scaffold-prompt <file>`을 준다. 프롬프트에는 볼 화면·필요한 데이터만 쓴다: 결정적 mock 데이터·인증 stub, 가능하면 `?mock=empty|error` 상태. 이미 있는 커밋이면 `--scaffold <ref>`.
- 결과 ok:false면 보고하고 `vibe ab stop <slug> --remove`. scaffoldWarnings(scaffold가 고친 UI 파일)가 대상 화면 자체면 scaffold부터 다시 만든다.
- `vibe ab run` 결과의 scaffoldTouched(변형이 scaffold 줄·파일을 고침)는 보여 주기 전에 되돌리는 follow-up을 보낸다(데이터 변경이 필요하면 summary로 받는다). scaffoldResidue는 줄이 실제 scaffold를 가리킬 때만 follow-up, 아니면 사용자에게 그 줄을 보이고 확인받아 `pick --accept-residue`.
- 메인을 다듬을 때도 scaffold의 줄·파일은 고치지 않는다 — pick이 scaffold를 빼고 옮긴다. pick의 `todo`(실제 데이터 연결)는 마감에서 gusta-create-task로 간다.
