# 기여하기

[README](README.ko.md) · [English README](README.md)

## 저장소 개발

스킬은 [Agent Skills 형식](https://agentskills.io/)을 따릅니다 — `skills/<name>/SKILL.md`(frontmatter `name`=폴더명·`description`), 선택 `references/`(필요할 때만 읽는 상세)·`assets/`·`scripts/`·`agents/openai.yaml`(Codex 전용).

```bash
npm install
npm test
npm run validate
npm run check
```

- `npm run validate`: 추가된 스킬의 구조와 frontmatter를 검사합니다. 개발 중에는 빈 `skills/`도 허용합니다.
- `npm run check`: 테스트, 스킬 검증, 실제 npm tarball에 포함될 파일을 함께 확인합니다.
- `npm run release:check`: 스킬이 하나 이상 있는지까지 검사합니다.
- `prepublishOnly`: 배포 직전에 `release:check`를 다시 실행합니다.

## 릴리스

`package.json`의 버전을 올려 `main`에 푸시하면 GitHub Actions(`release.yml`)가 npm에 자동 배포합니다. 이미 배포된 버전이면 배포를 건너뛰므로, 버전을 올리지 않은 일반 푸시는 안전합니다.

```bash
npm version patch   # 또는 minor / major — 버전 커밋과 태그가 함께 생성됩니다
git push origin main --follow-tags
```
