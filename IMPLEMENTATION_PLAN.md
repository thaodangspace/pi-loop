# Recurring-task expiry and deterministic jitter implementation plan

## Outcome
Recurring scheduled tasks expire after a bounded lifetime (target 7 days), and deterministic task-ID-based jitter spreads load without shifting cadence unpredictably. Behavior survives Pi session restore and never runs expired jobs.

## Approach
1. Map fixed task creation, timer re-arming, due queue, session persistence and restore, including the existing optional `expiresAt` field. Document how fixed cron boundaries and nextFireAt work.
2. Default recurring fixed tasks to expiry 7 days from creation (explicit expiry may shorten it). Define and test deterministic policy for a due run exactly at expiry; remove expired jobs from registry, timer, due queue and persisted state. Ensure expiration occurs even if Pi remains busy, rather than waiting for a run.
3. Compute a stable offset from task ID using a documented deterministic hash. Bound it relative to cadence (especially 1-minute tasks) and apply it consistently to recurring boundaries without accumulating drift. Never jitter one-shots/self-paced; preserve offset across restore with the same ID, schedule/anchor and metadata.
4. Cover short/long intervals, different IDs, hash stability, expiry boundary, busy expiry, and restore near/after expiry with deterministic virtual clocks. Preserve fixed task status, command compatibility and per-task due order.

## Verification / boundaries
Run `git diff --check`, `npm run typecheck`, `npm test`; report exact exit codes and limitations. Only edit this worktree. Do not inspect issue trackers, commit, push, create PR, or delegate; the reviewer will review and publish separately.
