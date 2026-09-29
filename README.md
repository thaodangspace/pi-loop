# pi-loop

A [Pi](https://github.com/earendil-works/pi) extension that repeats a task in the
current session at a fixed interval. Ask once and Pi keeps performing the task
and reporting in the conversation while the session stays open.

```
/loop check all tmux sessions and handle results
/loop every 30min check Things and report changes
/loop stop
/loop status
```

## What it does

- `/loop <task>` repeats `<task>` at the configured default interval (1min).
- `/loop every <n><unit> <task>` uses an explicit interval. Units: `s`, `min`,
  `h` (singular, plural, and abbreviated spellings are accepted, e.g. `30min`,
  `90s`, `2 hours`).
- `/loop stop` cancels the loop and any queued run.
- `/loop status` reports the active task, interval, and whether a run is queued.

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
- The file is re-read on every bare-task command; changes affect newly created
  loops, not an already running timer.
- A malformed, wrongly shaped, or unreadable file is reported as an error and
  the active loop is left unchanged. An explicit `/loop every ...` command never
  reads the config.
- These override paths/values are honoured: `PI_CODING_AGENT_DIR` moves the
  agent directory, and `PI_LOOP_CONFIG` points directly at a config file.

## Behavior and limits

- **First run is delayed.** A loop's first run happens one full interval after
  the command, never immediately.
- **One loop per session.** Creating a new loop replaces the old one and cancels
  its timer.
- **Busy ticks coalesce.** If Pi is busy when a run is due, missed ticks collapse
  into a single pending run delivered once Pi is idle again. Pi is never
  interrupted and no backlog accumulates.
- **In-memory only.** Loops do not survive restart, reload, or session
  replacement, and they do not run while Pi is closed.
- **Stopping does not abort work already running.** It prevents future loop
  messages only.
- **Minimum interval is 1 second.** Intervals must be positive whole numbers;
  zero, negatives, fractions, unknown units, and oversized values are rejected
  without changing an existing loop.
- Process sleep can delay a run; missed intervals are never replayed.

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
| `src/loop-core.ts` | Command parsing, interval validation, and the timer/idle scheduler (injected clock and dispatch). |
| `src/config.ts` | `loop.json` resolution with an injectable file reader. |
| `src/index.ts` | Pi wiring: command, idle events, and lifecycle cleanup. |

`test/helpers.ts` provides a virtual clock and a fake Pi API. Scheduler and
adapter tests never sleep — they drive time explicitly and assert coalescing,
replacement, stop, dispatch errors, and cleanup.

### Live smoke test

Non-interactive `--print` mode has no UI, so command notifications are not
visible there. To exercise the loop live, run RPC mode and drive it over stdio:

```bash
pi --mode rpc --no-session --no-extensions --extension ./src/index.ts
```

Then send `{"type":"prompt","message":"/loop every 5s <task>"}` on stdin. The
stream shows `extension_ui_request` notifications for the loop and a
`message_start` user message on each run. Send `/loop stop` to cancel.

## Troubleshooting

- **`Usage error: ...`** — the command was incomplete. `/loop` needs a task;
  `/loop every` needs `<n><unit>` and a task.
- **`Loop config error: ...`** — `loop.json` is malformed, unreadable, or has an
  invalid `defaultInterval`. Fix the file or use an explicit interval.
- **A task beginning with `stop`/`status` is treated as a command.** Only the
  exact words `stop` and `status` are commands; longer text such as
  `stop the build server` is a task.
- **The loop did not survive a restart.** This is intended; loops are per-session
  and in-memory only.
