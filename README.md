# GUSTA

**English** | [한국어](README.ko.md)

> *Gustum usque sere, tuum aperi.*
> Cultivate your taste continuously, and open yours to the world.

**A Spec-Driven Development (SDD) framework for code curators — cultivate and exhibit your taste.**

AI now drafts the plan, writes the code and runs the checks. What is left for people is deciding **what stays**: what goes in and what is left out, which decisions to accept and which to send back. That choice is what shapes a product. GUSTA treats the developer not as a coder but as a **curator** who grows a sense of taste and selects and arranges good specs and good code. AI makes the proposals, the implementation and the verification; you choose.

*Gusta* is Latin for "taste! savor!", and in Spanish *me gusta* means "I like it" — the first letters of the motto spell G·U·S·T·A. GUSTA is an SDD framework that turns your own taste and standards into a system: Agent Skills for Claude Code and Codex that grow an idea into a spec and carry it through **requirements → design → task plan → implementation → verification**, each step's output becoming the next step's input. The npm package is only the way those skills are installed and kept in sync across your projects.

## Why GUSTA?

- **The spec is the first-class document.** Decisions live in the SSOT, progress in STATE, implementation plans in tasks — and they change before the code does. A planning gap found mid-implementation goes back to the spec instead of being settled silently in code.
- **AI makes, you choose.** In *together* mode GUSTA gathers recommendations and options at each decision point. In *hand-off* mode it never stops to ask: it takes the recommendation and leaves each question, with the answer it picked, in a **decision inbox** you review when you are back. Changes to result meaning, public contracts or verification scope are proposed, never applied on their own.
- **Hand it off and walk away.** `vibe loop` starts a fresh session for every task or planning slice, so context never piles up. Each task runs only impacted unit tests and fast checks; the full suite, push and CI run once at a final gate whose length is measured, not guessed.
- **Choose with your eyes.** Design mode edits code as you talk while you watch the screen. `gusta-showcase` builds 2–6 variants in parallel, serves them side by side and merges only the one you pick.
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

**3. Run `/gusta-start`.**

```text
/gusta-start
/gusta-start let's build a tag feature    ← a request is read before STATE
```

It checks the remote for sessions running on other devices, asks everything at once — mode, what to do first, whether to take over — then reads `spec/STATE.md` and routes to the next skill: `/ideation` when there is nothing yet, planning when ideas are waiting, implementation when tasks are. It commits per task and lands finished work once at the end, as `spec/SETTINGS.md` says (no push by default).

## Core Concepts

### Two modes

| Mode | Decisions | While you are away |
| --- | --- | --- |
| Together | Gathers the options at each decision point and asks | — |
| Hand-off | Proceeds with the recommendation and records it in the decision inbox and a report | Never waits. Parks only billing, data deletion, privacy and security policy, and anything hard to undo or reaching outside the project (force push, branch deletion, deploy/publish) |

Say "I'm heading out" to switch to hand-off; come back and talk, or rerun `/gusta-start`, to return to together — starting with the inbox.

### The `spec/` folder

| Path | Holds |
| --- | --- |
| `STATE.md` | The control tower: settings, active sessions, decision inbox, SSOT revisions, task board, next, log |
| `FORMAT.md` | Compact notation rules for every spec document |
| `SETTINGS.md` | Optional package settings (branch strategy and more); missing keys use defaults |
| `ideation/` | Ideas being refined; `done/` keeps those fully converted to SSOT |
| `ssot/` | Per-domain single source of truth — decisions and reasons only, versioned by `rev` |
| `tasks/` | Remaining tasks; `done/` archives finished ones as history |
| `review/` | Optional code and self-improvement findings |
| `reports/` | Optional hand-off session reports |

Spec documents are written in compact English; interviews, questions and reports use your language.

### Skills you call

| Skill | What it does |
| --- | --- |
| `/gusta-start` | The entry point. Checks other devices, asks the mode once, routes to planning or implementation, commits per task, runs the final gate |
| `/gusta-design-mode` | Live design: edits code as you talk while you watch the screen; tests and a single commit only when you say the design is done |
| `/gusta-showcase` | Builds 2–6 variants in parallel, serves them side by side (or benchmarks them) and merges only the one you pick |
| `/ideation` | Jots down an idea whenever it comes; refines it in a diverge/converge loop if you want |
| `/gusta-self-improve` | Your session approves improvement proposals from sub-sessions and integrates them into the current branch — no PR |
| `/gusta-self-improve-remote` | Within a scope and budget you delegate once, finds problems, measures, implements, gets an independent review and opens a PR |
| `/gusta-init` | Asks only the unset branch-strategy settings and saves them to `spec/SETTINGS.md` |
| `/gusta-preference` | Shows `spec/SETTINGS.md` as a table and changes only the values you name |
| `/gusta-update` | Checks for a new version, reinstalls the skills, migrates `spec/`, reconciles project rules, lints and commits |
| `/gusta-send-issue` | At the end of a session, reviews how GUSTA's skills and CLI behaved, shows the anonymized findings and, once you confirm, files them as an issue on [hetarho/gusta](https://github.com/hetarho/gusta/issues) |

The other ten — `gusta-create-architecture`, `gusta-create-ssot`, `gusta-update-ssot`, `gusta-create-task`, `gusta-implement-task`, `gusta-review-code`, `gusta-doc-review`, `gusta-review-task`, `gusta-manage-work`, `gusta-create-narrative` — are picked by `/gusta-start`. You can also call them by name, or just describe the result: "break the SSOT changes into tasks".

### CLI essentials

```bash
npx @haeram/gusta@latest install            # install or update the skills
npx @haeram/gusta check                     # installed skills match the package
npx @haeram/gusta lint                      # spec/ follows the FORMAT invariants
npx @haeram/gusta vibe status --tag k3f9    # other devices' sessions, remaining work, suggested route
npx @haeram/gusta vibe brief T012           # the decision blocks a task depends on
npx @haeram/gusta vibe loop --tag k3f9 --provider claude --json    # hand-off: a fresh session per unit
npx @haeram/gusta vibe push                 # land finished work as spec/SETTINGS.md says
npx @haeram/gusta work run --work feature --provider codex --json  # parallel workers with a reviewer
```

## Docs

The detailed guides are written in Korean.

| Guide | Covers |
| --- | --- |
| [Workflow](docs/workflow.md) | Philosophy, core principles, every skill, the `spec/` layout, ideation, design mode, showcase, settings |
| [Branching & verification](docs/branching.md) | `land` · `land-via` · `push` · `deploy` · `plan`, verification tiers and the final gate |
| [Autopilot](docs/autopilot.md) | Long hand-offs with `vibe loop`, decision briefs with `vibe brief` |
| [Parallel work](docs/parallel-work.md) | Work groups, lanes, multiple sessions, workers and reviewers |
| [Self-improvement](docs/self-improve.md) | `gusta-self-improve` and `gusta-self-improve-remote` |
| [CLI](docs/cli.md) | Install options, every command, migrating existing projects |
| [Contributing](CONTRIBUTING.md) | Developing this repository and releasing |

Version history is in the [CHANGELOG](CHANGELOG.md); earlier design notes are in [docs/history](docs/history/).

## License

[MIT](LICENSE)
