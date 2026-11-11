# Unattended execution reliability

## Required behavior

- The initiating conversation owns the user's objective, deadline, global
  recovery budget, final verification and remote result. CLI hosts assist with
  execution and durable records; their termination is an input to orchestration,
  not proof the objective is complete. The conversation awaits a foreground
  helper or a real parent continuation bridge. After a recoverable CLI failure
  it re-plans targeted fixes through fresh delegated units or the ordinary skill
  workflow, preserving cumulative attempt history and the user's original
  deadline and total budgets. A helper's automatic-repair cap alone does not
  finish the user's task. It records generic CLI
  defects for later maintenance instead of adding package repairs to the target
  project's task. Missing continuation or notification capability is disclosed.
- Final verification recovery has a cumulative failed-round cap and remains
  inside the existing deadline and closing reserve. The same completely observed
  command plan may earn a bounded additional repair when its failed-command set
  strictly shrinks. A structured check adapter may certify complete test IDs;
  generic test-output parsing never certifies completeness. Equal, new, unknown
  or interrupted failures do not prove progress. Every exit identifies the attempts, remaining
  repair work and publication result. A failed candidate is never published as a
  verified integration.
- A running host may accept an explicit deadline and closing-reserve update.
  Application preserves its run identity and consumed budget, validates the new
  values and returns a durable receipt with the actual deadline, reserve and
  work cutoff. An accepted request is not an applied configuration. A change to
  publication frequency does not establish a deadline.
- Startup exposes the available termination delivery mechanism. Terminal events
  remain durable and available to a parent integration, while local records and
  successful hook invocation remain distinct from confirmed user delivery. An
  unattended launcher discloses when it cannot send an automatic chat update.
- A request to continue remotely preserves the current work on an explicitly
  named work/checkpoint branch without broadening the request into repairs or
  final integration. Its result reports the remote ref, commit, verification
  status and next action. Existing final-publication verification remains intact.
- Status defaults to bounded current ownership/work summaries without embedded
  briefs or historical payloads. Detailed history is explicitly requested.
  Large briefs offer a compact index and selected complete blocks; full context
  remains available and omissions/coverage are explicit. Required SSOT closure
  is never silently cut to fit an output limit. Custom verification guidance is
  available through `vibe brief --section guidance` with the same offset, limit
  and snapshot contract as decision pages; a count alone is not readable guidance.
- Standalone execution probes use the actual checkout and execution permissions.
  Dependency absence, network restriction and permission denial remain separate
  diagnostic outcomes. A successful equivalent preflight is not duplicated by
  the launcher.

## Verification and limits

Regression tests use fake workers and isolated Git repositories. They cover
progress and non-progress, hard attempt/time bounds, applied control receipts,
notification capabilities and delivery results, remote preservation, compact
output with explicit detail access, and actual-workspace probe diagnostics.
These checks do not prove an external messaging integration delivers to a user,
nor do they bypass network or execution permissions.

The triggering observations came from an older running host than the installed
package. Existing fixes must be checked against the current implementation;
upgrading a package does not retrofit a live host. Reported output sizes were
tool estimates, not measured billed-token consumption.
