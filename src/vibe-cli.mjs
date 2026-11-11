import { vibeStatus, vibeSync, vibePush, vibeDeploy, vibeClaim, vibeBeat, vibeCheckpoint, vibePreflight, vibeAwake, vibeCheck, vibeMergeState } from './vibe.mjs'
import { vibePlanSync, vibePlanPush } from './vibe-plan.mjs'
import { vibeLoop } from './vibe-loop.mjs'
import { vibeCIWait } from './vibe-ci.mjs'
import { AB_STEPS } from './vibe-ab.mjs'
import { vibeBrief, vibeFormat } from './vibe-brief.mjs'
import { vibeDesign } from './vibe-design.mjs'
import { renderBrief } from './spec-context.mjs'
import { vibeSettings } from './settings.mjs'
import { vibePrune } from './prune.mjs'
import { vibeTask } from './vibe-task.mjs'
import { SkillPackageError } from './errors.mjs'

const HELP = `세션 도구 (start-vibe·start-design이 사용)
  vibe loop --tag <tag> --provider claude|codex [--model <name>] [--max-units 100] [--max-hours 8]
    [--final-reserve-hours <measured>] [--batch-size 3] [--permission-mode bypass|acceptEdits] [--allow-tool <rule> ...]
    [--verify <batch command> ...] [--push-each-unit] [--detach] [--dry-run] [--adapter <json-file>] [--notify-command <command>] [--json]
    [--tasks 'T001 T002'] [--timeout-ms 3600000]
                                                끝 예약(실측 전체 검증×2+수정 단위+CI)에는 새 단위 없이 마감 관문·수정 1회만
                                                --tasks: 그 태스크(와 이번 실행이 그것을 위해 만든 태스크)만, 끝나면 마감 관문
                                                --timeout-ms: 단위 하나의 상한(explore는 timebox+30분). 넘기면 미커밋 변경을
                                                스냅샷해 새 단위가 이어받고, 다시 넘기면 쪼개고, 그래도 넘기면 주차. loop는 계속
  vibe loop --tag <tag> --stop                  정지 파일 기록; 실행 중인 단위도 종료
  vibe loop --tag <tag> --stop-after-unit       현재 단위·마감 검증 완료 후 정지
  vibe loop --tag <tag> --configure --push-each-unit|--no-push-each-unit [--wait-ms <ms>]
                                                현재 단위 완료 후 같은 호스트에 설정 적용; receipt로 적용 확인
  vibe loop --tag <tag> --status               heartbeat·요청/적용 설정·운영 오류 확인
  vibe loop --tag <tag> --recover-metadata     종료된 호스트의 정확히 소유한 메타데이터만 복구; 작업 재시작 없음
  vibe ci wait [--commit HEAD] [--branch <branch>] [--repo owner/repo]
    [--diff-base <sha>] [--timeout-ms 3600000] [--no-run-ms 120000] [--poll-ms 15000]
  vibe brief <T###|ID-n|ID|ID@rev ...> [--ref <commit>] [--deep] [--diff-base <task-start-sha>] [--json]
                                                결정 원문 블록·필수 의존·전역 규칙·flow·constraints·stale base 이후 chg.
                                                기본은 작업 트리(미커밋 포함), --ref는 그 커밋만. 마크다운이 기본이고 끝에 end 줄
  vibe format --section task|state|ssot|report|reading  FORMAT 발췌만
  vibe status [--tag <tag>] [--no-fetch]        원격의 다른 세션·남은 일·추천 경로(route)
  vibe sync                                     원격 push 브랜치를 HEAD에 반영 (STATE는 섹션 단위 병합)
  vibe plan-sync                                기획 브랜치(SETTINGS plan, 미정이면 land)의 최신을 HEAD에 합침 — 기획·채번 전
  vibe plan-push [--commit <sha> ...]           spec/만 바꾼 기획 커밋(기본 HEAD)을 기획 브랜치에 올리고 다시 합침.
                                                원격에 그 브랜치가 있으면 push, 없으면 로컬 브랜치만. ID 충돌이면 거절
  vibe claim --tag <tag> [--task T###]            선점 정보만 원격 트리에 push; 미검증 로컬 코드는 보존
  vibe push [--wait-ci] [--diff-base <sha>] [--verified-commit <sha>]
                                                끝난 작업을 spec/SETTINGS.md land로 반영: push true면 sync 후 원격 push,
                                                false면 로컬 land 브랜치 병합, land-via pr이면 이 브랜치 push+PR. 할 일 없으면 none.
                                                verified-commit 이후 코드가 바뀌면 재검증 필요
  vibe deploy [--wait-ci]                       '배포해줘': deploy 브랜치를 land로 fast-forward (push true면 원격). 갈라졌으면 거절
  vibe beat --tag <tag> [--mode pair|autopilot] [--doing <T###|->] [--end]
                                                STATE ## active의 이 세션 행 쓰기·갱신·삭제 (커밋은 호출자)
  vibe task start T### --tag <tag>              단독 선점: 태스크·STATE 행·이 세션 active를 doing@날짜.tag로. todo·dep 완료만
  vibe task done T### --tag <tag> [--at <sha|ref>] [--force-other]
                                                done@날짜·tasks/done/ 이동·STATE 행 삭제·next·log (커밋은 호출자).
                                                acceptance 미체크·빈 result·다른 tag(--force-other는 사용자 지시 때만)면 거절
  vibe checkpoint --tag <tag> [--message <text>] 작업 트리 스냅샷을 wip/<tag>로 push (현재 브랜치는 그대로)
  vibe prune [--tag <tag>] [--work <name>]      마감 정리: 합쳐진 작업 묶음·단위의 worktree·브랜치, 이 세션의 wip/<tag>.
                                                spec/SETTINGS.md prune-branches가 false면 건너뜀. 안 합쳐진 커밋·미커밋 변경은 보존
  vibe settings [--set <key>=<value> ...]       spec/SETTINGS.md의 유효 설정(없으면 기본값) 보기·바꾸기 (커밋은 호출자)
  vibe design [start --tag <tag> [--scope <text>] | verify [--verify <command> ...] [--timeout-ms <ms>] | end]
                                                디자인 모드(start-design): 이 checkout의 Git 디렉터리에 디자인 중 상태 쓰기·전체 검증·삭제.
                                                STATE·다른 worktree는 건드리지 않음 (커밋은 호출자). verify는 ARCH task·batch 명령 전부를
                                                미커밋 작업 트리에서 한 번씩. 디자인 중 이 checkout의 push·맡김은 거절
  vibe ab start <slug> [--variants 2] [--base HEAD] [--base-port 4101] [--setup <install command>] [--copy <untracked file> ...]
  vibe ab run <slug> --variant <a|b|..> --prompt-file <file> [--provider auto|claude|codex] [--model <id>] [--allow-tool <rule> ...] [--permission-mode bypass|acceptEdits] [--timeout-ms 3600000]
  vibe ab serve <slug> --command '<dev server using $PORT>' [--variant <v>] [--ready-timeout-ms 120000]
  vibe ab exec <slug> --command '<measure or check>' [--repeat 1] [--variant <v>]
  vibe ab status <slug> | pick <slug> --variant <v> [--prune-branches] | stop <slug> [--remove] [--prune-branches]
                                                A/B 비교(show-ab): 변형마다 브랜치·형제 worktree·포트. 변형 세션은 그 worktree만 고치고
                                                커밋·서버·측정·정리는 CLI가 한다. pick은 그 변형만 현재 브랜치에 merge
  vibe preflight [--probe <command> [--provider claude|codex] [--allow-tool <rule> ...]]
                                                맡김 전 점검: push 권한·lint·절전 방지·CI 접근·헤드리스 워커 실측
  vibe awake [--hours <n>] | --stop             macOS caffeinate로 절전 방지
  vibe check [--tier task|batch] [--diff-base <task-start-sha>] [--task T###] [--timeout-ms <ms>] [--heavy] [--no-cache] [--allow-final] -- <command>
                                                batch/group은 조정자 전용·자동 heavy 락. --allow-final은 명시적 예외만
공통: --target <path>, --remote <name>. 출력은 JSON(brief만 기본 마크다운). check는 요약·실패 이름·마지막 8줄·전체 로그 경로만 출력.
`

const allowed = {
  loop: ['tag', 'provider', 'model', 'max-units', 'max-hours', 'final-reserve-hours', 'batch-size', 'permission-mode', 'allow-tool', 'verify', 'adapter', 'probe', 'probe-timeout-ms', 'timeout-ms', 'tasks', 'remote', 'wait-ms', 'notify-command'],
  ci: ['commit', 'branch', 'repo', 'diff-base', 'timeout-ms', 'no-run-ms', 'poll-ms', 'remote'], brief: ['task', 'diff-base', 'ref'], format: ['section'],
  status: ['tag', 'remote', 'section'], sync: ['remote'], 'plan-sync': ['remote'], 'plan-push': ['remote', 'commit'], push: ['remote', 'diff-base', 'timeout-ms', 'no-run-ms', 'verified-commit'], deploy: ['remote', 'timeout-ms', 'no-run-ms'], beat: ['tag', 'mode', 'doing', 'host'],
  claim: ['tag', 'task', 'remote'], task: ['tag', 'at'],
  checkpoint: ['tag', 'message', 'remote'], prune: ['tag', 'work', 'remote'], settings: ['set'], preflight: ['remote', 'probe', 'provider', 'allow-tool', 'probe-timeout-ms', 'probe-workspace', 'permission-mode'],
  awake: ['hours', 'remote'], check: ['tier', 'diff-base', 'task', 'timeout-ms'], design: ['tag', 'scope', 'verify', 'timeout-ms'],
  ab: ['variants', 'base', 'base-port', 'setup', 'copy', 'variant', 'prompt-file', 'provider', 'model', 'timeout-ms', 'allow-tool', 'permission-mode', 'command', 'ready-timeout-ms', 'repeat'],
}
const flags = { task: ['force-other'], loop: ['dry-run', 'detach', 'stop', 'stop-after-unit', 'configure', 'status', 'recover-metadata', 'push-each-unit', 'no-push-each-unit'], push: ['wait-ci'], deploy: ['wait-ci'], status: ['no-fetch'], beat: ['end'], awake: ['stop'], check: ['heavy', 'no-cache', 'allow-final'], brief: ['deep'], ab: ['remove', 'prune-branches'] }
const actions = { loop: vibeLoop, ci: vibeCIWait, brief: vibeBrief, format: vibeFormat, status: vibeStatus, sync: vibeSync, 'plan-sync': vibePlanSync, 'plan-push': vibePlanPush, push: vibePush, deploy: vibeDeploy, claim: vibeClaim, beat: vibeBeat, task: vibeTask, checkpoint: vibeCheckpoint, prune: vibePrune, settings: vibeSettings, preflight: vibePreflight, awake: vibeAwake, design: vibeDesign,
  ab: (options) => { if (!Object.hasOwn(AB_STEPS, options.step ?? '')) throw new SkillPackageError(`vibe ab <${Object.keys(AB_STEPS).join('|')}> <slug>`); return AB_STEPS[options.step](options) } }

export async function runVibeCLI(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return }
  const action = args.shift()
  // Git calls the merge driver with three file paths and reads the exit code.
  if (action === 'merge-state') {
    const result = await vibeMergeState(args)
    if (result.conflicts.length) { process.stderr.write(`STATE 충돌: ${result.conflicts.join(', ')}\n`); process.exitCode = 1 }
    return
  }
  if (!Object.hasOwn(allowed, action)) throw new SkillPackageError(`알 수 없는 vibe 명령: ${action}`)
  if (action === 'ci' && args.shift() !== 'wait') throw new SkillPackageError('vibe ci wait [옵션]')
  const options = {}
  if (action === 'brief') while (args[0] && !args[0].startsWith('--')) (options.roots ??= []).push(args.shift())
  if (action === 'design' && args[0] && !args[0].startsWith('--')) options.step = args.shift()
  if (action === 'task') { options.step = args.shift(); if (args[0] && !args[0].startsWith('--')) options.task = args.shift() }
  if (action === 'ab') { options.step = args.shift(); if (args[0] && !args[0].startsWith('--')) options.slug = args.shift() }
  let command = null
  while (args.length) {
    const argument = args.shift()
    if (argument === '--') { command = args.splice(0).join(' '); break }
    if (argument === '--json') { options.json = true; continue }
    const key = argument.slice(2)
    if (argument.startsWith('--') && flags[action]?.includes(key)) {
      if (key === 'no-push-each-unit') { options.pushEachUnit = false; continue }
      options[key === 'no-fetch' ? 'fetch' : key === 'no-cache' ? 'noCache' : key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = key === 'no-fetch' ? false : true
      continue
    }
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (!argument.startsWith('--') || !['target', ...allowed[action]].includes(name)) throw new SkillPackageError(`지원하지 않는 옵션: ${argument}`)
    const value = equals === -1 ? args.shift() : argument.slice(equals + 1)
    if (value === undefined || (value.startsWith('--') && name !== 'probe')) throw new SkillPackageError(`${argument} 값이 필요합니다.`)
    const field = name === 'target' ? 'targetRoot' : name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (['allow-tool', 'verify', 'copy', 'set'].includes(name) || (action === 'plan-push' && name === 'commit')) (options[field] ??= []).push(value)
    else options[field] = value
  }
  if (action === 'check') {
    process.exitCode = await vibeCheck(options, command)
    return
  }
  try {
    const result = await actions[action](options)
    // A brief is read by a model: markdown with an end line unless JSON is asked for.
    process.stdout.write(action === 'brief' && !options.json ? renderBrief(result) : `${JSON.stringify(result, null, 2)}\n`)
    if (result.ok === false || (action === 'brief' && result.complete === false)) process.exitCode = 1
  } catch (error) {
    if (!(error instanceof SkillPackageError)) throw error
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: error.message, details: error.details ?? [] }, null, 2)}\n`)
    process.exitCode = 1
  }
}
