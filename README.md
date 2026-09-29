# pi-loop

A [Pi](https://github.com/earendil-works/pi) extension that repeats a task in the
current session at a fixed interval. Ask once and Pi keeps performing the task
and reporting in the conversation while the session stays open.

```
/loop check all tmux sessions and handle results
/loop 30min check Things and report changes
/loop check Things and report changes every 30min
/loop stop
/loop status
```

## What it does

- `/loop <task>` repeats `<task>` at the configured default interval (1min).
- `/loop <n><unit> <task>` uses an explicit interval (Claude-style), e.g.
  `/loop 5m check deploy`.
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
- `/loop status` reports the active task, the effective interval, and whether a
  run is queued.
- Bare `/loop` and interval-only `/loop <n><unit>` are recognized as
  **maintenance** loops. The maintenance prompt and self-paced behavior land in
  a later change, so for now they report that maintenance mode is not yet
  available and leave any running loop untouched.
- Interval-looking input that cannot be parsed (for example `/loop 5x check`,
  `/loop 1h30min check`, or `/loop .5h check`) fails closed with a usage error.
  It never becomes task text and never disturbs an existing loop.

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

## Configure the default interval

Bare `/loop <task>` (no `every`) reads the optional user-level config file
`~/.pi/agent/loop.json`:

```json
{ "defaultInterval": "5min" }
```

- Missing file → `1min`.
- The configured value is normalized like any other interval, so a default of
  `45s` schedules at `1min` and is reported as normalized.
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
  task in a per-session task registry with a stable ID, a normalized schedule,
  and a computed `nextFireAt`. Later changes build on this for multiple
  concurrent, self-paced, and persisted tasks.
- **Missed runs coalesce; no backlog.** If Pi is busy when a boundary passes,
  missed boundaries collapse into a single pending run delivered once Pi is
  idle again. Occurrences are never replayed one-per-missed-interval.
- **In-memory only.** Loops do not survive restart, reload, or session
  replacement, and they do not run while Pi is closed.
- **Stopping does not abort work already running.** It prevents future loop
  messages only.
- **Minimum cadence is 1 minute.** Intervals must be positive whole numbers with
  a unit; zero, negatives, fractions, unknown units, and values whose normalized
  cadence overflows the maximum timer delay (about 24 days) are rejected without
  changing an existing loop.
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
| `src/loop-core.ts` | Command parsing, interval parsing/validation, and the boundary-aligned timer/idle scheduler (injected clock and dispatch). |
| `src/schedule.ts` | Fixed schedules: cadence normalization (cron granularity and clean steps) and `nextFireAt` boundary calculation. |
| `src/task-registry.ts` | Per-session `ScheduledTask` registry: stable IDs, create/list/get/delete, active-task limit, stored schedules, and deterministic disposal (injected clock and ID generator). |
| `src/config.ts` | `loop.json` resolution with an injectable file reader. |
| `src/index.ts` | Pi wiring: command, idle events, and lifecycle cleanup. |

`test/helpers.ts` provides a virtual clock (including a `sleep` jump that leaves
timers overdue), a deterministic registry factory, and a fake Pi API. Scheduler
and adapter tests never sleep — they drive time explicitly and assert boundary
alignment, normalization, coalescing, long busy periods, clock jumps,
replacement, stop, dispatch errors, and cleanup.

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
