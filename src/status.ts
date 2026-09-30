/**
 * Pure, Pi-independent formatting for the persistent loop status/widget and
 * `/loop status`.
 *
 * The extension renders two surfaces from one snapshot of the authoritative task
 * registry:
 *
 * - a compact one-line footer status (`⟳ 3 loops · 2 fixed · 1 self-paced ·
 *   next 09:00`: active count, per-mode counts when multiple tasks, and the
 *   earliest known next fire time as a local clock time), and
 * - a widget listing every task with its ID, mode, cadence, next due or wakeup,
 *   and queued state.
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
 * Local clock time (`HH:MM`, 24-hour) for an absolute instant, or undefined for
 * a non-finite time. The footer shows when a task is next due as a wall-clock
 * time rather than a countdown, so it stays a stable projection on every repaint.
 */
export function formatClockTime(at: number): string | undefined {
  if (!Number.isFinite(at)) {
    return undefined;
  }
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Per-mode active-task counts for the footer, keyed by registry mode. */
export interface FooterCounts {
  readonly fixed: number;
  readonly selfPaced: number;
  readonly oneShot: number;
}

/**
 * A pure projection of the registry tasks for the footer: the total, the
 * per-mode counts, and the earliest known `nextFireAt` (or undefined when no
 * active task has one). Tasks without a computed next fire time still count.
 */
export interface FooterStatus {
  readonly total: number;
  readonly counts: FooterCounts;
  readonly nextFireAt?: number;
}

/** Derive the footer projection from the authoritative task snapshots. */
export function footerStatus(tasks: readonly ScheduledTask[]): FooterStatus {
  let fixed = 0;
  let selfPaced = 0;
  let oneShot = 0;
  let nextFireAt: number | undefined;
  for (const task of tasks) {
    if (task.mode === "fixed") fixed += 1;
    else if (task.mode === "self-paced") selfPaced += 1;
    else if (task.mode === "one-shot") oneShot += 1;
    const at = task.nextFireAt;
    if (at !== undefined && Number.isFinite(at)) {
      if (nextFireAt === undefined || at < nextFireAt) {
        nextFireAt = at;
      }
    }
  }
  return {
    total: tasks.length,
    counts: { fixed, selfPaced, oneShot },
    ...(nextFireAt === undefined ? {} : { nextFireAt }),
  };
}

/**
 * The compact, single-line footer status: a loop glyph, the total active task
 * count, the per-mode counts when more than one task is active, and the
 * earliest known next fire time as a local clock time. The caller clears the
 * status instead when there are no tasks.
 *
 * Examples:
 * - no tasks: the caller clears the footer instead of rendering
 * - `⟳ 1 loop · next 09:00`
 * - `⟳ 3 loops · 2 fixed · 1 self-paced · next 09:00`
 * - `⟳ 1 loop` (no active task has a computed next fire time)
 */
export function formatStatusLine(tasks: readonly ScheduledTask[]): string {
  const model = footerStatus(tasks);
  const segments = [`⟳ ${model.total} loop${model.total === 1 ? "" : "s"}`];
  if (model.total > 1) {
    const { fixed, selfPaced, oneShot } = model.counts;
    if (fixed > 0) segments.push(`${fixed} fixed`);
    if (selfPaced > 0) segments.push(`${selfPaced} self-paced`);
    if (oneShot > 0) segments.push(`${oneShot} one-shot`);
  }
  const next = model.nextFireAt === undefined ? undefined : formatClockTime(model.nextFireAt);
  if (next !== undefined) {
    segments.push(`next ${next}`);
  }
  return segments.join(" · ");
}
