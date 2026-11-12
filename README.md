# GUSTA

**English** | [한국어](README.ko.md)

> *Gustum usque sere, tuum aperi.*
> Cultivate your taste continuously, and open yours to the world.

**A Spec-Driven Development (SDD) framework for code curators — cultivate and exhibit your taste.**

AI now drafts the plan, writes the code and runs the checks. What is left for people is deciding **what stays**: what goes in and what is left out, which decisions to accept and which to send back. That choice is what shapes a product. GUSTA treats the developer not as a coder but as a **curator** who grows a sense of taste and selects and arranges good specs and good code. AI makes the proposals, the implementation and the verification; you choose. Plan it well up front, and the rest runs by itself.

*Gusta* is Latin for "taste! savor!", and in Spanish *me gusta* means "I like it" — the first letters of the motto spell G·U·S·T·A. GUSTA is an SDD framework that turns your own taste and standards into a system: Agent Skills for Claude Code and Codex that grow an idea into a spec and carry it through **requirements → design → task plan → implementation → verification**, each step's output becoming the next step's input. The npm package is only the way those skills are installed and kept in sync across your projects.

## Why GUSTA?

- **The spec is the first-class document.** Decisions live in the SSOT, progress in STATE, implementation plans in tasks — and they change before the code does. A planning gap found mid-implementation goes back to the spec instead of being settled silently in code.
- **AI makes, you choose.** `/gusta-sketch` draws your idea as one HTML mockup page, with variants side by side when there is a real choice; you pick and refine, and what you decide becomes spec documents and tasks. `/gusta-start` then runs those tasks without asking: it takes the recommendation at each decision point and leaves the question, with the answer it picked, in a **decision inbox** you review when you are back. Changes to result meaning, public contracts or verification scope are proposed, never applied on their own.
- **Plan up front, then walk away.** `vibe loop` starts a fresh session for every task, so context never piles up. Each task runs only impacted unit tests and fast checks; the full suite, push and CI run once at a final gate whose length is measured, not guessed.
- **Choose with your eyes.** Sketch shows the plan on one page and one port, before any code. Design mode edits code as you talk while you watch the screen. `gusta-showcase` builds 2–6 variants in real code in parallel, one port each, merges only the one you pick and updates the docs to match.
- **Small footprint.** Sessions read a brief of just the decision blocks a task depends on. Works with Claude Code and Codex in any Git project — Python, Flutter, Go, not only Node — and `npx` leaves no `node_modules` behind.

## Quick Start

**1. Install.** In your project ([npm](https://www.npmjs.com/package/@haeram/gusta)):

```bash
npx @haeram/gusta@latest install    # the same command updates later
```

Or open the project in Claude Code or Codex and paste:

```text
Install the GUSTA skill set in this project. Don't add it as a dependency; run it with npx.
First check the plan and conflicts with `npx -y @haeram/gusta@latest install --dry-run`.
If it conflicts with existing skills, don't overwrite them — tell me.
Otherwise install with `npx -y @haeram/gusta@latest install`, then verify with `npx -y @haeram/gusta@latest check`.
```

**2. Start a new session** so the agent discovers the installed skills.

**3. Sketch, then start.**

```text
/gusta-sketch let's build a tag feature    ← plan: pick on one HTML page, get spec docs and tasks
/gusta-start                               ← run those tasks unattended
/gusta-start T012 T013 within 4 hours      ← a task scope and a time limit
/gusta-start send reminders once a day     ← a change request: update the spec and tasks, then build it
```

`/gusta-sketch` draws the idea as one self-contained HTML page under `.tmp/sketch/<slug>/` (untracked) and serves it on one local port. You pick and refine; the decided parts become spec documents (ARCH, SSOT) and tasks, and what you put off ("fine, but let's think about it later") is kept in `spec/ideation/`. It changes no product code, and on a new project it sets up `spec/` and the architecture first.

`/gusta-start` asks nothing. It shows the run — target tasks, order and parallelism, deadline, verification gates, land/push settings, tasks held by other devices (skipped) and the inbox count — and starts. It commits per task and lands finished work once at the end, as `spec/SETTINGS.md` says (no push by default). Give it a change request instead and it updates the SSOT and makes the tasks first (what your request states is your decision; gaps get the recommendation and an inbox line), then implements, verifies and lands them the same way. With no request and no runnable tasks it stops and points you to `/gusta-sketch`.

## Core Concepts

### Flow

| Step | You | GUSTA |
| --- | --- | --- |
| `/gusta-sketch` | Look at the page, pick, refine | Draws HTML mockups on one port, writes ARCH/SSOT and tasks, keeps deferred ideas in `spec/ideation/` |
| `/gusta-start` | Nothing — you can leave | Runs the tasks unattended, decides with the recommendation, commits per task, runs the final gate and lands once |
| Back | Review the decision inbox and report | Confirmed lines are removed (`/gusta-start clean up the inbox`); to change a decision, run `/gusta-sketch` |

A run never waits for you. It parks only billing, data deletion, privacy and security policy, and anything hard to undo or reaching outside the project (force push, branch deletion, deploy/publish), and moves on to other tasks.

### The `spec/` folder

| Path | Holds |
| --- | --- |
| `STATE.md` | The control tower: settings, active sessions, decision inbox, SSOT revisions, task board, next, log |
| `FORMAT.md` | Compact notation rules for every spec document |
| `SETTINGS.md` | Optional package settings (branch strategy and more); missing keys use defaults |
| `ideation/` | Ideas you deferred during a sketch; `done/` keeps those later converted to SSOT |
| `ssot/` | Per-domain single source of truth — decisions and reasons only, versioned by `rev` |
| `tasks/` | Remaining tasks; `done/` archives finished ones as history |
| `review/` | Optional code and self-improvement findings |
| `reports/` | Optional `/gusta-start` run reports |

Spec documents are written in compact English; interviews, questions and reports use your language.

### Skills you call

| Skill | What it does |
| --- | --- |
| `/gusta-sketch` | Planning. Draws the idea as one HTML page on one port, lets you pick and refine, turns the choice into spec documents and tasks, and records deferred ideas in `spec/ideation/` |
| `/gusta-start` | Execution. Shows the run info, then runs the existing tasks unattended — commits per task, decision inbox and report, final gate. With a change request it plans (SSOT, tasks) and then runs those. Stops and points to `/gusta-sketch` when there is nothing to run |
| `/gusta-design-mode` | Live design: edits code as you talk while you watch the screen; tests and a single commit only when you say the design is done |
| `/gusta-showcase` | Builds 2–6 variants in real code in parallel, one port per variant (or benchmarks them), merges only the one you pick and updates the docs too |
| `/gusta-self-improve` | Your session approves improvement proposals from sub-sessions and integrates them into the current branch — no PR |
| `/gusta-self-improve-remote` | Within a scope and budget you delegate once, finds problems, measures, implements, gets an independent review and opens a PR |
| `/gusta-init` | Asks only the unset branch-strategy settings and saves them to `spec/SETTINGS.md` |
| `/gusta-preference` | Shows `spec/SETTINGS.md` as a table and changes only the values you name |
| `/gusta-update` | Checks for a new version, reinstalls the skills, migrates `spec/`, reconciles project rules, lints and commits |
| `/gusta-send-issue` | At the end of a session, reviews how GUSTA's skills and CLI behaved, shows the anonymized findings and, once you confirm, files them as an issue on [hetarho/gusta](https://github.com/hetarho/gusta/issues) |

The other ten — `gusta-create-architecture`, `gusta-create-ssot`, `gusta-update-ssot`, `gusta-create-task`, `gusta-implement-task`, `gusta-review-code`, `gusta-doc-review`, `gusta-review-task`, `gusta-manage-work`, `gusta-create-narrative` — are internal: `/gusta-sketch` and `/gusta-start` call them. They are not hidden; the reviewers (`gusta-review-code`, `gusta-doc-review`) and `gusta-create-narrative` also answer a plain request such as "review the code for refactoring".

### CLI essentials

```bash
npx @haeram/gusta@latest install            # install or update the skills
npx @haeram/gusta check                     # installed skills match the package
npx @haeram/gusta lint                      # spec/ follows the FORMAT invariants
npx @haeram/gusta vibe status --tag k3f9    # other devices' sessions, remaining work, suggested route
npx @haeram/gusta vibe sketch serve tag-filter   # serve .tmp/sketch/tag-filter/ on one local port
npx @haeram/gusta vibe brief T012           # the decision blocks a task depends on
npx @haeram/gusta vibe loop --tag k3f9 --provider claude --json    # unattended run: a fresh session per unit
npx @haeram/gusta vibe push                 # land finished work as spec/SETTINGS.md says
npx @haeram/gusta vibe settings --set usage-measurement=true  # opt in to local token/cache reports (default false)
npx @haeram/gusta work run --work feature --provider codex --json  # parallel workers with a reviewer
```

Usage measurement adds no model calls. Enabled adapter runs print a completion summary and save local JSON; unknown usage stays unknown. Host/native sessions require a separate scoped report. Cache hits alone do not establish savings, and reported USD is not subscription quota. See [measurement scope and accounting](docs/usage-measurement.md).

## Docs

The detailed guides are written in Korean.

| Guide | Covers |
| --- | --- |
| [Workflow](docs/workflow.md) | Philosophy, core principles, every skill, the `spec/` layout, sketch, start, design mode, showcase, settings |
| [Branching & verification](docs/branching.md) | `land` · `land-via` · `push` · `deploy` · `plan`, verification tiers and the final gate |
| [Autopilot](docs/autopilot.md) | Long unattended runs with `vibe loop`, decision briefs with `vibe brief` |
| [Parallel work](docs/parallel-work.md) | Work groups, lanes, multiple sessions, workers and reviewers |
| [Self-improvement](docs/self-improve.md) | `gusta-self-improve` and `gusta-self-improve-remote` |
| [CLI](docs/cli.md) | Install options, every command, migrating existing projects |
| [Contributing](CONTRIBUTING.md) | Developing this repository and releasing |

Version history is in the [CHANGELOG](CHANGELOG.md); earlier design notes are in [docs/history](docs/history/).

## License

[MIT](LICENSE)
