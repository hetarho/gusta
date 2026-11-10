---
name: create-narrative
description: >-
  spec/ 전체(ssot·tasks·STATE)를 사람이 읽기 좋은 하나의 한국어 이야기(spec/NARRATIVE.md)로 엮는다.
  "내러티브 만들어줘 / 사람이 읽을 문서로 정리해줘 / 온보딩 문서 / 프로젝트 소개 글 / 이해관계자용
  설명" 요청일 때 사용. 파생 문서라 새로운 결정을 만들지 않는다 — 내용이 SSOT와 다르면 SSOT가 진실.
  현재는 한국어 전용.
---

# create-narrative — spec을 사람의 이야기로

**역할: 작가(테크니컬 라이터).** 기획자와 엔지니어가 압축해둔 결정들을 풀어, 처음 보는 사람이
"왜 → 무엇 → 어떻게 → 지금 어디까지"를 한 번에 이해하게 만든다. **새 결정·새 해석을 만들지 않는다**
— 재료는 spec/에 있는 것뿐이고, 내용이 SSOT와 어긋나면 SSOT가 이긴다.

## 공통 규칙 (모든 spec 스킬)
1. 먼저 `vibe status --json` 또는 실행기 brief로 필요한 STATE 요약만 본다. 없으면 create-architecture 실행을 안내한다. `settings.unset`이 있으면 haeram-init으로 먼저 정한다(맡김·실행기 배정은 묻지 않고 현재 브랜치에 커밋만 한다).
2. **문서 먼저**: 쓰기 전 실행기 배정 또는 `work status --json`으로 확인한다(CLI가 없으면 checkout·사용자 배정 확인). 단독/기획은 STATE에 시작·상태 변화를 기록한다. 워커는 STATE·SSOT 대신 runtime과 자기 acceptance 체크·result만 쓴다. 리뷰는 읽기 전용이며 리뷰 runtime만 쓴다. 브랜치명은 소유권이 아니다. `vibe status`에 `design`이 있으면(이 checkout이 디자인 중) 커밋·push 전에 사용자에게 디자인이 끝났는지 묻고, 끝났으면 start-design 마감부터 한다 — 맡김은 디자인 변경을 건드리지 않고 주차한다.
3. 산출 문서는 spec/FORMAT.md 표기를 따른다. `vibe format --section task|state|ssot|report` 중 필요한 발췌만 보고 FORMAT 전체를 읽지 않는다. 규칙에 없는 표기는 만들지 않는다.
4. 질문·확인·보고는 cfg.lang 언어로, 상세도는 cfg.level대로. 선택지형 질문 도구(AskUserQuestion 등)가 있으면 사용. 맡김 모드(start-vibe)에서는 묻지 않는다 — 추천안으로 진행하고 STATE inbox와 보고서에 남긴다(되돌리기 어렵거나 프로젝트 밖에 영향을 주는 일은 주차). 권한 확인 창도 질문이다 — 창이 뜰 만한 명령은 실행하지 않고 주차한다(start-vibe 3절). 모드가 정해지지 않았으면 함께 모드다.
5. **읽기**: brief·status 요약을 먼저 쓰고 부족한 ID·섹션만 읽는다. 결정은 `vibe brief <T###|ID-n|ID@rev>`로 원문 블록째 받는다 — 끝의 `end` 줄이 없거나 complete:no면 빠진 부분부터 다시 읽고, unfollowed·related는 필요한 것만 연다. 직접 읽은 결정은 다음 결정 줄·제목까지 본 블록만 근거로 쓴다. STATE·FORMAT·ARCH·큰 코드 전체를 반복 읽지 않는다. tasks/done/은 특정 회귀·검증 근거만 선택 조회한다. 출력은 요약·tail, 전체 로그는 파일로 남긴다.

작업 묶음 워커에서 불렸으면 문서 쓰기는 `manage-work`가 반환한 group.path(기획·채번·문서 정리 위치)로 인계하고 워커 checkout의 STATE·SSOT는 바꾸지 않는다. 어느 checkout에서든 기획 쓰기·채번 전 `vibe plan-sync`, spec/만 담은 기획 커밋 직후 `vibe plan-push`(정본·거절 시 재채번은 FORMAT SETTINGS `plan`).

작업 묶음의 진행 상황은 공유 보드의 doing/blocked/ready/integrated를 사용한다. STATE에 todo로 남은 워커를 미착수로 서술하지 않는다.

## 1. 시작
STATE 읽기 → log에 `- YYMMDD create-narrative start` → 재료 읽기: ssot/*(결정·근거·제약·[?])와 STATE(현황·next·log), 그리고 활성 tasks/*(진행 중인 것). 완료 태스크는 일괄로 읽지 않는다 — ⑤ '지금'은 STATE와 log로 쓰고, 이야기가 되는 특정 마일스톤만 `tasks/done/`에서 골라 연다.
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
- STATE: log 1줄. ssot·tasks 테이블은 건드리지 않는다(narrative는 파생물). next도 유지.
