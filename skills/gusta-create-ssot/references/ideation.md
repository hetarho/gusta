# Ideation 전환 마감

ideation 문서는 gusta-sketch가 사용자가 아직 정하지 않은 구상을 남긴 기록이다. 그 채택 범위를 gusta-create-ssot·gusta-update-ssot가 반영했을 때만 수행한다. SSOT 승인·적용 뒤에 마감하며, 문서를 만들었다는 이유만으로 완료 처리하지 않는다.

1. 원본 문서의 채택 explored·shape·domains를 실제 SSOT 결정·제약과 대조한다. domains의 해당 줄 전체가 반영됐을 때만 `→<ID>`를 붙인다(여러 정본이면 각각 표시). 기존 화살표도 범위가 빠졌으면 완료 근거로 쓰지 않는다. 상태 없는 기존 domains 줄은 [o]로 취급한다.
2. 일부만 반영됐으면 문서·STATE를 `ready@YYMMDD`로 유지하고 남은 미반영 도메인의 gusta-create-ssot 또는 gusta-update-ssot를 next에 남긴다. 이번 도메인의 gusta-create-task도 유지한다.
3. 완료하려면 채택 domains가 하나 이상이고 모두 매핑돼야 하며, explored·domains의 [?]와 open 질문이 없어야 한다. 남은 질문은 해결해 본문에 반영하거나, 별도 활성 ideation 문서로 분리하고 원본에 제외 이유를 남긴다: explored는 `- [x] Deferred to ideation/<new-slug> ← <reason>`, domains는 `- [x] <ID candidate>: deferred to ideation/<new-slug> ← <reason>`. open은 질문이 없으면 `- -`. 임의로 버리거나 정해졌다고 간주하지 않는다.
4. 전체 반영을 확인하면 파일 st를 `converted@YYMMDD`로 바꾸고 `spec/ideation/done/<slug>.md`로 이동한다. 같은 이름이 있으면 덮어쓰지 않는다. STATE ideation 행을 제거하고, 그 문서의 낡은 next를 지우되 다른 작업·현재 gusta-create-task는 유지한다. log에 `- YYMMDD ideation <slug> converted` 한 줄을 남긴다. 파일 이동·STATE·SSOT를 같은 기획 커밋에 담는다.
5. inbox의 `ideation/<slug>`는 이동 후에도 유효하므로 유지한다. lint로 구조·매핑·상태·STATE 정합성을 확인한다. 의미상 전체 반영 여부는 1번 대조로 판단한다. 완료 문서는 과거 논의 기록이고 현재 규칙은 SSOT에 있다.

기존 converted 문서가 활성 디렉토리/STATE에 남아 있으면 같은 대조를 수행해 보관한다. 반영 누락·미정이 있으면 ready로 복구하고 남은 일을 next에 남긴다. 이전 FORMAT 프로젝트는 설치된 FORMAT의 ideation 골격·상태·읽기 규칙도 함께 이관한다.
