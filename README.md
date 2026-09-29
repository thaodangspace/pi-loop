# pi-loop

A [Pi](https://github.com/earendil-works/pi) extension that repeats a task in the
current session, either at a fixed interval or with each iteration pacing its own
next wakeup. Ask once and Pi keeps performing the task and reporting in the
conversation while the session stays open.

```
/loop check all tmux sessions and handle results
/loop 30min check Things and report changes
/loop check Things and report changes every 30min
/loop stop
/loop status
```

## What it does

- `/loop <task>` starts a **self-paced** loop: the task runs now, and each
  iteration chooses when it should run again (with `/loop`'s wakeup service) or
  stops the loop. Delays are clamped to 1 minute–1 hour.
- `/loop <n><unit> <task>` uses an explicit interval (Claude-style), e.g.
  `/loop 5m check deploy`. This is a fixed schedule.
- `/loop <task> every <n><unit>` uses an explicit interval written after the
  task, e.g. `/loop check deploy every 5m`.
- `/loop every <n><unit> <task>` is a Pi-compatible alias for the above.
- Units `s`, `min`, `h`, and `d` are accepted, along with singular, plural, and
  abbreviated spellings and a spaced unit, e.g. `30min`, `90s`, `2 hours`,
  `30 min`, `1d`, `2 days`.
- Intervals are normalized to a cron cadence and the effective value is
  reported. The scheduler works in whole minutes: seconds round up to the next
  whole minute (`30s` → `1min`, `61s` → `2min`), and whole-minute steps that do
  not map to a clean cron cadence round to the nearest one (`7m` → `6min`,
  `90m` → `2h`). Claude-style boundaries are honored, so a `5min` loop started
  at 12:03 first runs at 12:05.
- `/loop stop` cancels the loop and any queued run.
- `/loop status` reports the active task, whether it is self-paced or fixed, the
  effective interval, and whether a run is queued or a wakeup is pending.
- Bare `/loop` and interval-only `/loop <n><unit>` are recognized as
  **maintenance** loops. The maintenance prompt lands in a later change, so for
  now they report that maintenance mode is not yet available and leave any
  running loop untouched.
- Interval-looking input that cannot be parsed (for example `/loop 5x check`,
  `/loop 1h30min check`, or `/loop .5h check`) fails closed with a usage error.
  It never becomes task text and never disturbs an existing loop.

### Self-paced loops

A prompt-only `/loop <task>` does not run on a cadence. Instead, the first
iteration runs as soon as Pi is idle, and that iteration decides what happens
next:

- **Choose the next wakeup.** The iteration can request a delay (and an optional
  reason) through the scheduler's wakeup service. The delay is clamped into
  **1 minute–1 hour** and stored on the task as an absolute `nextFireAt`, with
  the reason kept for `/loop status`.
- **Stop explicitly.** The iteration can end the loop, which removes the task
  and cancels any timer.
- **Fall back safely.** If the iteration settles without doing either, the
  scheduler grants **one bounded fallback wakeup** using the configured fallback
  delay (clamped to 1 minute–1 hour). If that fallback iteration also fails to
  choose, the loop terminates instead of spinning forever.

Self-paced wakeups respect the same idle/due rules as fixed loops: a wakeup that
comes due while Pi is busy is queued and delivered once when idle, and repeated
misses coalesce into a single run rather than replaying a backlog.

The wakeup service is scheduler state, not a prompt-text convention. The
model-facing operations that call it are tracked separately.

The task is submitted as a normal **user message**, so the agent chooses its own
tools and replies in the conversation. The text is never executed as a shell
command, and Pi's usual tool permissions apply.

## Requirements

- Pi `0.87` or newer (developed and smoke-tested against `0.87.1`).
- Node 22+ for development and tests.

The extension uses only the documented Pi extension API (`registerCommand`,
`sendUserMessage`, `ctx.isIdle()`, and the `session_start` / `agent_start` /
`agent_settled` / `session_shutdown` events). It does not spawn processes or
timers at load; a timer exists only while a loop is active.

## Install

### During development

```bash
pi --extension ./src/index.ts
```

Pi loads TypeScript directly (via `jiti`), so no build step is needed.

### As a discovered extension

Copy or symlink this directory into Pi's extensions directory, or add it to
settings as a local package (see Pi's `packages.md`). The manifest already
declares the entry point:

```json
{ "pi": { "extensions": ["./src/index.ts"] } }
```

## Configure the self-paced fallback delay

Bare `/loop <task>` (no interval) reads the optional user-level config file
`~/.pi/agent/loop.json`:

```json
{ "defaultInterval": "5min" }
```

For self-paced loops the value is the **fallback wakeup delay**: how long the
scheduler waits before retrying once when an iteration does not choose its next
wakeup. Explicit interval loops ignore the file.

- Missing file → `1min`.
- The configured value is clamped into the supported 1 minute–1 hour wakeup
  range, so a default of `45s` yields a `1min` fallback and is reported as
  normalized.
- The file is re-read on every bare-task command; changes affect newly created
  loops, not an already running timer.
- A malformed, wrongly shaped, or unreadable file is reported as an error and
  the active loop is left unchanged. An explicit `/loop every ...` command never
  reads the config.
- These override paths/values are honoured: `PI_CODING_AGENT_DIR` moves the
  agent directory, and `PI_LOOP_CONFIG` points directly at a config file.

## Behavior and limits

- **Cron-style cadence.** The scheduler works in whole minutes, like the cron
  layer behind Claude Code's `/loop`. Seconds round up to the next whole minute
  (`61s` → `2min`), and whole-minute intervals that do not map to a clean cron
  step (`7m`, `90m`, `45m`, `5h`) round to the nearest supported cadence. When a
  request is rounded, the notification says which cadence was picked. Day
  intervals are supported.
- **Absolute boundaries, no drift.** Fire times are fixed schedule boundaries
  (`anchor + k × cadence`, anchored on the Unix epoch by default), not
  `now + interval`. A late timer, a long agent turn, or a clock jump never
  shifts later boundaries. The first run is at the next boundary, so a `5min`
  loop started at 12:03 first runs at 12:05.
- **One loop per session.** Creating a new loop replaces the old one and cancels
  its timer. Behind the command, the active loop is stored as a single `fixed`
  or `self-paced` task in a per-session task registry with a stable ID, its
  timing state, and a computed `nextFireAt`. Later changes build on this for
  multiple concurrent, self-paced, and persisted tasks.
- **Self-paced wakeups are relative and clamped.** A self-paced iteration's
  requested delay is measured from when it asks, clamped into 1 minute–1 hour,
  and stored with an optional reason. A missing choice gets one bounded fallback
  wakeup; a second consecutive miss terminates the loop.
- **Missed runs coalesce; no backlog.** If Pi is busy when a boundary or wakeup
  is due, the run becomes pending and is delivered once Pi is idle again.
  Occurrences are never replayed one-per-missed-interval.
- **In-memory only.** Loops do not survive restart, reload, or session
  replacement, and they do not run while Pi is closed.
- **Stopping does not abort work already running.** It prevents future loop
  messages only.
- **Minimum cadence is 1 minute.** Fixed intervals must be positive whole
  numbers with a unit; zero, negatives, fractions, unknown units, and values
  whose normalized cadence overflows the maximum timer delay (about 24 days) are
  rejected without changing an existing loop. Self-paced wakeup delays are
  clamped into the same 1 minute–1 hour minimum/maximum instead of being
  rejected.
- **Boundaries are UTC-based for now.** Minute and hour cadences are unaffected
  for whole-hour timezones, but a `1d` loop currently runs on the UTC day grid.
  Local-time cron and timezone-safe calculation are tracked separately.
- Process sleep can delay a run; on wake, missed boundaries collapse into one
  run and the schedule resumes on the grid.

## Costs and safety

Every run sends a real prompt to the model, consuming tokens and possibly
calling tools. Use gentle intervals, and choose tasks that are safe to run
repeatedly. A loop can trigger costly or destructive tool use — pick a task you
would be comfortable approving each time, and prefer read-only or idempotent
work. Task text appears in the session transcript, so avoid secrets in the task.

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # tsx --test test/*.test.ts
```

The logic is split so it can be tested without Pi:

| Module | Responsibility |
|---|---|
| `src/loop-core.ts` | Command parsing, interval parsing/validation, and the fixed + self-paced scheduler (wakeup clamping, bounded fallback, boundary-aligned timer/idle handling, injected clock and dispatch). |
| `src/schedule.ts` | Fixed schedules: cadence normalization (cron granularity and clean steps) and `nextFireAt` boundary calculation. |
| `src/task-registry.ts` | Per-session `ScheduledTask` registry: stable IDs, create/list/get/delete, active-task limit, stored schedules, wakeup reasons, and deterministic disposal (injected clock and ID generator). |
| `src/config.ts` | `loop.json` resolution with an injectable file reader. |
| `src/index.ts` | Pi wiring: command, idle events, and lifecycle cleanup. |

`test/helpers.ts` provides a virtual clock (including a `sleep` jump that leaves
timers overdue), a deterministic registry factory, and a fake Pi API. Scheduler
and adapter tests never sleep — they drive time explicitly and assert boundary
alignment, normalization, coalescing, long busy periods, clock jumps,
replacement, stop, dispatch errors, cleanup, and the self-paced reschedule,
clamp, bounded-fallback, termination, and stale-callback paths.

### Live smoke test

Non-interactive `--print` mode has no UI, so command notifications are not
visible there. To exercise the loop live, run RPC mode and drive it over stdio:

```bash
pi --mode rpc --no-session --no-extensions --extension ./src/index.ts
```

Then send `{"type":"prompt","message":"/loop every 5min <task>"}` on stdin. The
stream shows `extension_ui_request` notifications for the loop and a
`message_start` user message on each run. Send `/loop stop` to cancel.

## Troubleshooting

- **`Usage error: ...`** — the command was incomplete or an interval could not
  be parsed. Add a task, or fix the interval (for example `/loop every <n><unit>
  <task>` needs both an interval and a task). Malformed interval-looking input
  never becomes a task and never disturbs an existing loop.
- **`Loop every 1min (normalized from 30s): ...`** — the requested interval was
  rounded to a cron cadence (whole minutes; clean steps). The effective cadence
  is the one in the message.
- **`Self-paced loop: ... (fallback wakeup in ...)`** — a prompt-only `/loop
  <task>` is pacing itself. The delay shown is the clamped fallback wakeup used
  if an iteration does not choose one.
- **`Self-paced loop stopped after a repeated missing wakeup.`** — two
  iterations in a row neither rescheduled nor stopped, so the loop was terminated
  instead of spinning. Start it again with `/loop` if needed.
- **`Maintenance loops ... are not available yet.`** — bare `/loop` and
  interval-only `/loop <n><unit>` are recognized, but the maintenance prompt is
  a later change. Pass a task (for example `/loop 5min <task>`) to start a loop.
- **`Loop config error: ...`** — `loop.json` is malformed, unreadable, or has an
  invalid `defaultInterval`. Fix the file or use an explicit interval.
- **A task beginning with `stop`/`status` is treated as a command.** Only the
  exact words `stop` and `status` are commands; longer text such as
  `stop the build server` is a task.
- **The loop did not survive a restart.** This is intended; loops are per-session
  and in-memory only.
