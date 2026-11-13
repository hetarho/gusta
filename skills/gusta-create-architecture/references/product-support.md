# 제품 단계와 지원 범위 정하기

처음 기획하거나 단계·지원 범위를 바꿀 때만 읽는다. sketch가 실제 사용자·제품 목적·필수 플랫폼을 확인해 아래 추천과 제외 범위·이유를 한 번 제시하고 사용자가 고른다. architecture가 ARCH의 제품 결정 한 블록에 기록한다. 기존 승인 정책은 재사용하고 버전 번호로 단계를 추측하지 않는다. 기존 제품을 Prototype로 낮추거나 이미 약속한 플랫폼·버전을 조용히 제외하지 않는다.

| product-stage | 처음 제시할 지원 추천 | 다음 검토 |
|---|---|---|
| prototype | 아이디어 확인에 필요한 주 환경. 웹은 최신 안정 Chrome, 앱은 선택한 주 플랫폼의 최신 안정 OS와 현재 앱 클라이언트 | Alpha/Beta 진입 또는 첫 외부 사용자 전 |
| alpha | 내부 사용의 같은 좁은 기준선. 다른 브라우저·구형 OS·이전 앱 버전의 호환 행렬은 기본 제외 | Beta/외부 사용자 전 |
| beta | 실제 외부 사용자 환경과 약속을 보고 지원 목록·버전 범위를 선택 | 출시 전 |
| production | 합의한 지원 기간·버전 범위와 변경/이행 정책 유지 | 합의한 주기·플랫폼 변경 |

추천은 실제 제품 대상에만 적용한다. API/CLI에 브라우저를 추가하지 않고, 사용자가 이미 여러 플랫폼을 요구했으면 보존한다. Prototype·Alpha의 주 환경 기능은 작은 영향 검사와 agent AC로 확인하되 광범위 호환 행렬을 만들지 않는다. Beta·Production도 브라우저 수를 자동 늘리지 않는다. 필요한 호환 검사는 선언한 범위만 CI로 보내고 agent가 대체한 E2E를 다시 더하지 않는다. 실제 데이터·보호 계약의 필수 검증은 단계와 함께 유지한다.

`latest stable`은 지원 창이며 실제 숫자가 아니다. OS/런타임 버전과 앱 클라이언트 호환 버전을 따로 정한다. 계획·설정 때 설치 도구/공식 자료로 실제 버전을 확인하고 검수 전에 기준선을 고정한다. 한 통합 후보 검수 중에는 최신을 다시 해석하지 않는다. 확인 못 한 버전은 미확인으로 남긴다. 검토 시점은 단계 전환·첫 외부 사용자·출시·플랫폼 변경 또는 사용자가 준 날짜로 정하며 날짜를 만들어 내거나 태스크마다 다시 묻지 않는다.

## ARCH 기록

현재 `## decisions`의 `[o]` 제품 결정 한 블록에 아래 하위 키를 쓴다. 미정 선택은 `[?]`로 두며 구현 전 최초 추천·선택을 마친다. SETTINGS에 복제하지 않는다. 지원하지 않는 항목도 `none`과 이유로 명시한다. 예시 값 대신 실제로 선택한 범위를 쓴다.

```markdown
- ARCH-1 [o] Product stage and support scope
  - product-stage: <prototype|alpha|beta|production>
  - supported-browsers: <supported browser/version window, or none>
  - supported-platforms: <selected platforms and OS/runtime version windows>
  - supported-app-versions: <app client compatibility window, or none>
  - excluded-support: <explicitly excluded environments and versions>
  - support-review: <agreed milestone or supplied date>
  - validation-baseline: <resolved environment versions and observation date; unresolved until checked>
```

사용자 발언이 이미 정한 단계·범위는 결정으로 받아 재질문하지 않는다. `gusta-init`은 이 추천을 sketch/architecture로 연결하며 제품 결정을 직접 쓰지 않는다. `gusta-start`는 승인된 범위로 시작하고 미정 정책을 임의 축소하지 않는다. `gusta-update`는 이 현재 결정과 실제 테스트·CI 행렬을 대조해 범위 밖 비용과 미확인을 보여 준다. 감사 출력의 추천·후보는 승인이나 의미 검토 완료가 아니다.
