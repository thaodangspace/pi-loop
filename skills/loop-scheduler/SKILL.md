---
name: loop-scheduler
description: Use pi-loop's scheduler to repeat, delay, or calendar-schedule a prompt in this session. Use when asked to loop a task, check something periodically, run a one-time reminder or delayed check, schedule cron-like work, or when a self-paced iteration must choose its next wakeup or stop. Covers choosing between /loop and the eight schedule_* tools, task identity and scope, and lifecycle rules.
---

# Scheduling prompts with pi-loop

`pi-loop` delivers a prompt back into **this session** as a user message, either
on a fixed cadence, on a calendar schedule, once after a delay, or when each
iteration paces itself. Every run is a real model turn: it costs tokens, may call
tools, appears in the transcript, and is subject to Pi's normal permissions.

Prefer a single direct turn when the user only needs work done now. Schedule only
when the work must happen **later**, **repeatedly**, or **after the current turn
ends**.

## Decide which mechanism to use

| Need | Use |
|---|---|
| Repeat now, then let each run decide when to run again | `/loop <prompt>` (command) or `schedule_self_paced_task` |
| Repeat on a fixed cadence (every 10 min, 2 h, 1 d) | `/loop <n><unit> <prompt>` or `schedule_task` |
| Repeat at calendar wall-clock times (weekdays 09:00, monthly) | `schedule_cron_task` |
| Run once after a delay or at a specific future time | `schedule_once_task` |
| Inspect what is scheduled | `list_scheduled_tasks` or `/loop status` |
| Cancel one task | `delete_scheduled_task` or `/loop stop <id>` |
| Continue the self-paced iteration that is running | `schedule_wakeup` |
| End the self-paced iteration that is running | `stop_wakeup` |

Rules of thumb:

- `/loop` is a **human/user-facing command**. An agent should normally call the
  tools, not type `/loop`.
- Only one **command-owned** loop exists per session; `/loop` replaces it.
  Tool-created tasks are **independent**: they never replace the command loop and
  the command loop never replaces them.
- `schedule_self_paced_task` is the tool form of a prompt-only `/loop <prompt>`.
  Its first run is due **immediately** and each iteration must pace itself with
  `schedule_wakeup` or end with `stop_wakeup`.
- A bare `delayMs` interval or a fixed schedule is simpler and cheaper than a
  self-paced loop when the cadence is known up front. Use self-paced only when
  the right delay genuinely depends on what each run finds.

## The eight tools

All tools are session-scoped, share one registry/scheduler with `/loop`, and
return the task's **stable ID** (except the read-only list). Invalid input throws
a failed tool result rather than silently creating a dead task.

### `schedule_task` — recurring fixed cadence

```
schedule_task(interval: "10min", prompt: "check deploys", expiresIn?: "2d")
```

- `interval`: positive number + unit `s | min | h | d`. Normalized to a cron
  cadence; `30s` → `1min`, `7m` → `6min`, `90m` → `2h`.
- `prompt`: non-empty text, a prompt template, or a known `/skill:<name>`. An
  extension command (including `/loop`), a built-in interactive command, or an
  unknown `/skill:` is rejected.
- `expiresIn` optional; recurring fixed tasks default to a **7-day** lifetime.
  Pass a longer value for weekly or rarer work.

### `schedule_cron_task` — calendar schedule

```
schedule_cron_task(cron: "0 9 * * 1-5", prompt: "weekday standup", timeZone?: "America/New_York", expiresIn?: "30d")
```

- 5 fields: minute hour day-of-month month day-of-week. Supports `*`, values,
  ranges, steps, lists, and names (`MON-FRI`, `JAN`).
- If **both** day fields are restricted, a day matches when **either** matches.
- `timeZone` defaults to the session's local zone. Unknown zones are rejected.
- Same 7-day default expiry; a weekly/rarer schedule needs `expiresIn` covering
  its first run.

### `schedule_once_task` — one-shot

```
schedule_once_task(prompt: "post the release note", delay: "30min")
schedule_once_task(prompt: "remind me", at: "2026-10-01T09:00:00-04:00")
```

- Give **exactly one** of `delay` or `at`.
- `at` must be ISO-8601 with an explicit offset or `Z`, and in the future.
- Persisted across reload, but a run missed while Pi was closed is **dropped**,
  never replayed. It removes itself after firing.

### `schedule_self_paced_task` — independent self-paced loop

```
schedule_self_paced_task(prompt: "monitor the queue and act if it grows", fallbackDelay?: "5min")
```

- First run is due immediately (queued if Pi is busy).
- Each iteration should call `schedule_wakeup` with the next delay or
  `stop_wakeup` to end.
- `fallbackDelay` is a **safety net**, not the continuation strategy: if an
  iteration chooses nothing, the scheduler grants **one** fallback wakeup; if the
  next iteration also chooses nothing, the task **terminates**. Clamped to
  1 min–1 h (default `1min`).
- **Ephemeral**: not persisted across reload/resume/session replacement.

### `list_scheduled_tasks` — read-only

Returns every active task (including the command loop) with ID, mode,
cadence/cron, next fire time, expiry, and whether a run is queued. Use it to get
the exact ID before deleting. It never changes state.

### `delete_scheduled_task` — cancel one task by ID

```
delete_scheduled_task(id: "t3")
```

- Matches the ID **exactly**, cancels its timer and any queued run, and never
  touches another task.
- An unknown ID is a not-found error.
- This is the correct way to cancel a tool-created or independent task. It also
  works from outside a running iteration.

### `schedule_wakeup` — continue the running self-paced iteration

```
schedule_wakeup(delayMs: 600000, reason: "queue still draining")
```

- Applies only to the self-paced iteration **currently executing**. Do not pass a
  task ID — the scheduler binds the active iteration.
- `delayMs` is clamped into **1 minute–1 hour**; the result reports the requested
  and effective delay plus whether it was clamped.
- Throws if no self-paced iteration is executing. It can never reschedule the
  command loop, a fixed task, or another self-paced task.

### `stop_wakeup` — end the running self-paced iteration

- Stops the self-paced iteration **currently executing** and cancels its future
  wakeups.
- Throws outside an executing self-paced iteration, so it never stops the command
  loop or a fixed task. To cancel a specific task instead, use
  `delete_scheduled_task`.

## Identity, scope, and lifecycle

- **Task IDs** are stable strings (e.g. `t3`) returned by creation and listed by
  `list_scheduled_tasks` / `/loop status`. Use them for inspection and deletion.
- **Command loop vs independent tasks.** `/loop` owns one primary task per
  session; `stop_wakeup` and `/loop stop` never cancel independent tool-created
  tasks. `/loop stop <id>` and `delete_scheduled_task` cancel one task by ID.
- **Iteration-scoped control.** `schedule_wakeup` and `stop_wakeup` act only on
  the iteration that invokes them. From any other turn (or after the target task
  was deleted) they fail closed instead of retargeting something else.
- **Due queue / coalescing.** While Pi is busy, due runs are queued and delivered
  once at the next idle boundary; repeated misses for one task **coalesce** into
  a single run, so a backlog is never replayed.
- **Persistence.** Fixed cadence, cron, and one-shot tasks persist across
  reload/resume with the same ID. **Self-paced** tasks (command or independent)
  are ephemeral and do not survive restart/reload/session replacement.
- **Expiry.** Recurring fixed and cron tasks expire 7 days after creation unless
  `expiresIn` is given.
- **Session lifetime.** Tasks live in the current session; they do not run while
  Pi is closed.
- **Cost and safety.** Every run is a real model turn. Choose gentle cadences and
  idempotent, read-only, or safely-repeatable work. Never schedule destructive or
  irreversible actions without the user's explicit intent. Avoid secrets in task
  text; it lands in the transcript.

## Examples

Periodic status check:

```
schedule_task(interval: "30min", prompt: "Check CI status for the current branch and report only changes since the last check.")
```

One-time reminder or delayed check:

```
schedule_once_task(delay: "2h", prompt: "Re-check whether the migration finished and summarize the result.")
```

Self-paced monitor that reschedules or stops (write the prompt so the iteration
knows to call these tools):

```
schedule_self_paced_task(
  prompt: "Check the deploy queue. If it still has pending items, call schedule_wakeup to check again later. If it is empty, report done and call stop_wakeup."
)
```

Safe inspection and cancellation of the right task:

```
list_scheduled_tasks()          # find the exact ID, e.g. "t4"
delete_scheduled_task(id: "t4") # cancel only that task and its queued run
```

Weekly calendar work:

```
schedule_cron_task(cron: "0 9 * * 1", prompt: "Post the weekly metrics summary.", timeZone: "America/New_York", expiresIn: "90d")
```

## Invocation and discovery

- Users can force this guide with `/skill:loop-scheduler`; installed as a Pi
  package, `pi-loop` registers it under `pi.skills`, so it appears in the model's
  skill list with the name and description above.
- Pi advertises skills **by name and description** and loads the full
  instructions only when the model decides they are relevant. Installing the
  skill does **not** guarantee it is read on every turn or every iteration: in a
  self-paced task, put the required continuation behavior (call `schedule_wakeup`
  or `stop_wakeup`) explicitly in the scheduled prompt.
- This skill documents usage only. It does not change scheduler state, add tools,
  or make anything run automatically.

See the package `README.md` for full semantics; this guide stays consistent with
the registered tool schemas.
