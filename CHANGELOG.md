# Changelog

## 0.12.4

- The initiating start-vibe conversation remains the orchestrator. CLI loops run
  fresh units and return durable results; a helper exit or its automatic repair
  limit does not complete the user's objective. The session re-plans recoverable
  failures within the original deadline and total budget, preserves cumulative
  attempts and required verification, and records CLI defects for later package
  maintenance. Detaching requires a real parent continuation connection.
- Bound final-gate recovery by progress: the default three-failed-round cap allows
  an extra repair for a strictly shrinking failed-command set in the same fully
  observed plan, or complete test IDs certified by a structured check adapter.
  Generic test logs remain diagnostic. New, unknown or interrupted failures do
  not earn an extension. Results expose
  attempts, pending repair tasks and actual publication. Add an explicit absolute
  `--deadline` and live deadline/reserve configuration with applied receipts;
  changing push frequency never establishes a deadline.
- Expose termination notification capability and parent-readable terminal
  evidence. Local outbox records and acknowledged hooks remain distinct from
  confirmed user delivery; launchers disclose missing automatic chat delivery.
- Add `vibe checkpoint --handoff` for remote continuation without final repair or
  integration. It preserves WIP on its own remote branch even when final push is
  disabled, retries an unchanged snapshot's remote push, and returns its ref,
  commit, unverified status and next action.
- Default `work status` to current ownership/work summaries; request history with
  `--details` and optionally `--work`. Add brief `--summary` and whole-block
  section paging without cutting required SSOT context. Skills select needed
  blocks/report sections instead of printing nested briefs and whole histories.
- Probe standalone execution in its actual checkout. Preflight distinguishes
  missing dependencies, network restrictions and permission failures; launcher
  instructions avoid redundant probes and irrelevant workspace installs.

## 0.12.3

- Headless sessions no longer stall on permissions. A `vibe loop` stopped at preflight because its Codex worker, in the default workspace-write sandbox, could not reach the network, and start-vibe allowed `--permission-mode bypass` only on the owner's explicit request — so an unattended run waited for a person who was not there. SETTINGS gains `permission-mode` (`bypass`|`acceptEdits`, default `bypass`) for every headless session the CLI starts to write code: `vibe loop` units, `work run` workers (new `work run --permission-mode`), show-ab variants and the `vibe preflight --probe` worker. `bypass` runs Claude with bypassPermissions and Codex with `--dangerously-bypass-approvals-and-sandbox`; `acceptEdits` keeps the old allow-list/sandbox behavior. An explicit `--permission-mode` overrides it for that run; reviewers stay read-only. A resumed Codex worker in bypass mode now keeps its session (`exec resume <id>`); it used to start a new one.
- CI nobody can read no longer holds the work. Without gh or a token, a private repository's public page is closed, so `vibe ci wait` polled until its deadline (inside `vibe loop`, the rest of the run's time) and returned `timed_out`, which queued a pointless fix-ci task. Now CI that no transport could read within the no-run grace (2 minutes by default) — or a checkout without a GitHub remote — returns `unchecked` (ok, never counted as a pass): the loop goes on without a repair task, the report lists `- CI <sha>: unchecked (...)` under checks and `- check CI later: <sha> <commit URL>` under next, and the `finished` notification carries `ciUnchecked` at level `attention`. CI that was read once is still waited for, so its outage stays `timed_out`. `vibe preflight`'s `ci-access` is now informational and never stops autopilot.

## 0.12.2

- See what a running agent is doing. Claude now runs with `--output-format stream-json`, so a `vibe loop` unit log and each `work run` dispatch log (`dispatch.log`, under `logs/<attempt>/`) fill as the session works instead of at the end; Codex already streamed. The result is still the schema-validated final `result` event. Dispatch records keep only the log path and a short `error` (the adapter's last plain stderr line), and no `work` command prints log content, so a worker's transcript never reaches the coordinator's context.
- Add `vibe loop` owner notifications beyond failures: `needs-judgment` (at most once per unit that adds inbox decided/parked or `[?]` items) and one `finished` run summary (status, units, items waiting for judgment, parked, push result, report). Every notification payload now carries `level` (`failure`/`attention`/`info`) so a `--notify-command` can filter.
- Add `work run --detach/--status/--stop`: a detached runner host that survives the terminal or chat ending, file-only status (never log content) that reports a dead host as `host-lost`, and a CLI stop so an unattended session never runs `kill`. A stop during the final group verify or prune now kills the verify and ends the run `interrupted` (it used to run to the end), and heartbeats continue through that phase so a long verify no longer looks stale. Pruning a merged unit also deletes its dispatch logs.
- A stopped or timed-out unit/group check now ends everything it started. Checks ran through `exec`, which signals only `/bin/sh`; a shell that forks its command (dash on Linux, or any compound command such as `npm test` spawning workers) left that command running after the gate gave up. Checks now run as their own process group, like `vibe check`.

## 0.12.1

- `vibe loop` no longer ends the run when a unit hits its time limit. The 1-hour unit limit catches a stuck session; before, one cut unit failed the whole run, its uncommitted files blocked every later step, and the closing gate and push were skipped, so a night of committed work stayed unpublished. Now a unit cut at its limit (or by the output cap) or a failed unit has its uncommitted changes snapshotted to a local ref (`refs/haeram/units/<tag>/<run>-<n>`, never pushed; staged-only content is kept as a second parent), only those paths return to HEAD, and the next fresh unit continues from the snapshot. A task cut again gets one split unit (narrow it, move the rest into dependent tasks), and a task still cut after that is parked in the inbox while other tasks run. Only a cut with no changes counts as a session failure, and a run stopped by session failures still sends what earlier units committed through the closing gate and push. A unit that reports success but leaves changes still stops the run with them in place, since they may be the owner's. Cuts are `unit-cut`/`unit-leftover`/`task-parked` events (no failure notification) and `cut (...)` report lines; kept snapshots are listed under the report's next.
- Unit limits follow the plan. An explore task's unit runs its timebox plus 30 minutes (it was cut at 1 hour regardless of `explore:2h`); an explore task whose timebox no longer fits the work window is skipped, and the run closes with `explore-no-time` when only such tasks remain. Every unit is capped at the start of the closing window instead of the deadline, so a long last unit cannot eat the gate's reserve, and no unit starts within 10 minutes of that window. The unit's assignment carries its limit, and the prompt tells it that cut work is handed on.
- Add `vibe loop --tasks 'T### ...'`: the run works only those tasks, plus tasks it creates for them (a split's follow-ups, a new prerequisite, gate/CI repairs), and closes with `scope-done` through the gate. It refuses to start when a scoped task waits on an unfinished task outside the scope. Task choice no longer depends on the STATE next line's format, which a unit had to keep rewriting. `--timeout-ms` and `--tasks` are now in `vibe --help`.

## 0.12.0

- Clean up after work by default. Runners left every unit worktree, branch and failed integration/review candidate behind, and `work cleanup` kept worktrees holding ignored install output and never deleted branches, so a long-running project accumulated dozens of `.haeram-worktrees` (tens of GB) and `task/*`, `work/*`, `wip/*` branches, some pushed. Now, with `prune-branches` on (the default), the CLI deletes what it created once nothing needs it: `work cleanup` removes the unit worktree with its ignored output and deletes the merged unit branch, its `refs/haeram/checkpoints/<attempt>` ref and the remote `wip/<attempt>` (`--push` groups), and force-removes the detached integration/review candidates; a runner prunes its integrated and released units when it stops (before releasing the group, so no session reads a unit mid-cleanup as live work); `vibe prune [--tag <tag>] [--work <name>]` — the last step of a session and of `vibe loop` — also deletes the session's `wip/<tag>` (locally once the tree is clean, on the remote once HEAD is on the push branch) and closes a finished group (no remaining tasks, branch merged into its base or push branch: planning worktree and `work/<name>` removed, status `pruned`). `vibe ab pick` / `stop --remove` delete variant branches too. Unmerged commits, uncommitted changes, live attempts, adopted (`--workspace current`) groups and branches checked out elsewhere stay and are reported under `kept`.
- Add `spec/SETTINGS.md`, package behavior the owner chose: one `- key: value  # note` line per key, a missing file or key means the default, an invalid value is a lint error and disables what reads it (prune refuses to guess). `vibe settings [--set key=value]` shows the effective values with their source and writes the file; the meta skill `/haeram-setting` shows them as a table and changes only the values named. The first key is `prune-branches` (default `true`; `false` restores the old keep-everything behavior).
- Branch strategy is a setting, not hardcoded `main`. SETTINGS gains `land` (where finished work lands: start-vibe session end, self-improve(-local), work groups; `current` = stay), `land-via` (`merge`|`pr`), `push`, `deploy` and `plan`. `vibe push` now lands per these: push true syncs and pushes to land as before; push false merges into the local land branch (land merged in first, so land only fast-forwards; its checkout must be clean); `pr` pushes the work branch and opens a PR into land (gh when available, else base/head are returned). New `vibe deploy` ("배포해줘") fast-forwards the deploy branch to land and refuses when deploy has commits land lacks. The planning branch defaults to land, else the repository default branch — no more implied `main`. Work groups that finish return `landFrom` and land with `vibe push --target <landFrom>`; the old "ask whether to merge into main" / "park the main merge" directives are gone. self-improve opens its PR into land. `vibe status` reports `settings` (with `unset`), and `vibe preflight` reports an undecided land without blocking (autopilot commits on the current branch; haeram-init settles it in pair mode).
- STATE cfg `push`/`plan` move to SETTINGS. They are still read while SETTINGS lacks the key (cfg push `<branch>` = land on it and push) — `vibe status`/`vibe settings` list them as `legacy`; lint stays quiet because integration requires a warning-free spec — and the new STATE template drops them. `haeram-spec-creator migrate [--dry-run]` applies structural migrations to spec/ idempotently (first: cfg push/plan → SETTINGS) and reports FORMAT drift (`format.missing`/`extra` per section), unset settings and lint. `haeram-spec-creator outdated` returns the installed (lock), running and latest npm versions plus CHANGELOG entries since the installed one; CHANGELOG.md now ships in the package.
- Add meta skills `/haeram-init` (asks only the unset settings — branch strategy presets: merge straight to the default branch, stage on an integration branch and deploy on request, PR, or commit only — and writes them with `vibe settings --set`) and `/update-haeram-spec-creator` (outdated → install → migrate → FORMAT merge keeping the project's own rules → lint → install and spec commits). Every spec skill's common rule 1 sends unset settings to haeram-init first; autopilot and runner-assigned sessions never ask and commit on the current branch.

## 0.11.0

- Add `/show-ab` and `vibe ab`: build 2–6 variants of one change in parallel and compare them side by side. `vibe ab start` creates a branch (`ab/<slug>/<v>`), a sibling worktree and a free port per variant and runs the dependency setup in all of them at once; `vibe ab run` launches one write-capable headless session (Claude or Codex, new `variant` adapter role) in a variant's worktree and commits its changes on the variant branch, returning only a summary and where to look; `vibe ab serve` starts each variant's dev server on its own `$PORT` and waits until it listens (a server that never listens is reported with its log tail); `vibe ab exec` runs one measurement in every variant, alternating them per repetition, and reports median/min/max and exit codes; `vibe ab pick` merges only the chosen variant into the current branch and cleans up, `vibe ab stop --remove` discards. Variants never edit spec/; adoption is recorded like a design ending (STATE log, then update-ssot if a rule changed). Pair mode only.
- Prompt-cache-aware waiting and returning. The bundle coordinator waits `work next --wait 3300`: it returns just before the 1-hour prompt cache expires, so waking reads its context at the cache price instead of rewriting all of it at 2× (0.10.0 used 3600, which landed just past the TTL). An autopilot launcher tells the user to come back in a new conversation — its state lives in the report, inbox and loop.json — instead of reviving an expired one. The loop's `- time:` line adds the input-token total and its cache-read share, so per-unit fresh sessions can be checked to still reuse the shared prompt prefix.
- `availableProvider` resolves the provider for one-off headless sessions and is shared by `work scout` and `vibe ab run`.
- Decisions, measurements and open questions: [docs/0.11.0.md](docs/0.11.0.md).

## 0.10.1

- `vibe loop` records where the time went, so the next speed-up is chosen from numbers. Each unit session gets its own check ledger (`HAERAM_CHECK_LOG`): `vibe check` appends every run, and the host reads it back with the unit's wall time and compact token usage. `loop.json` and the loop result carry `time` (implementation/planning/inbox/failed units with model and task-check time, closing gate, CI wait, host overhead, the three slowest units, token totals), and the closing report adds one `- time:` line under checks. Commands run outside `vibe check` count as model time.
- Add the meta skill `/haeram-report`: run it in a session that used haeram skills and it returns one markdown code block of evidence-backed improvements to the skills and CLI themselves (bugs, ambiguous or conflicting instructions, token and time waste, human time spent on non-decisions, missing capabilities), anonymized so it can move to this repository unchanged. It is read-only and carries no common spec rules.
- Token usage compaction moves to the agent adapter and is shared by `work scout` and loop units.

## 0.10.0

- Orchestrators delegate instead of reading and editing in their own context, whose every later turn re-sends what they read. Add `work scout --prompt-file <file> [--provider] [--model] [--timeout-ms]`: one read-only headless session (Claude plan mode, Codex read-only sandbox, 15-minute default) that returns only `summary`, structured `proposals[]` and compact token usage, so autopilot, headless and Codex orchestrators can hand off exploration like they hand off implementation and review to `work run`. self-improve-local and self-improve discover through scouts (native sub-sessions or `work scout`), and self-improve no longer implements in the coordinator session. The scout prompt's fields match the result schema.
- start-vibe autopilot always hands units to `vibe loop --detach` (fresh session per unit) instead of looping in the conversation; only a work-bundle coordinator stays, and it waits with `work next --wait 3600` in the background rather than waking every 9 minutes.
- Fix `vibe ci wait` without `gh` or a token: github.com job pages carry the job result only in the header text, so every finished run stayed `in_progress` until the timeout. A run that succeeded in 4 minutes now resolves on the first poll instead of after 30 minutes. Page status icons no longer appear as a failed step named `failed:`, and job names drop the stray `>`.

## 0.9.0

- State the philosophy at the top of the README and repository instructions: we curate, our taste is the product; spec first, minimal tokens, fast implementation; low coupling and high cohesion so unit tests stay fast. ARCH, create-task, implement-task, review-code, review-task and self-improve treat module boundaries, dependency injection and unit testability as part of the work.
- `vibe loop` reserves the tail of a timed run for the closing gate. Previously units could consume the whole budget and the time limit skipped final verification and publication entirely. The reserve is measured, not a fixed share: final-tier checks (`vibe check --tier batch|group`, `work finish`, `vibe design verify`), loop units and CI waits record their durations in the runtime `timings.json` (largest of the last 3 samples), and the reserve is the gate twice + one repair unit + CI. Only before the gate was ever measured does a run use 20% of max-hours; `--final-reserve-hours` overrides. No new unit starts inside it; the loop runs the gate, push and CI there (`final-window`). A failed gate queues a repair task with its log and failed tests, runs it inside the reserve and re-runs the gate once; a second failure stops without a push. Gate checks are bounded by the reserve rather than the unit timeout.
- `vibe check --tier task` refuses a command that ARCH declares only for the batch tier (the full suite) unless `--allow-final` records an explicit request, and flags task checks over 5 minutes with `slow`/`hint`.
- In autopilot, `work next` no longer tells a session to spawn a reviewer subagent for `needs-reviewer` (its permission prompt would stall an unattended session); a headless runner reviews, or the item is parked.
- Documentation pass for tokens and correctness: each rule stated once by its owner (verification tiers in start-vibe/references/verification.md, loop control in loop-control.md, self-improve rules in their skills), shorter `vibe format` state/report excerpts, and fixes for stale text (chg line format, ideation plan-push and STATE section order, push wording in `/start-vibe` questions, claims and `work run`, experiment verdicts, broken reference links, unpinned CLI versions). The README groups verification and push in one section and moves release history to CHANGELOG/docs; `기존 프로젝트 이관` now exists for the lint pointer.
- Stabilize the detached-host loop test, which removed its fixture while the host and supervisor were still writing their last events.

## 0.8.4

- Reproduce and fix cancelled loop finalization: immediate stop/signals/time limits never start closing checks with an aborted signal, interrupted verification is recorded separately from test failure, and every exit attempts a journaled host-metadata close. A local replacement runner treating any dirty report as unfinished implementation was a separate caller error.
- Add in-place `vibe loop --configure --push-each-unit|--no-push-each-unit`, durable applied receipts, `--wait-ms`, and `--stop-after-unit`. Configuration applies after the current unit and owned metadata commit, preserves the same host/deadline/unit budget, and keeps the verified-code push and post-push CI gates. Existing `--stop` remains immediate; cancellation intentionally skips new final verification/publication.
- Limit host ownership to the exact report and its own active row. Preserve unknown source/SSOT/task/STATE/report/index edits and stop publication instead of launching an implementation recovery session. Retry metadata operations once, record operational errors separately, and provide explicit metadata-only recovery without worker restart or clearing user stops. Host report commits now also occur at each unit boundary.
- Add atomic status, heartbeat, terminal-write fallback, independent supervisor readiness/lost-host detection, durable failure events/outbox, and an optional tested notification command. Only an actual successful hook invocation is acknowledged; external user delivery is never assumed. OS-wide restart supervision and external messaging integration remain separate operations work.
- Exercise complete unit-to-metadata-to-config-to-next-unit flows with fake workers, isolated Git publication, write/commit/configuration/status faults, real isolated host termination, cancellation, ownership isolation, budget preservation, unknown edits, notification acknowledgements, and verified SHA/CI protections.

## 0.8.3

- Pin the publishing npm CLI and enable its bundled Sigstore client's existing Rekor conflict recovery. A retry-after-success 409 fetches the recorded entry while preserving signing, transparency-log evidence and provenance; unsupported tool versions or configuration shapes fail closed. Exercise recovery and unrecoverable failures against the real publishing tools before release. Consumer dependencies and installation are unchanged.

## 0.8.2

- Add `self-improve-local`: the invoking session remains the orchestrator, read-only child sessions propose improvements before implementation, and only coordinator-approved tasks receive workers. Independent reviews and verification precede integration into the invoking branch; PR creation is not required and remote code push retains its separate authorization.
- Add optional `work start/configure --tasks` scoping across claims, boards, final gates and portable history. Preserve external dependencies and complete lanes, reject removal of running/integrated tasks, and leave unrelated todo unchanged while finishing the approved scope.
- Report the actual integration target for adopted local branches without asking to merge again. Keep final verification current across report-only commits while still invalidating changed code, so closing a local improvement does not repeat expensive suites.
- Separate periodic problem discovery from bounded iterative improvement of one frozen metric. Preserve the initial baseline, best candidate and rejected attempts; test a shared premise after repeated failures instead of retrying the same assumption. Vet measurement sensitivity, work/error counts and correctness before trusting speedups.
- Bundle a dependency-free experiment comparator and append-only JSONL journal with contract fingerprints, conservative noise thresholds, semantic exit codes, duplicate-ID protection and exclusive writes. Local keep decisions remain provisional until independent review and final verification.
- Add `self-improve`: discover recurring performance, test-cost and workflow problems without per-candidate instructions under a standing delegation; iterate one bounded hypothesis at a time, reuse the existing review/task/report workflow, require a separate-session review for every autonomous improvement, and prepare a PR. Large or behavior-changing proposals remain for owner judgment; automatic merge requires separate delegation.
- Add operating, measurement and review procedures plus reviewer/PR templates. Preserve verification scope, record raw comparable evidence and cumulative budgets, avoid repeated long simulations, and distinguish local benchmarks from full-run results. Missing review, execution budget or final checks remain explicit.
- Route explicit continuous-improvement requests and due, enabled idle coordinator sessions to the skill. Activation connects project agent instructions and, when available, a real external scheduler; installation alone does not run a background service. The built-in unit loop and its no-work termination are unchanged.

## 0.8.1

- Keep the open design out of STATE. A design is now checkout-local interactive state in the checkout's own Git directory (`haeram-interactive.json`, written by `vibe design start|end`): STATE travels with every planning commit and `vibe plan-push` to the planning branch and into every worktree, so a `## design` line there could reach unrelated worktrees and stop their push, preflight and loop. `vibe status`, `vibe push`, preflight and `vibe loop` read the local state, so only the designing checkout is held. Starting a design leaves the working tree clean.
- Common rule 2 asks before committing or pushing when `vibe status` reports `design`. FORMAT moves the design rules from State rules to Sessions; the STATE skeleton no longer has `## design`, and lint warns when a 0.8.0 `## design` section remains.

## 0.8.0

- Add `start-design`, a pair-only live design mode. It marks the checkout as designing in a new optional STATE section `## design` (`- since:<ISO UTC> | tag:<tag> | scope:<text>`, kept uncommitted next to the edits), keeps a hot-reload dev server up and edits code exactly as the user describes — no tests, e2e, task files, SSOT edits, commits or pushes while the design is open. When the user says the design is finished it runs every test, then makes one commit with the design, its test updates and STATE log `- YYMMDD design <area>: <what>`.
- Add `vibe design start|verify|end` (plain `vibe design` reports the open design). `start` resumes a design left open by an earlier conversation with its own since and tag. `verify` runs every ARCH task and batch command once on the uncommitted working tree at the batch tier, under the heavy lock and check cache; fast checks run first and a failure there skips the slow suites. `--verify <command>` overrides the batch commands.
- Every skill now asks whether the design is finished before any commit or push while STATE `## design` exists (common rule 2). `vibe status` reports `design` and routes `design` first; start-vibe asks the user in pair and parks it in autopilot. `vibe push` refuses, autopilot preflight fails with a needs-user `design` check and `vibe loop` stops while a design is open. STATE merges union the design section; lint checks one well-formed design line.

## 0.7.7

- Make one planning branch (STATE cfg `plan`, default `main`) the home of every task ID and planning document, whichever checkout or worktree plans. `vibe plan-sync` merges its latest before planning; `vibe plan-push` replays spec-only planning commits onto it (pushed when the remote has the branch, independent of cfg push; otherwise the clean local branch is fast-forwarded) and merges the result back so later task archiving cannot resurrect published tasks. A T### another checkout published first is refused with the colliding files, and the losing checkout renumbers. Commits touching code are refused. `plan: -` keeps the previous single-checkout behavior.

## 0.7.6

- Make start-vibe's default final verification coordinator-owned: workers and reviewers run affected unit tests and fast checks, units collect locally, and one host runs integration/e2e/full suites on the integrated candidate before the target-branch push. Align existing-group migration, skill handoffs and runner examples. Per-unit loop publication now requires explicit `--push-each-unit`; strict-mode `vibe claim` shares only ownership metadata on the remote tree while keeping pending code local.
- Automatically lock batch/group checks, recheck cached passes inside the lock, reject delegated final checks unless explicitly overridden with `--allow-final`, and fail final checks when the committed candidate changes. Guard pushes with `--verified-commit` so remote synchronization cannot silently publish unverified changes.

## 0.7.5

- Archive fully converted ideation documents under `spec/ideation/done/` and remove their STATE rows. Partial conversion stays ready; both create-ssot and update-ssot compare the adopted scope against the actual SSOTs before archiving. Preserve unresolved work in an active follow-up document.
- Lint ideation status, skeletons, domain mappings, unresolved items and archive/STATE conflicts. Keep inbox references valid across archival, accept legacy unmarked domains as adopted, and warn when legacy converted documents still need moving. Archived discussions are historical records rather than current planning inputs.

## 0.7.3

- Track runner integration failures and bounded transient retries by submission ID (or submitted commit), allowing repaired and reapproved attempts to integrate in the same run without repeatedly retrying a failed submission. Applies to Claude, Codex and command adapters.
- When approved submissions cannot integrate and no jobs remain, return `needs-attention` with their attempt IDs instead of waiting on unrelated decisions. Log decision-wait targets, questions and deadlines to stderr and runtime history.
- Default autopilot decision waits to 15 minutes (900000ms); explicit `--decision-wait-ms` still takes precedence. Pair mode keeps its immediate return for unanswered decisions so the user can decide; its unused two-hour wait default remains for compatibility. Coordinators resume immediately after a planning commit and express ordering through task dependencies and notes.

## 0.7.2

- Autopilot resolves reversible planning decisions through the planning skills and records its choices instead of waiting for a user. Blocked tasks receive a fresh recovery unit; CI failures queue a prioritized repair and continue within the configured limits. Persist pending repairs and final CI evidence for resumption.
- Task sessions run affected unit tests and fast checks. Integration/e2e suites run at the target-branch push or final completion gate, with one CI wait per code batch and explicit records of deferred checks.
- The publishing workflow runs its release gate once, avoiding a second identical run through the npm publish lifecycle.
- Remove target-project details from reusable instructions and examples; anonymize historical measurement identifiers. Document project independence for both coding agents.

## 0.7.1

- create-task: shared helpers and types get one common location named in impl notes (and in that task's touches), later tasks point to them by name; tunable values are written as config names, with the number only in the task that defines the config. Applies to solo work too, not only work-group foundations.
- implement-task: search for an existing helper/type/config before writing a new one; solo work may move a helper to a shared file outside touches (noted in limits), workers reuse or note it; read tunables through their config. Before the commit, skim the task's own diff for redefinitions, literal numbers that have a config, unread configs/exports, stale comments and repeated expressions.
- review-task: those same points are findings.

## 0.7.0

- Report with measurements, limits and migration steps: [docs/0.7.0.md](docs/0.7.0.md).
- One brief assembler for `vibe brief` (standalone) and `work brief` (work groups, runner, `vibe loop`): the task; the current rules of each cited domain (STATE cfg `brief: domain`, the default) or only the cited decisions (`brief: cited`); what they require (`→!`) or delegate to (`→=`), transitively; decisions that reference a cited one; the global rules (cfg `always`, default every ARCH decision); the flow·constraints of each domain it draws from; chg lines after a stale base; the inbox lines about it. Whole blocks, never cut to a size.
- Reference kinds in FORMAT: `→!` requires, `→=` canonical, `→~` related, `→` unclassified (every existing reference). Unclassified references are followed one hop from a block the task depends on and listed beyond it; `/` lists, `–` ranges, whole-domain `→ID` and bare IDs are parsed. Existing SSOTs are not reclassified.
- `vibe brief` takes `T###`, `ID-n` (with referrers), `ID` and `ID@rev` (history since rev), `--ref <commit>` and `--deep`; it prints markdown ending in an `end … chars:N` line (`--json` for data) and exits 1 when incomplete. Provenance: source (working tree with HEAD and dirty spec files, or one commit), domain path·rev·sha256, block path·lines·sha256.
- `decisionBlocks` keeps every line up to the next top-level bullet or heading (unindented tables and continuation lines were dropped before).
- lint: broken typed references are errors, broken unclassified ones and canonical cycles warnings, the unclassified count a review hint; cfg `always` entries must exist and cfg `brief` is `domain` or `cited`.
- create-task cites every decision a task's implementation must obey, so a project can move to `brief: cited` (measured on a 13-SSOT project: `cited` answered 13 of 25 policy questions on existing tasks, `domain` all 25).
- Skills read decisions through the brief; completeness is per block and per brief (`end` line, complete:yes) instead of "the doc's `## chg` is visible". Built-in adapters pass the brief to the model as markdown; adapter payloads keep the JSON shape.

## 0.6.0

- Report with measurements and limits: [docs/0.6.0.md](docs/0.6.0.md).
- Add `vibe loop`: serial fresh Claude/Codex sessions, single-unit results, one preflight/report/tag, bounded retries and work/time limits, stop markers, detached hosts and persistent logs/session IDs.
- Add `vibe ci wait` and `vibe push --wait-ci`: CLI-owned waiting with backoff, authenticated gh/token API or public HTML, exact commit checks, bounded no-run handling and workflow path filters. No anonymous API polling.
- Add standalone `vibe brief` and scoped FORMAT excerpts; summarize STATE and test output, retain full check logs and persist the task-start diff base.
- Default to task checks, one batch gate before a code push and CI after push; understand ARCH task/batch/CI decision sub-lines and flag missing tiers as review hints.
- Keep task commits while batching solo pushes/reports; retain strict remote claims with other sessions. Allow small bug/wording/style fixes without a task file under explicit size and policy limits.
- Shorten common skills and load work-group/pair details only when needed. Preserve the existing work runner and installer lock format for both agents.
