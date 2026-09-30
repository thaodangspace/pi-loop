/**
 * Pure, Pi-independent formatting for the persistent loop status/widget and
 * `/loop status`.
 *
 * The extension renders two surfaces from one snapshot of the authoritative task
 * registry:
 *
 * - a one-line footer status (active count plus the soonest due time), and
 * - a compact widget listing every task with its ID, mode, cadence, next due or
 *   wakeup, and queued state.
 *
 * `/loop status` reuses the same per-task line so the command copy and the
 * on-screen copy never drift. Nothing here imports the Pi runtime or touches the
 * scheduler, so it is deterministic under a fixed clock.
 */
import { isCronSchedule } from "./cron.ts";
import { formatInterval } from "./loop-core.ts";
import type { TaskSchedule } from "./schedule.ts";
import type { ScheduledTask } from "./task-registry.ts";

/** Longest prompt fragment shown in a status line before it is elided. */
export const STATUS_PROMPT_LIMIT = 72;

/** Collapse whitespace and bound a prompt so a status line stays one line. */
export function summarizePrompt(prompt: string, limit = STATUS_PROMPT_LIMIT): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * A human countdown from `now` to `at`, using at most two units
 * (`1d 3h`, `2h 15min`, `45s`). A time at or before `now` reads `due now`.
 */
export function formatCountdown(now: number, at: number): string {
  const delta = at - now;
  if (!Number.isFinite(delta)) {
    return "at an unknown time";
  }
  if (delta <= 0) {
    return "due now";
  }
  let seconds = Math.round(delta / 1_000);
  const parts: string[] = [];
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (parts.length < 2 && minutes > 0) parts.push(`${minutes}min`);
  if (parts.length < 2 && seconds > 0) parts.push(`${seconds}s`);
  if (parts.length === 0) {
    return "due now";
  }
  return `in ${parts.join(" ")}`;
}

/** Describe a fixed task's schedule, or undefined for non-fixed modes. */
export function formatTaskSchedule(mode: ScheduledTask["mode"], schedule?: TaskSchedule): string | undefined {
  if (mode !== "fixed" || schedule === undefined) {
    return undefined;
  }
  return isCronSchedule(schedule)
    ? `cron "${schedule.expression}" (${schedule.timeZone})`
    : `every ${formatInterval(schedule.intervalMs)}`;
}

/**
 * One task as a single status line: ID, mode, schedule, next due/wakeup, queued
 * state, then a bounded prompt preview.
 */
export function formatTaskLine(task: ScheduledTask, now: number): string {
  const segments = [task.id, `[${task.mode}]`];
  const schedule = formatTaskSchedule(task.mode, task.schedule);
  if (schedule !== undefined) {
    segments.push(schedule);
  }
  if (task.nextFireAt !== undefined) {
    segments.push(`next ${formatCountdown(now, task.nextFireAt)}`);
  }
  if (task.pending) {
    segments.push("pending");
  }
  return `${segments.join(" · ")}: ${summarizePrompt(task.prompt)}`;
}

/** Every task as a status line, in registry (creation) order. */
export function formatTaskLines(tasks: readonly ScheduledTask[], now: number): string[] {
  return tasks.map((task) => formatTaskLine(task, now));
}

/**
 * The compact footer status: active count, soonest due/wakeup, and how many runs
 * are queued. The caller clears the status instead when there are no tasks.
 */
export function formatStatusLine(tasks: readonly ScheduledTask[], now: number): string {
  const count = tasks.length;
  const segments = [`${count} task${count === 1 ? "" : "s"}`];
  let soonest: number | undefined;
  for (const task of tasks) {
    if (task.nextFireAt !== undefined && (soonest === undefined || task.nextFireAt < soonest)) {
      soonest = task.nextFireAt;
    }
  }
  if (soonest !== undefined) {
    segments.push(`next ${formatCountdown(now, soonest)}`);
  }
  const pending = tasks.filter((task) => task.pending).length;
  if (pending > 0) {
    segments.push(`${pending} pending`);
  }
  return `loop: ${segments.join(" · ")}`;
}
