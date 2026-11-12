#!/usr/bin/env node

import { checkSkills, discoverSkills, installSkills, lintSpec, inspectWorkspace, readTaskBoard, SkillPackageError } from '../src/index.mjs'
import { getPackageInfo } from '../src/package-info.mjs'
import { runWorkCLI } from '../src/work-cli.mjs'
import { runVibeCLI } from '../src/vibe-cli.mjs'
import { inspectWork } from '../src/work-groups.mjs'
import { migrateSpec, packageVersions } from '../src/migrate.mjs'
import { upgradeContext } from '../src/upgrade-context.mjs'

const HELP = `haeram-spec-creator

사용법:
  haeram-spec-creator list
  haeram-spec-creator validate [--allow-empty]
  haeram-spec-creator install [--target <path>] [--agent both|claude|codex] [--dry-run] [--force]
  haeram-spec-creator check [--target <path>] [--agent both|claude|codex]
  haeram-spec-creator lint [--target <path>] [--hints]
  haeram-spec-creator outdated [--target <path>]   설치 버전(lock)·실행 버전·npm 최신 버전 (JSON)
  haeram-spec-creator upgrade-context [--target <path>] [--offset <n>] [--limit <n>] [--snapshot <sha256>]
                                 업데이트 전 전체 문서·지침·설정 inventory (읽기 전용 JSON, 의미 판단은 별도)
  haeram-spec-creator migrate [--target <path>] [--dry-run]
                                 spec/ 구조 변경 이관(예: STATE cfg push/plan → SETTINGS.md) 뒤 FORMAT 차이·미정 설정·lint 보고 (JSON)
  haeram-spec-creator context [--target <path>] [--json]
  haeram-spec-creator board [--target <path>] [--json]
  haeram-spec-creator work <start|claim|status|board|update|submit|integrate|release|cleanup|recover|unlock> ...
  haeram-spec-creator work --help
  haeram-spec-creator vibe <status|sync|plan-sync|plan-push|push|beat|checkpoint|design|preflight|awake|check> ...  (start-vibe·start-design 세션 도구, vibe --help)

옵션:
  --target <path>  설치·검사·조회할 프로젝트 (기본값: 현재 폴더)
  --agent <name>   claude, codex 또는 both (기본값: both)
  --dry-run        파일을 바꾸지 않고 설치 계획만 출력
  --force          충돌한 로컬 파일을 패키지 버전으로 교체
  --allow-empty    validate에서 빈 skills/ 폴더 허용
  --hints          lint의 검토 후보를 전부 출력 (기본: 앞 10건)
  --json           context/board의 기계 판독용 JSON 출력 (upgrade-context는 항상 JSON)
  -h, --help       도움말
  -v, --version    버전
`

const HINT_PREVIEW = 10

function takeValue(args, index, option) {
  const argument = args[index]
  if (argument.includes('=')) return { value: argument.slice(argument.indexOf('=') + 1), consumed: 0 }
  const value = args[index + 1]
  if (!value || value.startsWith('-')) throw new SkillPackageError(`${option} 값이 필요합니다.`)
  return { value, consumed: 1 }
}

function parseOptions(args, command) {
  const options = { agents: ['claude', 'codex'] }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '-h' || argument === '--help') options.help = true
    else if (argument === '-v' || argument === '--version') options.version = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--force') options.force = true
    else if (argument === '--allow-empty') options.allowEmpty = true
    else if (argument === '--hints') options.hints = true
    else if (argument === '--json') options.json = true
    else if (command === 'upgrade-context' && /^(--offset|--limit|--snapshot)(=|$)/.test(argument)) {
      const option = argument.split('=')[0]
      const { value, consumed } = takeValue(args, index, option)
      options[option.slice(2)] = value
      index += consumed
    }
    else if (argument === '--target' || argument.startsWith('--target=')) {
      const { value, consumed } = takeValue(args, index, '--target')
      options.targetRoot = value
      index += consumed
    } else if (argument === '--agent' || argument.startsWith('--agent=')) {
      const { value, consumed } = takeValue(args, index, '--agent')
      if (!['both', 'claude', 'codex'].includes(value)) {
        throw new SkillPackageError(`--agent는 both, claude, codex 중 하나여야 합니다: ${value}`)
      }
      options.agents = value === 'both' ? ['claude', 'codex'] : [value]
      index += consumed
    } else {
      throw new SkillPackageError(`알 수 없는 옵션입니다: ${argument}`)
    }
  }

  return options
}

function printCounts(result) {
  const label = result.dryRun ? '설치 계획' : '설치 완료'
  process.stdout.write(
    `${label}: 생성 ${result.counts.create}, 갱신 ${result.counts.update}, 제거 ${result.counts.remove}, 동일 ${result.counts.unchanged}\n`,
  )
  process.stdout.write(`대상: ${result.targetRoot}\n`)
  process.stdout.write(`에이전트: ${result.agents.join(', ')}\n`)
  process.stdout.write(`스킬: ${result.skillNames.join(', ')}\n`)
}

async function main() {
  const rawArgs = process.argv.slice(2)
  const command = rawArgs[0] && !rawArgs[0].startsWith('-') ? rawArgs.shift() : undefined
  if (command === 'work') return runWorkCLI(rawArgs)
  if (command === 'vibe') return runVibeCLI(rawArgs)
  const options = parseOptions(rawArgs, command)

  if (options.version || command === 'version') {
    const info = await getPackageInfo()
    process.stdout.write(`${info.version}\n`)
    return
  }
  if (options.help || !command || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (['migrate', 'outdated'].includes(command)) {
    const result = command === 'migrate' ? await migrateSpec(options) : await packageVersions(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.ok === false || (result.lint && !result.lint.ok)) process.exitCode = 1
    return
  }
  if (command === 'upgrade-context') {
    const result = await upgradeContext(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
    return
  }
  if (options.json && !['context', 'board'].includes(command)) {
    throw new SkillPackageError('--json은 context/board에서만 지원합니다.')
  }

  if (command === 'context') {
    const result = await inspectWorkspace(options)
    result.work = await inspectWork(options)
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`대상: ${result.targetRoot}\n`)
      if (result.git) {
        const git = result.git
        process.stdout.write(`Checkout: ${git.root}\nBranch: ${git.branch ?? '(detached)'}\nHEAD: ${git.head ?? '(첫 커밋 전)'}\n`)
        process.stdout.write(`Git common dir: ${git.commonDir}\nLinked worktree: ${git.isLinkedWorktree}\n`)
        for (const tree of git.worktrees) process.stdout.write(`  ${JSON.stringify(tree.path)} (${tree.branch ?? (tree.bare ? 'bare' : 'detached')})\n`)
      }
      for (const warning of result.warnings) process.stdout.write(`안내: ${warning}\n`)
      process.stdout.write(`작업 모드: ${result.work.mode}\n`)
    }
    return
  }

  if (command === 'board') {
    const result = await readTaskBoard(options)
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    else {
      process.stdout.write(`태스크 보드 (현재 checkout): ${result.root}\n`)
      process.stdout.write('파일 기준 조회입니다. dep 충족은 선점 권한·SSOT 신선도·다른 브랜치의 통합 완료를 보장하지 않습니다.\n')
      for (const task of result.tasks) {
        const dep = task.dependencyReady ? 'dep 충족' : task.waitingOn.length ? `dep 대기: ${task.waitingOn.join(', ')}` : '-'
        process.stdout.write(`${task.id}\t${task.st ?? '?'}\t${dep}\t${task.title}\n`)
      }
      process.stdout.write(`남은 task ${result.tasks.length}개, 완료 파일 ID ${result.doneIds.length}개\n`)
      for (const warning of result.warnings) process.stdout.write(`경고: ${warning}\n`)
      for (const error of result.errors) process.stderr.write(`오류: ${error}\n`)
    }
    if (!result.ok) process.exitCode = 1
    return
  }

  if (command === 'list') {
    const skills = await discoverSkills({ allowEmpty: true })
    if (skills.length === 0) process.stdout.write('등록된 스킬이 없습니다.\n')
    else {
      for (const skill of skills) {
        process.stdout.write(`${skill.name}\t${skill.metadata.description}\n`)
      }
    }
    return
  }

  if (command === 'validate') {
    const skills = await discoverSkills({ allowEmpty: options.allowEmpty })
    process.stdout.write(`스킬 검증 완료: ${skills.length}개\n`)
    return
  }

  if (command === 'install') {
    const result = await installSkills(options)
    printCounts(result)
    return
  }

  if (command === 'check') {
    const result = await checkSkills(options)
    if (!result.ok) {
      throw new SkillPackageError(
        '설치된 스킬이 패키지와 일치하지 않습니다.',
        result.mismatches.map(({ type, relativePath }) => `${type}: ${relativePath}`),
      )
    }
    process.stdout.write(
      `스킬 동기화 상태 정상: ${result.skillNames.length}개 (${result.agents.join(', ')})\n`,
    )
    return
  }

  if (command === 'lint') {
    const result = await lintSpec(options)
    for (const warning of result.warnings) process.stdout.write(`경고: ${warning}\n`)
    // 검토 후보는 구조 위반이 아니라 doc-review가 판단할 의미 품질 신호다 — 종료 코드에 영향을 주지 않는다.
    const shown = options.hints ? result.reviewHints : result.reviewHints.slice(0, HINT_PREVIEW)
    for (const hint of shown) process.stdout.write(`검토 후보: ${hint}\n`)
    if (result.reviewHints.length > shown.length) {
      process.stdout.write(
        `검토 후보: … 외 ${result.reviewHints.length - shown.length}건 — 전체는 lint --hints, 정리는 doc-review\n`,
      )
    }
    if (!result.ok) throw new SkillPackageError('spec/ 문서가 FORMAT 불변식을 위반합니다.', result.errors)
    const notes = [
      result.warnings.length > 0 ? `경고 ${result.warnings.length}건` : null,
      result.reviewHints.length > 0 ? `검토 후보 ${result.reviewHints.length}건` : null,
    ].filter(Boolean)
    const note = notes.length > 0 ? ` (${notes.join(', ')})` : ''
    process.stdout.write(`spec 정합성 정상: ssot ${result.counts.ssot}개, 남은 task ${result.counts.tasks}개, 완료 ${result.counts.done}개${note}\n`)
    return
  }

  throw new SkillPackageError(`알 수 없는 명령입니다: ${command}`)
}

main().catch((error) => {
  if (error instanceof SkillPackageError) {
    process.stderr.write(`오류: ${error.message}\n`)
    for (const detail of error.details) process.stderr.write(`  - ${detail}\n`)
  } else {
    process.stderr.write(`${error.stack ?? error.message}\n`)
  }
  process.exitCode = 1
})
