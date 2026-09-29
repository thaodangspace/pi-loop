# Model-callable scheduler tools implementation plan

## Outcome
Expose create/list/delete scheduled tasks and schedule/stop self-paced wakeups as typed Pi tools. Tools and `/loop` share the same registry and scheduler state; stable IDs and safe validation permit the model to inspect and control tasks without duplicate scheduling logic.

## Approach
1. Inspect installed Pi extension `registerTool` types/docs/examples, annotations, result shapes, and current scheduler API. Define concise names, input schemas and explicit read-only vs mutating metadata; keep names distinct from slash commands.
2. Add a typed create operation for fixed scheduling with validated interval/prompt and optional expiry; use existing scheduler service rather than implementing new timers. Expose list from authoritative registry/scheduler state with IDs, mode, next fire, expiry and pending status; expose delete by ID with clear not-found behavior.
3. Add wakeup reschedule (delay/reason, 1min–1h clamp via service) and stop operations scoped to the active self-paced loop. Do not let a stale/incorrect ID mutate another loop. Preserve `/loop` status/stop coherence and persistence for fixed tasks; pending deletion must remove its queued run.
4. Test real Pi tool registration contract (schema and annotations) plus invocation against extension harness: invalid IDs, task limits, malformed intervals/prompt, fixed creation/deletion, pending-job cancellation, self-paced clamp/reschedule/stop, command/tool consistency. Document tool names, expected results and safety boundaries.

## Verification / boundaries
Run `git diff --check`, `npm run typecheck`, `npm test`; report exact exit codes and unresolved API constraints. Only edit this worktree; do not inspect issue trackers, commit, push, create PR or delegate. The reviewer will inspect and publish when ready.
