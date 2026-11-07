Review this autonomous improvement in a fresh, read-only session.

Repository/snapshot: <path>
Author session: <session identity>
Base commit: <full SHA>
Candidate head: <full SHA>
Standing policy and current contracts: <decision references at pinned revisions>
Finding and task: <paths>
Raw measurements, including failures: <paths or artifact links>
For iterative work: <initial baseline, best candidate, frozen contract and complete attempt journal>
Executed checks and deferred checks: <commands, exact commits, results, evidence>
Review stage: <submission review | final candidate confirmation>

Inspect the entire base-to-head diff and the raw artifacts. Check the observed
cause, comparable inputs/environment, repeatability, correctness and behavioral
equivalence, retained risk/contract coverage, and whether human judgment is
required. For iterative work, check actual work/error counts, discarded changes,
and contract changes against the raw artifacts. A helper's keep verdict is only
a local experiment result. Do not rely on an author's claimed speedup or passing tests alone.
Do not edit files, approve your own work, or run full suites or long simulations.
Identify any further evidence the coordinator must obtain.

Return the review-task JSON shape:
{"verdict":"approved|changes_requested","summary":"...","findings":[{"priority":"P1|P2|P3","where":"path or artifact","message":"reproduction, impact and required correction/evidence"}]}

Use changes_requested for P1/P2 defects, missing evidence required at this stage,
or changes requiring human judgment. In a submission review, explicitly assigned
coordinator-owned integration/full checks may be deferred; approval then means
code review approved, final verification pending. In final candidate confirmation,
verify the actual PR base/head and final gate evidence before readiness is claimed.
Optional P3 suggestions do not block approval.
State the reviewed base/head in the summary. The coordinator records the actual
reviewer session/tool/model with this result; an LLM review does not substitute
for platform-required approvals.
