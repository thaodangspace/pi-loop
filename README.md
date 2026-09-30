# pi-loop

A [Pi](https://github.com/earendil-works/pi) extension that repeats a task in the
current session, either at a fixed interval or with each iteration pacing its own
next wakeup. Ask once and Pi keeps performing the task and reporting in the
conversation while the session stays open.

```
/loop check all tmux sessions and handle results
/loop 30min check Things and report changes
/loop check Things and report changes every 30min
/loop
/loop 15m
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
- `/loop status` reports the command-owned loop, then lists **every** tracked
  task with its stable ID, mode, cadence or cron, next due/wakeup, and whether a
  run is queued. Independent tasks created by the model-callable tools are
  therefore visible alongside the loop.
- Bare `/loop` and interval-only `/loop <n><unit>` are **maintenance** loops:
  they run a maintenance prompt rather than one you type. Bare `/loop` is
  self-paced; `/loop <n><unit>` runs on a fixed schedule. See
  [Maintenance loops](#maintenance-loops).
- Interval-looking input that cannot be parsed (for example `/loop 5x check`,
  `/loop 1h30min check`, or `/loop .5h check`) fails closed with a usage error.
  It never becomes task text and never disturbs an existing loop.
- Calendar and one-shot work is available through the model-callable tools
  instead of `/loop`: `schedule_cron_task` creates a 5-field local-time cron task
  (for example `0 9 * * 1-5`), and `schedule_once_task` runs a prompt once. Both
  share the same scheduler, registry, due queue, and persistence. See
  [Cron and one-shot schedules](#cron-and-one-shot-schedules).

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
model-facing operations that call it (`schedule_wakeup` and `stop_wakeup`) and
the task tools are described under [Model-callable tools](#model-callable-tools).

The task is submitted as a normal **user message**, so the agent chooses its own
tools and replies in the conversation. The text is never executed as a shell
command, and Pi's usual tool permissions apply.

### Due queue and flush order

While Pi is busy, a due run is neither delivered nor lost. The scheduler records
it in a per-session **due queue that the scheduler owns** — one entry per task,
independent of the task registry's `pending` mirror. The task's timer keeps
advancing on its schedule, so repeated misses for the same task **coalesce into
the single entry already queued** instead of replaying a backlog.

At the next idle boundary (`agent_settled`), the scheduler flushes every distinct
due task in a deterministic order:

1. The **earliest missed deadline** first.
2. Ties (simultaneous deadlines) broken by the order the scheduler began tracking
   the task.

A flush stops as soon as Pi is busy again — including when a dispatch starts work
synchronously — and the undispatched tasks keep their place for the next idle
boundary. A task deleted from the registry (or stopped), and any timer callback
captured before a stop or replacement, is dropped without dispatching.

### Scheduled-prompt dispatch

Every scheduled run — fixed, self-paced, and maintenance — is delivered through
one dispatch layer that classifies the prompt before sending:

- **Plain text is sent verbatim.** Ordinary tasks, and any `/…` text that does
  not name a loaded command (for example a path such as `/etc/hosts is stale`),
  are delivered exactly as written with Pi's template expansion off, so nothing
  is rewritten or interpreted.
- **A loaded skill or prompt template is expanded.** Scheduling
  `/skill:pdf-tools` or a template such as `/review concurrency` sends the
  prompt with expansion on, and Pi expands it the same way interactive input
  would.
- **Control and unsupported forms are rejected and reported.** An extension
  command (the loop's own `/loop`, a scheduler command, `/reload`, or any other
  extension command), a built-in interactive command, or an unknown
  `/skill:<name>` is refused with an error notification instead of being sent.
  This prevents a loop from accidentally running session control. A rejected
  `/loop <task>` starts no loop; a rejected maintenance prompt skips that run
  (a fixed loop retries at the next boundary, a self-paced loop uses its
  bounded fallback).

Because extension commands are executable and skills/templates are content, only
the latter two categories are ever expanded. The classifier uses Pi's own
`getCommands()` output, so it tracks the commands actually loaded in the
session.

## Maintenance loops

A bare `/loop` (or interval-only `/loop <n><unit>`) runs a maintenance pass
instead of a prompt you type. Bare `/loop` is **self-paced**; adding an interval
makes it a **fixed** schedule, e.g. `/loop 15m`.

Unlike a command-line task, the maintenance prompt is not fixed when the loop
starts. **Every iteration resolves it fresh**, in this order:

1. `.claude/loop.md` in the project directory (project override).
2. `~/.claude/loop.md` (user default).
3. The built-in maintenance prompt.

The first readable, non-empty file wins, so a project override beats a user
default. Because resolution happens on each run, **edits to a `loop.md` take
effect on the next iteration** without restarting the loop. Passing a prompt on
the command line (`/loop 5m <task>`) always bypasses these files.

The file is plain Markdown with no required structure; write it as if you were
typing the `/loop` prompt directly. Content is capped at **25,000 bytes**
(UTF-8); anything longer is truncated to the cap without splitting a character.

- **Missing files are normal.** When neither file exists, the built-in prompt
  runs.
- **Unreadable files are hard errors.** A `loop.md` that exists but cannot be
  read, or is empty/whitespace-only, is reported as a `Maintenance prompt error`
  and that iteration is skipped. The resolver never quietly falls back to the
  other file or the built-in prompt.
- **A skipped fixed run resumes on the next boundary.** A skipped self-paced run
  has no iteration to choose a wakeup, so the same bounded fallback as a missed
  self-paced choice applies (one fallback, then terminate on a repeat).

The built-in prompt continues unfinished work from the conversation, tends to
the current branch's pull request, and runs a cleanup pass when nothing else is
pending, without starting unrelated work or taking irreversible actions.

## Requirements

- Pi `0.87.1` or newer. The `package.json` peer range is `>=0.87.1`, this is the
  version the extension is developed and smoke-tested against, and CI typechecks
  and tests the declared minimum (`0.87.1`) and the newest published line
  (`0.99.1`) on every push and pull request. A version outside that range is not
  claimed to work.
- Node `22.19.0` or newer (`package.json` `engines`), matching Pi's own
  requirement.

The extension uses only the documented Pi extension API (`registerCommand`,
`getCommands`, `sendUserMessage`, `appendEntry`, `ctx.isIdle()`,
`ctx.sessionManager.getBranch()`, `ctx.hasUI`, `ctx.ui.setStatus` /
`ctx.ui.setWidget`, and the `session_start` / `session_tree` / `agent_start` /
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

Bare `/loop <task>` and bare `/loop` (both self-paced) read the optional
user-level config file `~/.pi/agent/loop.json`:

```json
{ "defaultInterval": "5min" }
```

For self-paced loops the value is the **fallback wakeup delay**: how long the
scheduler waits before retrying once when an iteration does not choose its next
wakeup. Explicit interval loops, including `/loop <n><unit>` maintenance loops,
ignore the file.

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

## Runtime visibility

While any task is scheduled, the extension paints two persistent surfaces from
the authoritative registry (never a separate copy):

- a **compact, single-line footer status** with the active loop count and the
  earliest known next fire time as a local clock time, for example
  `⟳ 1 loop · next 09:00`. With more than one task it also reports the per-mode
  counts, for example `⟳ 3 loops · 2 fixed · 1 self-paced · next 09:00`;
- a **widget** below the editor with one line per task, for example
  `t2 · [fixed] · every 10min · next in 8min: check deploy`, including the
  `pending` marker while a run waits for the next idle moment.

The footer is always one line. A single task omits the per-mode breakdown; with
more than one task it lists a count for each mode present (`fixed`,
`self-paced`, `one-shot`). The `next` time is the earliest `nextFireAt` across
the active tasks, rendered as local `HH:MM`; it is omitted when no task has a
computed fire time, and tasks without one still count. A run queued while busy
does not add a row (the `pending` marker stays in the widget and `/loop
status`).

Both surfaces are repainted after every state change: a create/delete/stop from
`/loop` or a tool, a timer tick (including a busy tick that queues a run), a
self-paced reschedule or fallback, a restore, and shutdown. With no tasks left
they are cleared. The surfaces are only used when the client has a UI
(`ctx.hasUI`, i.e. TUI and RPC modes); JSON and print modes are untouched, and
tools and event behavior keep working without rendering.

`/loop status` prints the same per-task lines so the command copy and the
on-screen copy never drift.

## Disable scheduling

Set the environment variable `PI_LOOP_DISABLE` to disable the whole scheduler for
the process:

```bash
PI_LOOP_DISABLE=1 pi --extension ./src/index.ts
```

Explicit semantics: scheduling is disabled **only** when the value is one of
`1`, `true`, `yes`, or `on` (case-insensitive, surrounding whitespace ignored).
Any other value — `0`, `false`, `no`, `off`, an empty string, or an unset
variable — leaves scheduling enabled; there is no implicit truthiness.

When disabled:

- **No scheduling tool is registered.** The model cannot create, list, or delete
  scheduled tasks. `/loop` still loads and explains that scheduling is disabled
  (every invocation reports the switch, whatever its arguments).
- **No timers start, including on restore.** A resumed session's persisted tasks
  are not reconstructed, so nothing can fire.
- Nothing is written to session history, and the status/widget are cleared.

The check happens once at extension load from the environment, or from an
explicit `disabled` dependency when an embedding host supplies one. It is a
startup switch, not a live toggle: reload the extension (or restart Pi) after
changing it.

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
  shifts later boundaries. The first run is at the next boundary plus the task's
  small ID-derived phase, so a `5min` loop started at 12:03 first runs at 12:05
  plus at most 75 seconds.
- **Deterministic per-task jitter.** Each recurring fixed task also carries a
  stable phase offset derived from its ID (a documented FNV-1a hash) and bounded
  to a fraction of its cadence: a quarter of the cadence, capped at one hour.
  A 1-minute task is spread over 15 seconds, a 5-minute task over 75 seconds,
  and an hourly task over 15 minutes, so many same-interval tasks do not all
  fire on the same instant. The offset is fixed for the task's life (no drift)
  and recomputed from the same ID, schedule, and anchor on restore, so a reload
  does not move a boundary. One-shot and self-paced tasks are never jittered.
- **Recurring fixed tasks expire after seven days.** By default a recurring
  fixed task gets `expiresAt = createdAt + 7 days`; an explicit expiry overrides
  (and may shorten or lengthen) it. A boundary exactly at the expiry still runs
  when Pi is idle, but any later run is dropped: if the expiry lands while Pi is
  busy, the task (and its queued run) is removed rather than delivered late. An
  expired task is removed from the registry, its timer, the due queue, and
  persisted state (a delete tombstone), and an expired persisted task is not
  restored. A cadence longer than seven days never reaches its first boundary
  under the default, so pass an explicit `expiresAt` that covers the first run if
  you need one.
- **One command loop per session.** Creating a new loop with `/loop` replaces the
  old one and cancels its timer. Behind the command, the scheduler tracks that
  command-owned loop as a `fixed` or `self-paced` task in a per-session task
  registry with a stable ID, its timing state, and a computed `nextFireAt`. The
  scheduler can also track independent fixed tasks via `scheduleFixed`, and each
  task keeps its own timer and due-queue entry.
- **Self-paced wakeups are relative and clamped.** A self-paced iteration's
  requested delay is measured from when it asks, clamped into 1 minute–1 hour,
  and stored with an optional reason. A missing choice gets one bounded fallback
  wakeup; a second consecutive miss terminates the loop.
- **Missed runs coalesce; no backlog.** If Pi is busy when a boundary or wakeup
  is due, the scheduler marks the task in its own due queue and delivers one run
  once Pi is idle again. Repeated misses for the same task coalesce, and distinct
  due tasks flush in the documented order (earliest missed deadline first, ties
  by registration). Occurrences are never replayed one-per-missed-interval.
- **Fixed loops persist; self-paced loops do not.** A fixed loop
  (`/loop <n><unit> <task>` or `/loop <task> every <n><unit>`) and any
  one-shot/fixed task scheduled through the scheduler are recorded in the
  session as versioned custom entries. On resume or on re-entering a branch they
  are rebuilt with the same stable ID and schedule. Self-paced wakeup state is
  deliberately ephemeral, so a self-paced loop does not survive restart, reload,
  or session replacement. Stops and expiry are recorded as tombstones, so a
  stopped fixed loop stays stopped across a resume. Only the active branch is
  reconstructed, so an abandoned branch's tasks do not leak back in. If a branch
  contains an entry this version cannot read (a malformed entry, or one written
  by a newer schema version), the whole branch fails closed and nothing is
  restored: an unreadable entry might be a tombstone, and restoring around it
  could resurrect a deleted task. Tasks do not run while Pi is closed: missed
  fixed boundaries resume on the grid and a missed one-shot is dropped.
- **Stopping does not abort work already running.** It prevents future loop
  messages only.
- **Minimum cadence is 1 minute.** Fixed intervals must be positive whole
  numbers with a unit; zero, negatives, fractions, unknown units, and values
  whose normalized cadence overflows the maximum timer delay (about 24 days) are
  rejected without changing an existing loop. Self-paced wakeup delays are
  clamped into the same 1 minute–1 hour minimum/maximum instead of being
  rejected.
- **Interval boundaries are UTC-based; cron boundaries are local-time.** Minute
  and hour interval cadences are unaffected for whole-hour timezones, but a `1d`
  *interval* loop still runs on the UTC day grid. A **cron** task (below) is the
  calendar form: its 5 fields are evaluated as wall-clock times in an explicit
  IANA timezone, across DST transitions.
- Process sleep can delay a run; on wake, missed boundaries collapse into one
  run and the schedule resumes on the grid.

## Cron and one-shot schedules

An interval (`/loop <n><unit>`) is one representation of a fixed task. The same
scheduler, registry, due queue, persistence, and expiry machinery also support a
**standard 5-field cron expression** and **one-shot** tasks. Neither is a second
scheduler: a cron task is an ordinary `fixed` registry task whose schedule is a
cron expression, and a one-shot is an ordinary task that removes itself after it
fires. Both are created through the model-callable tools
(`schedule_cron_task`, `schedule_once_task`); `/loop` keeps its existing
interval syntax.

### Cron expressions

A cron expression has five whitespace-separated fields, in order:

```
minute hour day-of-month month day-of-week
```

Each field accepts:

- `*` — every value.
- a single value (`5`, `MON`, `JAN`).
- a range (`9-17`, `MON-FRI`) — ranges must be ascending.
- a step (`*/15`, `0-30/10`, or `5/15` meaning "from 5, every 15").
- a comma-separated list mixing any of the above (`0,30`, `1,15`, `MON,WED,FRI`).
- month and day-of-week names (`JAN`–`DEC`, `SUN`–`SAT`, case-insensitive).

Sunday is `0` or `7` (both normalize to `0`). Values are validated per field, so
an invalid schedule reports the exact component: `invalid minute field "61": 61 is
out of range 0-59`.

**Day-of-month / day-of-week rule.** If *both* fields are restricted (each
selects fewer than all of its values), a day matches when **either** field
matches. Otherwise the restricted field alone decides:

| Expression | Meaning |
|---|---|
| `0 0 1 * 1` | midnight on the 1st **or** any Monday |
| `0 0 1 * *` | midnight on the 1st of every month |
| `0 0 * * 1` | midnight every Monday |

**Timezone and DST.** Occurrences are local wall-clock times in the schedule's
IANA `timeZone` (defaults to the session's local zone; tests inject one for
determinism), converted to absolute instants with the offset in force then. A
local time skipped by a spring-forward gap does not run that day, and a time
repeated by a fall-back overlap runs once at its **first** occurrence. The next
occurrence is always strictly in the future and the search is bounded (eight
years), so an impossible schedule such as `0 0 31 2 *` reports an error instead
of looping. Cron boundaries are never jittered.

A cron task keeps the default seven-day recurring lifetime, so a weekly or rarer
schedule needs an explicit `expiresIn` that covers its first run (for example
`schedule_cron_task` with `expiresIn: "30d"`). Missed occurrences are skipped:
after a busy period or a reload the next future occurrence is recomputed from the
expression, never replayed.

### One-shot tasks

A one-shot task fires **once**, then removes itself. It can be scheduled from a
relative delay (`delay: "30min"`) or an absolute timestamp with an explicit
offset or `Z` (`at: "2026-10-01T09:00:00-04:00"`); the absolute form requires the
offset so its meaning never depends on the host zone. A one-shot is persisted
like a fixed task, but a run whose time already passed while the session was
closed is **dropped, never replayed**, on resume.

## Model-callable tools

Alongside the `/loop` command, the extension registers seven model-callable tools.
They operate on the **same session-scoped task registry and scheduler** as
`/loop`, so a task created by a tool appears in the registry, participates in the
same due queue and timers, and is persisted the same way. When scheduling is
disabled with `PI_LOOP_DISABLE` (see
[Disable scheduling](#disable-scheduling)) **no tool is registered at all**.

| Tool | Kind | Purpose |
|---|---|---|
| `schedule_task` | Mutating | Create a recurring fixed task from `interval`, `prompt`, and an optional `expiresIn`. Returns the stable task ID. |
| `schedule_cron_task` | Mutating | Create a recurring task from a 5-field local-time `cron` expression, optional `timeZone`, and optional `expiresIn`. Invalid fields are reported. |
| `schedule_once_task` | Mutating | Create a task that fires once from either `delay` or an absolute `at` timestamp, then removes itself. |
| `list_scheduled_tasks` | Read-only | List active tasks with ID, mode, cadence/cron, next fire time, expiry, and pending status. |
| `delete_scheduled_task` | Mutating | Delete one task by its stable ID, cancelling its timer and any queued run. |
| `schedule_wakeup` | Mutating | Choose the next wakeup of the active self-paced loop from `delayMs` and an optional `reason`; the scheduler clamps to 1 minute–1 hour. |
| `stop_wakeup` | Mutating | Stop the active self-paced loop and cancel its future wakeups. |

Coherence with `/loop`:

- Tool-created tasks (interval, cron, and one-shot) are **independent** of the
  command-owned loop: they never replace the loop, and `stop_wakeup` and
  `/loop stop` never cancel them. Use `delete_scheduled_task` for those.
- `/loop status` prints the command-owned loop summary and then lists **every**
  task (its ID, mode, cadence/cron, next due/wakeup, and queued state), so the
  same information is visible without calling `list_scheduled_tasks`.
- `schedule_wakeup` and `stop_wakeup` are scoped to the **active self-paced
  loop** and throw when no such loop is running, so they cannot reschedule or
  cancel a fixed task.

Validation and safety boundaries:

- Intervals and `expiresIn` use the same parser as `/loop` (`s`, `min`, `h`,
  `d`; positive whole numbers). Malformed values throw and change nothing.
- A cron expression is validated field by field; the thrown error names the
  offending component (`minute`, `hour`, `day-of-month`, `month`, `day-of-week`,
  `timezone`, or the expression itself). An unknown timezone is rejected.
- `schedule_once_task` requires exactly one of `delay` or `at`; `at` must be an
  ISO-8601 timestamp with an explicit offset or `Z` and must be in the future.
- Prompts are validated non-empty and classified like `/loop` prompts, so a
  control command or unknown skill is rejected before a task is created.
- The active-task limit and an expiry that lands before the first run are
  reported as errors, never as a task with a dead ID.
- `delete_scheduled_task` matches the ID exactly; an unknown ID produces a
  not-found error and no other task is touched. Deleting a task that has a
  queued run removes that queued run.
- Pi's tool contract produces a **failed tool result** when `execute()` throws;
  this extension throws typed errors for invalid input instead of encoding
  failures in content. The installed `ToolDefinition` API has no
  `annotations`/`readOnlyHint` field, so read-only vs mutating intent is
  expressed through the description prefix, `promptGuidelines`, and
  `executionMode: "sequential"` (the tools share mutable scheduler state).

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
git diff --check      # whitespace check
```

CI (`.github/workflows/ci.yml`) runs typecheck and tests on every push and pull
request against the declared minimum Pi (`0.87.1`) and the newest published line
(`0.99.1`), so a breaking Pi API change fails the build instead of shipping.

The logic is split so it can be tested without Pi:

| Module | Responsibility |
|---|---|
| `src/loop-core.ts` | Command parsing, interval parsing/validation, and the fixed + self-paced scheduler (wakeup clamping, bounded fallback, boundary-aligned timer/idle handling, ID-based jitter, seven-day default expiry, injected clock and dispatch). |
| `src/due-queue.ts` | Scheduler-owned per-task due queue: coalesces repeated misses and defines the deterministic flush order (earliest missed deadline, ties by registration). |
| `src/schedule.ts` | Fixed schedules: cadence normalization (cron granularity and clean steps), `nextFireAt` boundary calculation, the FNV-1a ID hash with bounded jitter offsets, the default seven-day task lifetime, and the `TaskSchedule` union that dispatches interval vs cron. |
| `src/cron.ts` | Pure 5-field cron: per-field parsing/validation (wildcard, value, step, range, list, names), the documented DOM/DOW OR rule, timezone-aware next-occurrence calculation with DST gap/overlap handling, and a bounded search. |
| `src/task-registry.ts` | Per-session `ScheduledTask` registry: stable IDs, create/restore/get/update/delete, active-task limit, stored schedules, expiry, wakeup reasons, and deterministic disposal (injected clock and ID generator). |
| `src/config.ts` | `loop.json` resolution with an injectable file reader, and the `PI_LOOP_DISABLE` switch (`isLoopDisabled`). |
| `src/status.ts` | Pure formatting for the persistent footer status/widget and `/loop status`: countdowns, per-task lines (ID, mode, cadence, next due/wakeup, pending), the local-clock-time helper, and the compact footer projection (total, per-mode counts, earliest next time). |
| `src/maintenance.ts` | Maintenance-prompt resolution: `.claude/loop.md` → `~/.claude/loop.md` → built-in, with an injectable reader, byte-bounded truncation, and hard errors for unreadable files. |
| `src/persistence.ts` | Versioned, validated schema for fixed-task create/update/delete session entries, plus pure branch-order replay that drops expired tasks, missed one-shots, and self-paced tasks and fails a branch closed on any unreadable entry. |
| `src/dispatch.ts` | Scheduled-prompt dispatch: classify a prompt against `getCommands()` as literal, expandable (skill/template), or rejected (extension/interactive/unknown-skill); send literal text exactly and expand only skills/templates. |
| `src/tools.ts` | Model-callable scheduler tools (`schedule_task`, `schedule_cron_task`, `schedule_once_task`, `list_scheduled_tasks`, `delete_scheduled_task`, `schedule_wakeup`, `stop_wakeup`) as typed TypeBox schemas over the shared scheduler and registry, with read-only vs mutating intent and typed error boundaries. |
| `src/index.ts` | Pi wiring: command, tool registration (skipped when disabled), persistent status/widget, idle events, per-run prompt resolution, and lifecycle cleanup. |

`test/helpers.ts` provides a virtual clock (including a `sleep` jump that leaves
timers overdue), a deterministic registry factory, and a fake Pi API whose
`sendUserMessage` reproduces Pi's semantics: it returns `void`, applies the same
expansion rules (a matching extension command executes; skills and templates
expand; otherwise the text is literal), and — like Pi — catches a simulated
delivery failure internally instead of throwing, so tests never assume the
scheduler can observe or retry a send failure.
The virtual clock disables task-ID jitter by default so boundary/grid suites
assert the underlying schedule; jitter suites override `jitterOffset` with the
real hash. Scheduler and adapter tests never sleep — they drive time explicitly
and assert boundary alignment, normalization, coalescing, long busy periods,
clock jumps, replacement, stop, dispatch errors, cleanup, and the self-paced
reschedule, clamp, bounded-fallback, termination, and stale-callback paths.
Due-queue coverage adds per-task coalescing, deterministic flush order for two
distinct tasks and simultaneous deadlines, long busy windows, deleted/stopped
tasks and stale callbacks, and flush reentrancy when a dispatch starts work.
Expiry/jitter coverage adds hash stability and offset bounds, distinct-ID
phases, drift-free jittered boundaries, restore phase reproduction, the
seven-day default lifetime, the inclusive expiry boundary, delayed and busy
expiry, flush-time expiry, and restore near and after expiry. Maintenance
coverage adds file lookup and precedence, missing/unreadable/empty files,
byte-bounded truncation, custom-prompt isolation, dynamic reload, both command
forms, and per-run prompt resolution on the scheduler. Dispatch coverage adds
plain text, literal slash text, skill/template expansion, rejected control and
unknown-skill forms (at start and on a maintenance run), and cross-checks the
policy against the installed Pi package's real built-in command list and
`expandPromptTemplate`. Persistence coverage adds schema round-trips and
malformed/newer-version rejection, create/update/delete replay with delete
tombstones, divergent branches, fail-closed branches that prevent an unreadable
newer-version or malformed mutation from resurrecting a deleted task, expired
recurring tasks, missed one-shots, self-paced exclusion, scheduler
create/update/delete emission, expiry and one-shot teardown, and an
extension-level reload/resume that preserves stable IDs without duplicate timers
or entries. Tool coverage adds the registration contract (distinct names,
TypeBox schemas, read-only vs mutating metadata, sequential execution), fixed
creation/firing/expiry, malformed interval/prompt/control-prompt rejection, the
task limit, exact-ID deletion and unknown-ID not-found, pending-run cancellation,
read-only listing, self-paced clamp/reschedule/stop, and `/loop`/tool registry
coherence and restore. Cron coverage adds deterministic per-field parsing and
validation (including the named field on an error), the DOM/DOW OR rule,
local-time resolution in an injected zone, DST spring-forward gaps and fall-back
overlaps, an impossible-schedule bound, cron scheduler firing/coalescing/
recompute-on-restore/expiry, far-future occurrences beyond the `setTimeout`
cap, and a missed one-shot being dropped on restore. Visibility/disable coverage
adds countdown and per-task-line formatting, footer projection and local-clock
rendering, the persistent footer/widget populated on create and cleared on
stop/shutdown, mixed-mode counts, pending without an extra footer line, restore
and branch-navigation refresh, busy-tick and non-UI guards,
and the disable switch (pure env parsing plus an injected switch: no tools, no
timers, no restore, `/loop` explaining the disabled state, and tools/restore
still working when enabled).

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
- **`Maintenance prompt error: could not read ...`** — a `.claude/loop.md` or
  `~/.claude/loop.md` exists but could not be read (or is empty). Fix or remove
  the file; the iteration is skipped and the loop is not silently given a
  different prompt. A fixed loop retries at the next boundary; a self-paced loop
  uses its bounded fallback.
- **`Loop config error: ...`** — `loop.json` is malformed, unreadable, or has an
  invalid `defaultInterval`. Fix the file or use an explicit interval.
- **`Scheduled prompt rejected: ...`** — the scheduled text names a control
  command (an extension command such as `/loop`, a built-in interactive command
  such as `/reload`) or an unknown `/skill:<name>`. It is not sent. A `/loop
  <task>` that is rejected starts no loop; a rejected maintenance prompt skips
  that run. Remove the leading `/` to send the text literally, or use a loaded
  skill or prompt template.
- **A task beginning with `stop`/`status` is treated as a command.** Only the
  exact words `stop` and `status` are commands; longer text such as
  `stop the build server` is a task.
- **A self-paced loop did not survive a restart.** This is intended; self-paced
  wakeup state is ephemeral. Fixed loops and one-shot tasks are rebuilt from the
  session with the same ID, unless they were stopped, expired, or missed (a
  one-shot).
- **A fixed loop stopped on its own after about a week.** Recurring fixed tasks
  expire seven days after creation by default. Start a fresh `/loop` for a new
  lifetime, or schedule the task with an explicit `expiresAt` through the
  scheduler API if you need a different bound.
