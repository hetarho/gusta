import { vibeStatus, vibeSync, vibePush, vibeDeploy, vibeClaim, vibeBeat, vibeCheckpoint, vibePreflight, vibeAwake, vibeCheck, vibeMergeState } from './vibe.mjs'
import { vibePlanSync, vibePlanPush } from './vibe-plan.mjs'
import { vibeLoop } from './vibe-loop.mjs'
import { vibeCIWait } from './vibe-ci.mjs'
import { AB_STEPS } from './vibe-ab.mjs'
import { SKETCH_STEPS, renderSketch } from './vibe-sketch.mjs'
import { vibeBrief, vibeFormat, renderBriefView } from './vibe-brief.mjs'
import { vibeDesign } from './vibe-design.mjs'
import { renderBrief } from './spec-context.mjs'
import { vibeSettings } from './settings.mjs'
import { vibePrune } from './prune.mjs'
import { vibeTask } from './vibe-task.mjs'
import { vibeInbox, vibeLog } from './vibe-inbox.mjs'
import { vibeUsage } from './native-usage.mjs'
import { SkillPackageError } from './errors.mjs'
import { vibeIntegration, openSessionWorkspace } from './integration-run.mjs'

const HELP = `세션 도구 (gusta-start·gusta-design-mode가 사용)
  vibe session open --kind start|self-improve|self-improve-remote --tag <tag> [--from-head]
                                                전용 하위 브랜치·worktree를 준비하고 root를 반환. 계획·구현은 그 경로에서만.
                                                같은 checkout에서 같은 kind·tag로 다시 열면 그 세션을 created:false로 돌려준다.
                                                원래 checkout에 미커밋 변경이 있으면 거절, --from-head면 HEAD에서 열고 빠진 파일을 excluded로
  vibe integration status|ready|finish --tag <tag> [--token <token>] [--no-push] [--verify <command> ...]
                                                살아 있는 참여 세션의 준비 뒤 고정 후보에서 전체 검수 한 번. 늦은 세션은 다음 통합.
                                                head가 이미 land에 있는 다른 ready 세션은 landed(관문 밖·미검증)로 기록하고 검수에서 뺀다.
                                                finish --no-push: 검수 뒤 로컬 land에만 반영(held). 다음 finish·push가 검증된 그대로 발행
                                                --verify: 후보에서 함께 돌릴 이 세션의 명령. 이 기기에만 있는 경로(홈·임시·npx 캐시)는 거절,
                                                저장소 기준 상대 경로나 설치된 명령으로. 대상 스크립트·패키지가 없으면 환경 실패
  vibe integration close --tag <tag> [--reason <text>]
                                                이 checkout 세션의 참여 닫기(vibe beat --end가 함께 한다): 변경 없으면 withdrawn, 있으면 paused
  vibe integration withdraw --participant <id> [--reason <text>]
                                                소유자의 명시적 참여 중단(끝났지만 ready를 내지 않을 세션, 관문 밖에서 반영된 세션). 브랜치·head는 그대로,
                                                head가 이미 land에 있으면 landed(관문 밖·미검증)로 기록. 그 worktree의 ready가 다시 참여시킨다
  vibe integration accept --file <JSON>       computer-use 호스트의 정확한 후보별 AC 관측·증거 제출; finish는 전체 검수 없이 재개
  vibe integration repair --token <token> --target <candidate worktree>
                                                실패·영향 범위만 수정해 커밋한 후보. 원래 cohort·마감과 성공 캐시 유지
  vibe integration abandon --token <token> [--reason <text>]
                                                이 cohort로 고칠 수 없는 실패·충돌 관문을 기록(history)으로 옮겨 새 통합을 연다. 영수증·성공 캐시 유지.
                                                마감이 지난 실패 관문은 다음 finish·withdraw·plan-push가 expired로 옮긴다
  vibe loop --tag <tag> [--max-units 100] [--max-hours 8]
    [--deadline <ISO>] [--final-reserve-hours <measured>] [--batch-size 3] [--permission-mode bypass|acceptEdits] [--allow-tool <rule> ...]
    [--verify <batch command> ...] [--push-each-unit] [--detach] [--dry-run] [--adapter <json-file>] [--notify-command <command>] [--json]
    [--tasks 'T001 T002' | --request-file <path>] [--timeout-ms 3600000] [--provider claude|codex [--model <name>]] [--effort low|medium|high|xhigh|max|ultra]
                                                단위마다 도구·모델·에포트를 CLI가 정한다: 태스크 run:을 SETTINGS agents 안에서(못 쓰면 score가
                                                가장 가까운 조합, 없으면 agents 첫 도구의 기본 설정), 회복·수정 단위는 그보다 낮추지 않음. dry-run의 routing이
                                                태스크별 배정. --provider/--model/--effort는 사람이 실행 전체를 고정할 때만. agents 미정이면 needs-init
                                                사용량·속도 한도·과부하·로그인 실패는 단위로 세지 않고 agents 안 다음 조합으로 같은 태스크를 다시. 모두 막히면
                                                첫 리셋이 작업 시간 안이면 모델 호출 없이 대기, 아니면 reason usage-limit(hint에 도구·리셋 시각)
                                                끝 예약(실측 전체 검증+영향 범위 수정 단위+CI)에는 새 단위 없이 공유 통합 관문·수정
                                                --tasks: 그 태스크(와 이번 실행이 그것을 위해 만든 태스크)만, 끝나면 마감 관문
                                                --request-file <path>: 그 요청을 첫 단위가 기획(SSOT·태스크·plan-push)하고, 만든 태스크와 그 dep만 실행
                                                기존 --push-each-unit도 통합 대상 반영은 세션 전체의 공유 마감까지 보류한다
                                                --timeout-ms: 단위 하나의 상한(explore는 timebox+30분). 넘기거나 단위가 continue로
                                                끝나면 새 단위가 이어받고, 다시 그러면 쪼개고, 그래도 안 끝나면 주차. loop는 계속
                                                단위가 남긴 미커밋 변경은 결과와 무관하게 스냅샷(refs/gusta/units)으로 넘긴다
  vibe loop --tag <tag> --stop                  정지 파일 기록; 실행 중인 단위도 종료
  vibe loop --tag <tag> --stop-after-unit       현재 단위·마감 검증 완료 후 정지
  vibe loop --tag <tag> --configure [--deadline <ISO>] [--final-reserve-hours <n>] [--push-each-unit|--no-push-each-unit] [--wait-ms <ms>]
                                                현재 단위 완료 후 같은 호스트에 설정 적용; receipt로 적용 확인
  vibe loop --tag <tag> --status               heartbeat·요청/적용 설정·운영 오류 확인
  vibe loop --tag <tag> --wait-event unit-finished,needs-judgment,finished [--after <cursor>] [--run <runId>] [--wait-ms 3300000]
                                                모델 호출 없이 그 사건(또는 종료·대기 끝)까지 기다려 사건 한 줄과 cursor를 돌려준다.
                                                진행 보고: 백그라운드로 걸어 두고, 돌아올 때마다 한 줄 보고 후 --after <cursor>로 다시 건다
                                                현재 run(--run: detach 출력의 runId, 없으면 loop.json의 run)의 사건만 센다
  vibe loop --tag <tag> --recover-metadata     종료된 호스트의 정확히 소유한 메타데이터만 복구; 작업 재시작 없음
  vibe ci wait [--commit HEAD] [--branch <branch>] [--repo owner/repo]
    [--diff-base <sha>] [--timeout-ms 3600000] [--no-run-ms 120000] [--poll-ms 15000]
                                                실행이 보이지 않으면 통과가 아니라 unchecked(no-run-within-grace). 공개 페이지로만 읽으면 기본 대기 10분
  vibe brief <T###|ID-n|ID|ID@rev ...> [--ref <commit>] [--deep] [--diff-base <task-start-sha>] [--json]
    [--summary | --section tasks|decisions|sections|history|refs|referrers|inbox|issues|guidance] [--offset <n>] [--limit 20] [--snapshot <sha256>]
                                                결정 원문 블록·필수 의존·전역 규칙·flow·constraints·stale base 이후 chg.
                                                기본은 작업 트리(미커밋 포함), --ref는 그 커밋만. 마크다운이 기본이고 끝에 end 줄
  vibe format --section task|state|ssot|report|ideation|reading|settings  FORMAT 발췌만
  vibe status [--tag <tag>] [--no-fetch] [--section inbox]
                                                다른 세션(브랜치·커밋·pushed: 그 커밋이 원격에 있는지)·남은 일·추천 경로(route).
                                                조정 브랜치(SETTINGS coord, 기본 gusta)를 원격과 맞춘 뒤 읽고, STATE에 남은 옛
                                                active·inbox·log도 합쳐 보여 준다(coordination.legacy). runnable은 다른 생존 세션이
                                                잡은 태스크와 아직 land에 안 들어간 완료 태스크(unlanded)를 뺀다 — 뺀 것은 held
  vibe sync                                     원격 push 브랜치를 HEAD에 반영 (STATE는 섹션 단위 병합)
  vibe plan-sync                                기획 브랜치(SETTINGS plan, 미정이면 land)의 최신을 HEAD에 합침 — 기획·채번 전
  vibe plan-push [--commit <sha> ...]           spec/만 바꾼 기획 커밋(기본 HEAD)을 기획 브랜치에 올리고 다시 합침.
                                                원격에 그 브랜치가 있으면 push, 없으면 로컬 브랜치만. ID 충돌이면 거절
  vibe claim --tag <tag> [--task T###] [--mode pair|autopilot] [--host <name>]
                                                조정 브랜치에서 태스크 선점(같은 clone의 worktree는 하나만 성공). push 대상·깨끗한
                                                트리·커밋이 필요 없고 작업 트리는 그대로다. 원격이 있고 coord-push가 켜져 있으면
                                                바로 올린다 — 다른 기기가 먼저 올렸으면 실패(lost), 원격에 닿지 못하면 로컬 선점은
                                                유지하고 unpublished:true. --task 없으면 세션 등록만
  vibe push [--tag <tag>] [--wait-ci] [--diff-base <sha>] [--verified-commit <sha>]
                                                끝난 작업을 spec/SETTINGS.md land로 반영: push true면 sync 후 원격 push,
                                                false면 로컬 land 브랜치 병합, land-via pr이면 이 브랜치 push+PR. 할 일 없으면 none.
                                                verified-commit 이후 코드가 바뀌면 재검증 필요. tag 기본값은 이 세션 worktree의 tag
  vibe deploy [--wait-ci]                       '배포해줘': deploy 브랜치를 land로 fast-forward (push true면 원격). 갈라졌으면 거절
                                                SETTINGS version auto면 운영 브랜치(deploy, 없으면 land)가 전진할 때 push·deploy가
                                                버전 커밋을 얹고 결과 version에 {from,to,level} 또는 {skipped}를 싣는다
  vibe beat --tag <tag> [--mode pair|autopilot] [--doing <T###|->] [--host <name>] [--end]
                                                --end는 이 세션의 통합 참여도 닫는다(변경 없으면 withdrawn, 있으면 paused — ready·withdraw 전까지 관문을 잡는다)
                                                조정 브랜치의 이 세션 행(브랜치·현재 커밋 포함) 쓰기·갱신·삭제 — 커밋할 것 없음.
                                                세션 시작·끝과 doing·커밋이 바뀐 갱신은 올리고, at만 바뀐 갱신은 커밋하지 않는다(행이 30분 넘게
                                                묵었을 때만 생존 신호로 남긴다).
                                                --doing T###는 선점과 같다(다른 생존 세션이 잡았으면 거절). beat·claim·inbox·log는 커밋이 아직
                                                없는 git 저장소에서도 조정 브랜치에 쓴다(행의 커밋은 -). git 저장소가 아닌 대상만 STATE에 쓴다
  vibe task start T### --tag <tag>              단독 선점: 태스크·STATE 행을 doing@날짜.tag로(커밋은 호출자). 등록된 세션이면
                                                조정 브랜치에서 먼저 선점하고 거절되면 쓰지 않는다. todo·dep 완료만
  vibe task reserve --tag <tag> [--count 1]     다음 태스크 번호를 한 번만 내준다: 기획 브랜치(원격)·이 clone의 모든 worktree·다른 기기의 예약보다 큰 번호.
                                                예약은 생성 전용 ref(refs/gusta/task-ids/T###)로 원격에도 원자적으로 — 손 채번 대신 쓴다
  vibe task done T### --tag <tag> [--at <sha|ref>] [--force-other]
                                                done@날짜·tasks/done/ 이동·STATE 행 삭제·next (커밋은 호출자). 조정 브랜치에는
                                                unlanded 행(land에 들어갈 때까지 다른 세션이 다시 집지 않게)과 log 한 줄.
                                                acceptance 미체크·빈 result·다른 tag(--force-other는 사용자 지시 때만)면 거절
  vibe inbox add --kind decided|parked|suggest [--ref <T###|ID-n|review/<slug>|ideation/<slug>> ...] (--text <text> | --file <path>) [--tag <tag>]
                                                결정함에 한 줄(- YYMMDD kind refs: text, 날짜는 CLI가). 따옴표·|가 섞인 본문은 --file,
                                                이미 완성된 한 줄은 --line '<줄>'(--kind·--ref 없이).
                                                형식과, 참조한 태스크·결정·문서가 이 checkout에 있는지를 쓰는 시점에 검사한다
  vibe inbox resolve (--id <id> ... | --line <line> | --file <lines>) [--log <text>] [--tag <tag>]
                                                owner가 확인한 줄 삭제(+ --log 한 줄). id는 list·add·status가 준다
  vibe inbox list [--kind <kind>] [--ref <ref>] [--no-fetch]
  vibe log [--text <text> | --file <path>] [--tag <tag>] [--no-fetch]
                                                활동 기록 한 줄(최신이 위, 20줄 유지; 다음 사건과 함께 올라간다). 본문 없으면 목록.
                                                inbox·log·beat·claim은 작업 묶음의 워커·리뷰어 checkout에서 거절한다
  vibe checkpoint --tag <tag> [--message <text>] [--handoff] [--next <text>]
                                                작업 트리 스냅샷을 wip/<tag>로 보존. --handoff는 최종 검증 없이 명시한 원격 인계(push false여도 WIP만 push).
                                                이 세션 행의 커밋·at도 갱신해 올린다(오래 걸리는 작업이 죽은 세션으로 보이지 않게)
  vibe prune [--tag <tag>] [--work <name>]      마감 정리: 합쳐진 작업 묶음·단위의 worktree·브랜치, 이 세션의 wip/<tag>.
                                                spec/SETTINGS.md prune-branches가 false면 건너뜀. 안 합쳐진 커밋·미커밋 변경은 보존
  vibe settings [--set <key>=<value> ...]       spec/SETTINGS.md의 유효 설정(없으면 기본값) 보기·바꾸기 (커밋은 호출자)
  vibe usage start --tag <tag> (--session <id> | --marker <literal-32-hex>) [--project-dir <dir>]
  vibe usage report (--tag <tag> | --session <id>) [--project-dir <dir>]
                                                usage-measurement=true일 때만 Claude 네이티브 부모·하위 로그의 기준선/사용량 스냅샷.
                                                marker는 도구 명령에 직접 쓴 임의 리터럴. --session 보고만 하면 세션 전체; adapter 합계와 더하지 않음
  vibe design [start --tag <tag> [--scope <text>] | verify [--verify <command> ...] [--timeout-ms <ms>] | end]
                                                디자인 모드(gusta-design-mode): 이 checkout의 Git 디렉터리에 디자인 중 상태 쓰기·task 검사·삭제.
                                                verify는 미커밋 트리의 task 검사만 실행하고 batch(--verify 포함)·CI를 보류.
                                                end·커밋 뒤 공동 통합에 제출한다. 디자인 중 이 checkout의 push·맡김은 거절
  vibe ab start <slug> [--variants 2] [--base HEAD] [--base-port 4101] [--setup <install command>] [--reuse <dir> ...] [--copy <untracked file> ...] [--shared-file <file>] [--scaffold-prompt <file> | --scaffold <ref>] [--timeout-ms <ms>]
                                                shared: 모든 변형 프롬프트의 공통 앞부분(목표·결정·화면·완료 기준). scaffold: 세션 하나가 ab/<slug>/base에
                                                mock 데이터·인증 stub 커밋을 만들고 변형은 거기서 시작(--scaffold는 있는 커밋 재사용). pick은 scaffold의 줄·파일만 되돌려 합친다.
                                                --scaffold-prompt는 run과 같은 --provider·--model·--allow-tool·--permission-mode를 받는다.
                                                --timeout-ms는 setup(기본 1200000)과 scaffold 세션(기본 3600000)에 함께 쓰인다.
                                                --reuse: lockfile대로 설치된 git-ignored 의존성 폴더만. 가장 가까운 lockfile 폴더의 lockfile이 모두 기준 커밋과 같으면
                                                이 checkout의 설치를 복사(CoW, symlink 아님), 아니면 setup. 오래된 설치·절대 symlink·postinstall 부수 효과는 그대로 복사되거나 빠짐
  vibe ab add <slug> --from <v> [--setup <install command>] [--reuse <dir> ...] [--copy <untracked file> ...]
                                                <v>의 끝에서 다음 변형(최대 6)을 새 브랜치·worktree·포트로. 그 run은 다른 변형의 git diff를 읽어도 된다고 안내.
                                                --setup·--copy·--reuse는 주지 않으면 start 값
  vibe ab run <slug> (--variant <a|b|..> (--prompt-file <approach> | --follow-up-file <request>) | --all --prompt-dir <dir>) [--provider auto|claude|codex] [--model <id>] [--allow-tool <rule> ...] [--permission-mode bypass|acceptEdits] [--timeout-ms 3600000]
                                                follow-up은 공통·처음 접근·지난 요약·새 hub 메모를 붙여 같은 브랜치에서 이어 고친다. scaffold 줄·파일을 고치면 ok:false·scaffoldTouched, mock 줄·경로를 옮겨 쓰면 scaffoldResidue.
                                                --all: <dir>/<v>.md가 있는 변형을 한 프로세스에서 병렬로, 결과 JSON 하나(한 변형 실패가 나머지를 막지 않음, 파일 없는 변형은 skipped)
  vibe ab serve <slug> --command '<dev server using $PORT>' [--variant <v>] [--restart] [--ready-timeout-ms 120000]
                                                화면(path)이 HTTP로 응답하면 준비. 살아 있는 서버는 두고(--restart면 새로) 비교 페이지(hub) URL 하나
  vibe ab exec <slug> --command '<measure or check>' [--repeat 1] [--variant <v>]
                                                변형을 번갈아 실행해 중앙값·종료 코드·마지막 줄. 최근 결과는 hub에도(변형마다 명령이 다르면 명령도)
  vibe ab status <slug> | pick <slug> --variant <v> [--approach <English line>] [--accept-residue] [--prune-branches] | stop <slug> [--remove] [--prune-branches]
                                                A/B 비교(gusta-showcase): 변형마다 브랜치·형제 worktree·포트. 변형 세션은 그 worktree만 고치고
                                                커밋·서버·측정·정리는 CLI가 한다. status는 hub URL·메모·choose, pick은 그 변형만 현재 브랜치에 merge하고
                                                조정 브랜치 log에 채택 줄(접근은 --approach 또는 저장된 접근 첫 줄, 약 100자)을 쓴다(커밋할 것 없음)
  vibe sketch serve <slug> [--port 0] [--ttl-ms 28800000] [--json]
                                                스케치(gusta-sketch): <checkout>/.tmp/sketch/<slug>/의 정적 파일을 127.0.0.1 포트 하나로(no-store).
                                                같은 slug의 살아 있는 서버는 재사용(reused). .tmp/는 info/exclude로 무시(.gitignore 안 고침). ttl 뒤 스스로 종료
  vibe sketch stop <slug> | --all [--json]      기록된 스케치 서버 정지·기록 삭제
  vibe sketch status [--json]                   기록된 스케치 서버와 alive
  vibe preflight [--probe <command> [--provider claude|codex] [--allow-tool <rule> ...]]
                                                맡김 전 점검: push 권한·조정 브랜치(coord-push)·lint·절전 방지·CI 접근·헤드리스 워커 실측
                                                (probe는 agents 첫 도구의 가장 싼 조합). agents 미정이면 reason needs-init, probe 없음
  vibe awake [--hours <n>] | --stop             macOS caffeinate로 절전 방지
  vibe check [--plan <JSON file>] [--tier task|batch] [--tag <tag>] [--diff-base <task-start-sha>] [--task T###] [--timeout-ms <ms>] [--heavy] [--no-cache] [--allow-final] [-- <command>]
                                                명령을 생략하면 ARCH plan의 해당 단계를 실행하고 유효한 성공 항목을 재사용.
                                                -- 뒤 인자 하나는 셸 명령 문자열, 여럿이면 실행 파일과 인자(경계 보존: -- sh -c 'cd mod && go test ./...')
                                                batch/group은 조정자 전용·자동 heavy 락. --allow-final은 명시적 예외만
공통: --target <path>, --remote <name>. 출력은 JSON(brief는 기본 마크다운, sketch는 --json 없으면 한 줄). check는 요약·실패 이름·마지막 8줄·전체 로그 경로만 출력.
`

const allowed = {
  session: ['kind', 'tag', 'branch', 'base', 'path'], integration: ['tag', 'token', 'file', 'reason', 'remote', 'timeout-ms', 'verify', 'participant'],
  loop: ['tag', 'provider', 'model', 'effort', 'max-units', 'max-hours', 'deadline', 'final-reserve-hours', 'batch-size', 'permission-mode', 'allow-tool', 'verify', 'adapter', 'probe', 'probe-timeout-ms', 'timeout-ms', 'tasks', 'remote', 'wait-ms', 'notify-command', 'request-file', 'wait-event', 'after', 'run'],
  ci: ['commit', 'branch', 'repo', 'diff-base', 'timeout-ms', 'no-run-ms', 'poll-ms', 'remote'], brief: ['task', 'diff-base', 'ref', 'section', 'offset', 'limit', 'snapshot'], format: ['section'],
  status: ['tag', 'remote', 'section'], sync: ['remote'], 'plan-sync': ['remote', 'tag'], 'plan-push': ['remote', 'commit', 'tag'], push: ['remote', 'tag', 'diff-base', 'timeout-ms', 'no-run-ms', 'verified-commit'], deploy: ['remote', 'timeout-ms', 'no-run-ms'], beat: ['tag', 'mode', 'doing', 'host', 'remote'],
  claim: ['tag', 'task', 'mode', 'host', 'remote'], task: ['tag', 'at', 'count', 'remote'], inbox: ['tag', 'kind', 'ref', 'text', 'file', 'line', 'id', 'log', 'remote'], log: ['tag', 'text', 'file', 'remote'],
  checkpoint: ['tag', 'message', 'remote', 'next'], prune: ['tag', 'work', 'remote'], settings: ['set'], usage: ['tag', 'session', 'marker', 'project-dir'], preflight: ['remote', 'probe', 'provider', 'allow-tool', 'probe-timeout-ms', 'probe-workspace', 'permission-mode'],
  awake: ['hours', 'remote'], check: ['plan', 'tier', 'tag', 'diff-base', 'task', 'timeout-ms'], design: ['tag', 'scope', 'verify', 'timeout-ms'],
  ab: ['variants', 'base', 'base-port', 'setup', 'copy', 'reuse', 'from', 'shared-file', 'scaffold-prompt', 'scaffold', 'variant', 'approach', 'prompt-file', 'prompt-dir', 'follow-up-file', 'provider', 'model', 'timeout-ms', 'allow-tool', 'permission-mode', 'command', 'ready-timeout-ms', 'repeat'],
  sketch: ['port', 'ttl-ms'],
}
const flags = { session: ['from-head'], integration: ['no-push'], task: ['force-other'], checkpoint: ['handoff'], loop: ['dry-run', 'detach', 'stop', 'stop-after-unit', 'configure', 'status', 'recover-metadata', 'push-each-unit', 'no-push-each-unit'], push: ['wait-ci'], deploy: ['wait-ci'], status: ['no-fetch'], inbox: ['no-fetch'], log: ['no-fetch'], beat: ['end'], awake: ['stop'], check: ['heavy', 'no-cache', 'allow-final'], brief: ['deep', 'summary'], ab: ['remove', 'prune-branches', 'restart', 'all', 'accept-residue'], sketch: ['all'] }
const actions = { session: (options) => { if (options.step !== 'open') throw new SkillPackageError('vibe session open --kind <kind> --tag <tag>'); return openSessionWorkspace(options) }, integration: vibeIntegration, loop: vibeLoop, ci: vibeCIWait, brief: vibeBrief, format: vibeFormat, status: vibeStatus, sync: vibeSync, 'plan-sync': vibePlanSync, 'plan-push': vibePlanPush, push: vibePush, deploy: vibeDeploy, claim: vibeClaim, beat: vibeBeat, task: vibeTask, inbox: vibeInbox, log: vibeLog, checkpoint: vibeCheckpoint, prune: vibePrune, settings: vibeSettings, usage: vibeUsage, preflight: vibePreflight, awake: vibeAwake, design: vibeDesign,
  ab: (options) => { if (!Object.hasOwn(AB_STEPS, options.step ?? '')) throw new SkillPackageError(`vibe ab <${Object.keys(AB_STEPS).join('|')}> <slug>`); return AB_STEPS[options.step](options) },
  sketch: (options) => { if (!Object.hasOwn(SKETCH_STEPS, options.step ?? '')) throw new SkillPackageError(`vibe sketch <${Object.keys(SKETCH_STEPS).join('|')}>`); return SKETCH_STEPS[options.step](options) } }

// Top-level gusta commands a session may reach for under vibe by mistake.
const TOP_LEVEL = ['lint', 'board', 'context', 'work', 'agents', 'migrate', 'outdated', 'install', 'agent-block', 'upgrade-context']
const shellWord = (word) => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

// `vibe <command> --help`: that command's entries (each `  vibe <command>` line and the lines
// indented under it) and the common line; the whole help when the command has none.
export function commandHelp(command) {
  const blocks = [], lines = HELP.split('\n')
  for (const line of lines) {
    if (/^ {2}vibe \S/.test(line)) blocks.push([line])
    else if (/^ {3,}\S/.test(line) && blocks.length) blocks.at(-1).push(line)
    else blocks.push(null)
  }
  const own = blocks.filter((block) => block && (block[0].startsWith(`  vibe ${command} `) || block[0] === `  vibe ${command}`))
  return own.length ? `${own.map((block) => block.join('\n')).join('\n')}\n${lines.find((line) => line.startsWith('공통:'))}\n` : HELP
}

export async function runVibeCLI(args) {
  // Words after `--` belong to the checked command (vibe check -- tool --help).
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args, asked = own.includes('--help') || own.includes('-h')
  if (!args.length || (asked && (args[0].startsWith('-') || !Object.hasOwn(allowed, args[0])))) { process.stdout.write(HELP); return }
  if (asked) { process.stdout.write(commandHelp(args[0])); return }
  const action = args.shift()
  // Git calls the merge driver with three file paths and reads the exit code.
  if (action === 'merge-state') {
    const result = await vibeMergeState(args)
    if (result.conflicts.length) { process.stderr.write(`STATE 충돌: ${result.conflicts.join(', ')}\n`); process.exitCode = 1 }
    return
  }
  if (!Object.hasOwn(allowed, action)) throw new SkillPackageError(TOP_LEVEL.includes(action) ? `${action}은(는) vibe 하위 명령이 아닙니다: gusta ${action} (vibe 없이, 같은 실행 경로로)` : `알 수 없는 vibe 명령: ${action}`)
  if (action === 'ci' && args.shift() !== 'wait') throw new SkillPackageError('vibe ci wait [옵션]')
  const options = {}
  if (action === 'brief') while (args[0] && !args[0].startsWith('--')) (options.roots ??= []).push(args.shift())
  if (['session', 'integration', 'design', 'usage', 'inbox'].includes(action) && args[0] && !args[0].startsWith('--')) options.step = args.shift()
  if (action === 'task') { options.step = args.shift(); if (args[0] && !args[0].startsWith('--')) options.task = args.shift() }
  if (action === 'ab' || action === 'sketch') { options.step = args.shift(); if (args[0] && !args[0].startsWith('--')) options.slug = args.shift() }
  let command = null
  while (args.length) {
    const argument = args.shift()
    // One word after -- is a shell command string; several are one program and its arguments,
    // each quoted so the shell hands them over with their boundaries (sh -c '<script>' stays one).
    if (argument === '--') { const words = args.splice(0); command = words.length === 1 ? words[0] : words.map(shellWord).join(' '); break }
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
    if (['allow-tool', 'verify', 'copy', 'reuse', 'set'].includes(name) || (action === 'plan-push' && name === 'commit') || (action === 'inbox' && ['ref', 'id'].includes(name))) (options[field] ??= []).push(value)
    else options[field] = value
  }
  if (action === 'check') {
    process.exitCode = await vibeCheck(options, command)
    return
  }
  try {
    const result = await actions[action](options)
    // A brief is read by a model: markdown with an end line unless JSON is asked for.
    process.stdout.write(action === 'brief' && !options.json ? (result.view ? renderBriefView(result) : renderBrief(result))
      : action === 'sketch' && !options.json ? renderSketch(options.step, result) : `${JSON.stringify(result, null, 2)}\n`)
    if (result.ok === false || (action === 'brief' && (result.view ? result.sourceComplete === false : result.complete === false))) process.exitCode = 1
  } catch (error) {
    if (!(error instanceof SkillPackageError)) throw error
    // A refused claim says who holds the task and how (claimed|unlanded; lost: the remote had it first).
    const claim = error.name === 'ClaimError' ? { claim: { task: error.task, owner: error.owner, reason: error.reason, lost: error.lost } } : {}
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, error: error.message, details: error.details ?? [], ...claim }, null, 2)}\n`)
    process.exitCode = 1
  }
}
