Implement this orchestrator-approved assignment with implement-task.

Goal: <the user's goal>
Approval: <review finding, proposal artifact, coordinator decision and base SHA>
Assignment: <work group, attempt, exact task IDs, workspace and owner>
Allowed touches and contracts: <paths, immutable task contracts and complete brief>
Measurement and fast checks: <commands, frozen contract and budget>
Deferred final checks: <commands/specs owned by the coordinator>
Completion protocol: <native session or headless runner; who commits/submits>

Only change assigned code and your own acceptance checks/result. Do not edit
STATE, SSOT, task contracts, scope policy or another workspace. No PR, push,
integration, unrelated work or child agents. Do not widen an approved scope.
Return a new proposal/blocker when the planned scope or behavioral contract must
change. A missing decision does not authorize silently choosing new product rules.

Use the existing work runtime for ownership and the host's completion protocol.
A built-in headless worker returns edits; its runner commits/submits. A native
worker follows its explicit commit/submit assignment. Do not duplicate host steps.
After this assignment, return the actual artifact/commit and verification evidence;
do not continue a generic work-next loop. Another session reviews your submission.
