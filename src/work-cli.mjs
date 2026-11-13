import { workStatus, startWork, configureWork, claimWork, claimNextWork, updateWork, releaseWork, submitWork, integrateWork, finishWork, cleanupWork, recoverWork, workBoard, workHistory, syncWork, unlockWork, workBrief } from './work-groups.mjs'
import { finishReview, releaseReview, updateReview, resumeWork } from './work-review.mjs'
import { nextWork, claimReviewWaiting } from './work-wait.mjs'
import { workRun, recoverRunner } from './work-runner.mjs'
import { workDoctor } from './work-providers.mjs'
import { workScout } from './work-scout.mjs'
import { SkillPackageError } from './errors.mjs'

const HELP = `작업 묶음 (Orca 등 외부 도구 없이도 사용 가능)
  work start <name> [--workspace auto|current|new] [--base <ref>] [--branch <branch>] [--path <path>]
    [--task-verify <command>] [--verify <command>] [--group-verify <command>]
    [--tasks <approved task IDs>] [--push <branch>|-] [--remote <name>] [--review risky|all] [--review-path <path> ...] [--review-lines <n>] [--allow-tool <rule> ...]
  work configure --work <name> [start의 검증·push·review·allow-tool 옵션]
  work claim <T###> --work <name> [--workspace auto|current|new] [--path <path>] [--owner <label>]
  work claim-next --work <name> --owner <label> [--workspace auto|current|new]
  work next --owner <label> [--work <name> | --start] [--wait <seconds>] [--workspace auto|current|new] [--coordinator] [--autopilot]
  work resume --work <name> --owner <label> [--attempt <id>]
  work review-claim --work <name> --owner <label> [--attempt <id>] [--wait <seconds>]
  work review-finish --review <id> --result-file <json-file>
  work review-update --review <id>
  work review-release --review <id> [--reason <text>]
  work doctor
  work run --work <name> [--provider auto|codex|claude | --providers codex,claude | --adapter <json-file>] --verify <command>
    [--task-verify <command>] [--group-verify <command>]
    [--reviewer-provider codex|claude] [--model <id>] [--reviewer-model <id>] [--effort <level>] [--dry-run]
                                    auto(기본): dispatch마다 그 태스크의 run:을 SETTINGS agents 안에서 배정(리뷰어는 워커 능력 이상·다른 도구 먼저).
                                    agents 미정이면 needs-init. --provider/--providers/--reviewer-provider는 그 도구로 고정
    [--timeout-ms <ms>] [--max-dispatches <n>] [--max-task-runs <n>]
    [--autopilot] [--decision-wait-ms <ms>] [--checkpoint-ms <ms>] [--permission-mode bypass|acceptEdits] [--detach]
  work run --work <name> (--status | --stop)   --detach는 분리된 호스트로 시작해 {runId,pid,log}만 반환. --status는 파일만 읽어
                                    호스트 생존·dispatch 로그 경로·종료 결과 요약을, --stop은 호스트에 정상 종료 신호(SIGTERM)를 보낸다
  work runner-recover --work <name>
  work scout --prompt-file <file> [--provider auto|codex|claude] [--model <id>] [--timeout-ms 900000]
                                    읽기 전용 헤드리스 탐색 세션 1개 — 제안 JSON만 반환(오케스트레이터는 코드를 직접 읽지 않는다)
  work status [--work <name>] [--details]     기본은 소유권·현재 태스크 요약; 전체 기록은 --details
  work board --work <name>
  work brief --attempt <id>
  work history --work <name> [--task <T###>]
  work sync --work <name>
  work update --attempt <id> [--status doing|blocked] [--reason <text>] [--decision-file <json>] [--note <text>]
  work submit --attempt <id> [--verify <command> ...]
  work integrate --attempt <id> [--verify <command> ...] [--auto-correct]
  work finish --work <name> [--verify <command> ...]
  work release --attempt <id> [--reason <text>]
  work cleanup --attempt <id>                  prune-branches(기본 true)면 합쳐진 단위 브랜치·ignored 산출물·후보 공간까지 삭제
  work recover (--attempt <id> | --work <name>)
  work unlock --lock-id <id>

start 배정 한도: --workers <n> (4), --reviewers <n> (1), --max-pending <n> (8).\n공통: --target <path>, --json. 생성·통합 명령은 로컬 Git을 변경하며 원격 push는 --push <branch>가 있을 때만 통합 단위마다 합니다.
auto: 배정 가능한 기존 linked worktree는 연결하고, 기획 공간에서는 새 worktree를 생성합니다.
current: 현재 checkout을 사용합니다. new: 항상 별도 worktree를 만듭니다.
lane: 같은 lane의 태스크는 한 작업 공간에서 순서대로 구현하고 함께 리뷰·통합합니다.
push: 통합된 단위마다 그 브랜치로 push합니다(원격이 앞서 있으면 후보에서 먼저 합칩니다).
review: risky(기본)는 위험한 단위만 리뷰하고 나머지는 정책 승인합니다. all은 모든 단위를 리뷰합니다.
explore 태스크와 그 후속은 배정하지 않습니다 — 메인 세션에서 단독으로 진행합니다.
검증 단계: submit=태스크(선택, 변경 영향) · integrate=단위 통합 · finish=묶음 완료. start/configure가 저장한
  --task-verify/--verify/--group-verify를 기본값으로 쓰며, 명령에는 GUSTA_TIER·GUSTA_DIFF_BASE·GUSTA_TASK(S)가 전달됩니다.
next: 세션 루프. 자기 단위 → 수정 요청 → 리뷰 → 다음 단위 순으로 action(implement|review|blocked|wait|complete|stalled)을
  반환하고, 승인된 단위의 통합과 묶음 완료 검증은 백그라운드 CLI로 시작합니다. --start는 활성 묶음이 없으면 새로 만듭니다.
submit/integrate/finish: 지정한 검증 명령을 셸로 실행합니다(--verify-timeout-ms, 기본 1시간). 워커 변경은 먼저 커밋하세요.
next/review-claim --wait: 배정이 생길 때까지 모델 호출 없이 기다립니다. complete·stalled·timeout이면 반환합니다.
맡김(--autopilot): 기획 결정이 필요한 워커는 결정 요청을 남기고(update --decision-file) 다음 일로 갑니다. 조정자(next --coordinator)가
  decide를 받아 잠정 결정한 뒤 update --status doing --note로 재개하면, 실행기는 기획 브랜치를 합치고 같은 세션을 이어 실행합니다.
release/recover: 기존 작업자·명령이 종료됐음을 확인한 뒤 실행하세요. TTL 자동 회수는 없습니다.
`

// No output carries log content: a dispatch names its log file. Records written before the runner
// stopped keeping an adapter stderr tail still hold one, so it is dropped here for every action.
const withoutLogs = (key, value) => key === 'dispatch' && value && typeof value === 'object' && Object.hasOwn(value, 'stderr') ? (({ stderr, ...rest }) => rest)(value) : value

const POLICY = ['push', 'remote', 'review', 'review-path', 'review-lines', 'allow-tool']
const LISTS = ['verify', 'task-verify', 'group-verify', 'review-path', 'allow-tool']
const allowed = {
  start: ['workspace', 'base', 'branch', 'path', 'workers', 'reviewers', 'max-pending', 'tasks', 'task-verify', 'verify', 'group-verify', ...POLICY],
  configure: ['work', 'tasks', 'task-verify', 'verify', 'group-verify', ...POLICY], claim: ['work', 'workspace', 'path', 'owner'],
  'claim-next': ['work', 'owner', 'workspace', 'path'], next: ['work', 'owner', 'workspace', 'path', 'wait', 'workers', 'reviewers', 'max-pending', 'task-verify', 'verify', 'group-verify', ...POLICY], resume: ['work', 'owner', 'attempt'],
  'review-claim': ['work', 'owner', 'attempt', 'wait'], 'review-finish': ['review', 'result-file'],
  'review-update': ['review'], 'review-release': ['review', 'reason'],
  doctor: [], run: ['work', 'adapter', 'verify', 'task-verify', 'group-verify', 'verify-timeout-ms', 'provider', 'providers', 'reviewer-provider', 'model', 'reviewer-model', 'effort', 'timeout-ms', 'max-dispatches', 'max-task-runs', 'decision-wait-ms', 'checkpoint-ms', 'permission-mode'], 'runner-recover': ['work'],
  scout: ['prompt-file', 'provider', 'model', 'timeout-ms'],
  history: ['work', 'task'], sync: ['work'],
  status: ['work'], board: ['work'], brief: ['attempt'], update: ['attempt', 'status', 'reason', 'decision-file', 'note'],
  submit: ['attempt', 'verify', 'verify-timeout-ms'], integrate: ['attempt', 'verify', 'verify-timeout-ms'], finish: ['work', 'verify', 'verify-timeout-ms'], release: ['attempt', 'reason'],
  cleanup: ['attempt'], recover: ['attempt', 'work'], unlock: ['lock-id'],
}
const actions = { doctor: workDoctor, configure: configureWork, 'claim-next': claimNextWork, next: nextWork, resume: resumeWork, 'review-claim': claimReviewWaiting, 'review-finish': finishReview,
  'review-update': updateReview, 'review-release': releaseReview, run: workRun, 'runner-recover': recoverRunner, scout: workScout, start: startWork, claim: claimWork, status: workStatus, board: workBoard,
  history: workHistory, sync: syncWork, brief: workBrief, update: updateWork, submit: submitWork, integrate: integrateWork, finish: finishWork, release: releaseWork,
  cleanup: cleanupWork, recover: recoverWork, unlock: unlockWork }

async function dispatch(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return }
  const action = args.shift()
  if (!Object.hasOwn(actions, action)) throw new SkillPackageError(`알 수 없는 work 명령: ${action}`)
  const options = {}
  if (['start', 'claim'].includes(action)) {
    if (!args[0] || args[0].startsWith('-')) throw new SkillPackageError(`${action} 대상이 필요합니다.`)
    options[action === 'start' ? 'name' : 'task'] = args.shift()
  }
  while (args.length) {
    const argument = args.shift()
    if (argument === '--dry-run' && action === 'run') { options.dryRun = true; continue }
    if (argument === '--details' && action === 'status') { options.details = true; continue }
    if (['--detach', '--status', '--stop'].includes(argument) && action === 'run') { options[argument.slice(2)] = true; continue }
    if (argument === '--start' && action === 'next') { options.start = true; continue }
    if (argument === '--coordinator' && action === 'next') { options.coordinator = true; continue }
    if (argument === '--autopilot' && ['next', 'run'].includes(action)) { options.autopilot = true; continue }
    if (argument === '--auto-correct' && action === 'integrate') { options.autoCorrect = true; continue }
    if (argument === '--json') { options.json = true; continue }
    const equals = argument.indexOf('=')
    const key = argument.slice(2, equals === -1 ? undefined : equals)
    if (!argument.startsWith('--') || !['target', ...allowed[action]].includes(key)) throw new SkillPackageError(`지원하지 않는 옵션: ${argument}`)
    const value = equals === -1 ? args.shift() : argument.slice(equals + 1)
    if (!value || value.startsWith('--')) throw new SkillPackageError(`${argument} 값이 필요합니다.`)
    const field = key === 'target' ? 'targetRoot' : key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    if (LISTS.includes(key)) (options[field] ??= []).push(value)
    else options[field] = value
  }
  const result = await actions[action](options)
  process.stdout.write(`${JSON.stringify(result, withoutLogs, 2)}\n`)
  if (result.ok === false) process.exitCode = 1
}

export async function runWorkCLI(args) {
  const json = args.includes('--json')
  try { await dispatch(args) } catch (error) {
    if (!json) throw error
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: error.message, details: error.details ?? [] }, null, 2)}\n`)
    process.exitCode = 1
  }
}
