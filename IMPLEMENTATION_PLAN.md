# Session task persistence implementation plan

## Outcome
Fixed scheduled tasks survive supported Pi session resume/branch reconstruction with stable task IDs and schedule metadata; self-paced loops are intentionally ephemeral. Avoid changing unrelated scheduler behavior.

## Approach
1. Inspect the current registry/scheduler lifecycle and Pi's installed session custom-entry and branch APIs/docs. Establish when `session_start`/session changes fire and how to read the active branch, not the entire tree.
2. Introduce a versioned, validated persisted event schema for fixed-task create/update/delete (including schedule, next fire time, and optional expiry metadata). Emit events on actual scheduler mutations, including expiry/deletion where applicable; never persist self-paced wakeup state. Ensure internal restore does not write duplicate events.
3. Reconstruct by replaying relevant entries in active branch order; delete tombstones override creates; ignore or safely report malformed/newer schema. Rehydrate same IDs without duplicate timers on reload/resume; isolate switched sessions and branches and dispose previous state.
4. Restore only unexpired fixed recurring tasks; skip missed one-shots and self-paced tasks. Preserve schedule metadata, existing due/idle guarantees and deterministic IDs.
5. Test realistic entry sequences (create/update/delete, divergent branches, unknown versions, duplicate reload, expiry and missed one-shot, self-paced exclusion), extension lifecycle and normal fixed scheduling regression.

## Verification / boundaries
Run `npm run typecheck`, `npm test`, `git diff --check`; report exact exit codes and any unsupported Pi lifecycle flow. Only edit this worktree. Do not commit, push, create PR, inspect issue trackers, or delegate. The reviewer will independently review, commit and create a closing PR when ready.
