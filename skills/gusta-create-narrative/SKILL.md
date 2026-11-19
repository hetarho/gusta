---
name: gusta-create-narrative
description: >-
  spec/ 전체를 사람이 읽는 한국어 이야기(spec/NARRATIVE.md)로 엮는다. "내러티브 만들어줘, 온보딩 문서, 프로젝트 소개 글"에 사용. 새 결정은 만들지 않는다.
---

# gusta-create-narrative — spec을 사람의 이야기로

**역할: 작가(테크니컬 라이터).** 기획자와 엔지니어가 압축해둔 결정들을 풀어, 처음 보는 사람이
"왜 → 무엇 → 어떻게 → 지금 어디까지"를 한 번에 이해하게 만든다. **새 결정·새 해석을 만들지 않는다**
— 재료는 spec/에 있는 것뿐이고, 내용이 SSOT와 어긋나면 SSOT가 이긴다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json`(실행기 안에서는 brief)으로 필요한 요약만 본다. spec/이 없으면 /gusta-plan을 안내하고 멈춘다. `settings.unset`이 있으면 gusta-init으로 정한다(맡김에서는 묻지 않고 미정인 채 진행한다).
2. **문서 먼저**: 쓰기·구현 전에 문서 상태는 STATE에, 세션 기록은 `vibe beat|claim|inbox|log`로만 남긴다(SESSIONS.md를 직접 고치지 않는다). 구현은 land·deploy·plan 브랜치가 아닌 하위 브랜치의 배정된 작업 공간에서 한다. `vibe status`에 `design`이 있으면 커밋·push 전에 디자인이 끝났는지 묻고, 끝났으면 gusta-design-mode 마감부터 한다.
3. 산출 문서는 FORMAT 표기만 쓴다 — `vibe format --section <절>`로 필요한 절만 본다.
4. 질문·보고는 cfg.lang·cfg.level대로, 산출 문서 언어는 FORMAT 언어 규칙대로. 선택지형 질문 도구가 있으면 쓴다. 맡김(gusta-start·loop 단위)에서는 묻지 않는다 — 추천안으로 진행해 `vibe inbox add`로 남기고, 되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일과 권한 창이 뜰 만한 명령은 주차한다. 사용자가 직접 부른 스킬은 묻는다.
5. **읽기**: `vibe brief <ID> --summary`로 범위를 찾고 필요한 블록만 원문째 읽는다 — 출력의 complete·`next`가 덜 읽은 곳을 알려 준다. STATE·FORMAT·ARCH·큰 코드·tasks/done/을 통째로 읽지 않는다. 긴 출력은 요약·tail만 보고 전체는 파일로 남긴다.

어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 `vibe format --section settings`의 `plan`).

작업 묶음의 진행 상황은 공유 보드의 doing/blocked/ready/integrated를 사용한다. STATE에 todo로 남은 워커를 미착수로 서술하지 않는다.

## 1. 시작
STATE 읽기 → `vibe log --text 'gusta-create-narrative start'` → 재료 읽기: ssot/*(결정·근거·제약·[?])와 STATE(현황·next)·`vibe log`(최근 활동), 그리고 활성 tasks/*(진행 중인 것). 완료 태스크는 일괄로 읽지 않는다 — ⑤ '지금'은 STATE와 `vibe log`로 쓰고, 이야기가 되는 특정 마일스톤만 `tasks/done/`에서 골라 연다.
기존 NARRATIVE.md가 있으면 스탬프의 rev와 현재 rev를 비교해, 달라진 부분을 중심으로 고쳐 쓴다(전면 재작성보다 유지·갱신).

## 2. 독자 인터뷰 (질문 1~2개만)
- **독자**: 팀 동료 / 신규 합류자 / 비개발 이해관계자 / 미래의 나
- **용도**: 온보딩 / 의사결정 공유 / 현황 보고 / 회고
독자에 따라 깊이를 바꾼다 — 비개발 독자면 기술 결정은 "그래서 무엇이 가능해지는가"로 풀고, 개발 독자면 ARCH의 근거까지 다룬다.

## 3. 이야기 뼈대 (고정 흐름)
① **왜** — 이 프로젝트가 풀려는 문제와 목적 (각 ssot 인용줄의 목적에서)
② **무엇** — 핵심 기능, 그리고 **하지 않기로 한 것** ([o]·[x] 결정에서 — 범위의 경계가 이야기를 만든다)
③ **어떻게** — 아키텍처와 중요한 기술 선택, 그렇게 정한 이유 (ARCH의 ← 근거에서)
④ **결정의 순간들** — 트레이드오프가 있던 결정과 방향을 바꾼 기각([x]) 중 이야기가 되는 것만 골라 서사로
⑤ **지금** — 완료된 것(done), 진행 중(doing), 남은 것(todo·pending), 그리고 **아직 정하지 못한 것([?]) — 숨기지 말고 정직하게**

## 4. 한국어로 쓰기
변환 순서: ① 스펙에서 핵심 발췌 → ② 독자의 언어로 요약 → ③ 이야기로 연결(살 붙이기). 이 순서가 원문 왜곡을 막는다.
references/korean-style.md 규칙집을 적용해 쓰고, 완성 후 그 '퇴고' 절차대로 반드시 두 번 퇴고한다(1차 내용 보존 — 다르면 고치는 쪽은 내러티브).

## 5. 작성·마감
- `spec/NARRATIVE.md` 작성. 첫 줄에 낡음 감지용 스탬프: `> as of ARCH@2 BM@3 | 260905 | 독자: 팀 동료`
- 사실은 전부 spec/에서만 가져온다 — spec에 없는 내용은 쓰지 않고, 미정은 [?] 그대로 "아직 정하지 못했다"고 쓴다.
- 초안을 사용자에게 보여주고 피드백을 1회 반영한다.
- `vibe log` 1줄. STATE의 ssot·tasks 테이블은 건드리지 않는다(narrative는 파생물). next도 유지.
