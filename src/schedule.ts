/**
 * Pure, Pi-independent fixed scheduling: normalize a requested interval into a
 * cadence a cron-like scheduler can honour, and compute the next boundary from
 * that cadence.
 *
 * Claude Code's `/loop` converts an interval into a cron expression, so the
 * finest granularity is one minute and only cadences that divide a calendar
 * field cleanly survive. Seconds round up to whole minutes before a clean step
 * is chosen. This module mirrors that behavior without depending on any
 * runtime: the same inputs always yield the same schedule.
 *
 * The scheduler is anchored on a fixed boundary grid (the Unix epoch by
 * default). Because every supported cadence divides a day evenly, the grid
 * never drifts and boundaries are identical regardless of when a task starts.
 * Local-time cron and timezone-aware anchors are a later change.
 *
 * The module also owns two recurring-fixed-task policies: a deterministic,
 * ID-derived phase offset ({@link jitterOffsetMs}) that spreads same-cadence
 * tasks without changing the cadence, and the default seven-day lifetime
 * ({@link DEFAULT_TASK_TTL_MS}).
 */

/** One minute in milliseconds; the finest cadence cron can express. */
export const MINUTE_MS = 60_000;
/** One hour in milliseconds. */
export const HOUR_MS = 3_600_000;
/** One day in milliseconds. */
export const DAY_MS = 86_400_000;
/** Minimum scheduler granularity: intervals below this normalize up to a minute. */
export const MIN_CADENCE_MS = MINUTE_MS;
/** Largest cadence representable by a `setTimeout` delay (signed 32-bit). */
export const MAX_CADENCE_MS = 2_147_483_647;

/**
 * Default lifetime of a recurring fixed task: seven days from creation. The
 * scheduler stamps a task with `createdAt + this` unless the caller supplies an
 * explicit expiry, which may shorten (or lengthen) the lifetime.
 */
export const DEFAULT_TASK_TTL_MS = 7 * DAY_MS;

/** Absolute default expiry for a recurring fixed task created at `createdAt`. */
export function defaultExpiresAt(createdAt: number): number {
  return createdAt + DEFAULT_TASK_TTL_MS;
}

/**
 * Largest phase offset a cadence may ever receive. Bounding the *absolute*
 * spread keeps a long cadence (a day or more) from sliding by a whole fraction
 * of itself, while the per-cadence fraction below keeps a short cadence (a
 * 1-minute task especially) from shifting more than a small part of its step.
 */
export const MAX_JITTER_MS = HOUR_MS;

/** Fraction of a cadence that the jitter window may occupy. */
const JITTER_FRACTION = 1 / 4;

/**
 * Width of the deterministic jitter window for a cadence: a quarter of the
 * cadence, capped at {@link MAX_JITTER_MS}. The window is always strictly
 * smaller than the cadence, so a jittered boundary can never reach, let alone
 * pass, the next un-jittered boundary.
 */
export function jitterWindowMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(intervalMs * JITTER_FRACTION), MAX_JITTER_MS));
}

/**
 * Stable 32-bit FNV-1a hash of a task ID.
 *
 * The algorithm is fixed (offset basis `0x811c9dc5`, prime `0x01000193`) so an
 * ID always hashes to the same value across processes, sessions, and restores.
 * It is a spread function, not a security primitive.
 */
export function hashTaskId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic per-task phase offset, in milliseconds. */
export type JitterOffset = (id: string, intervalMs: number) => number;

/**
 * Deterministic phase offset for a recurring fixed task: `hash(id)` modulo the
 * cadence's jitter window, so the result lies in `[0, window)`. The same ID and
 * cadence always produce the same offset, and the offset is independent of when
 * a task starts, which is what makes a restore reproduce the original phase.
 */
export function jitterOffsetMs(id: string, intervalMs: number): number {
  const window = jitterWindowMs(intervalMs);
  return window === 0 ? 0 : hashTaskId(id) % window;
}

/**
 * The first *jittered* boundary strictly after `after`.
 *
 * The jittered grid is `anchor + offset + k * intervalMs`, where `offset` is a
 * pure function of the task ID and cadence. Because the offset is fixed for the
 * lifetime of the task, every boundary keeps the same phase and no drift
 * accumulates; a late run, a long busy period, or a clock jump never moves a
 * later boundary. An injected `offset` is sanitized into `[0, intervalMs)` so it
 * cannot reorder boundaries.
 */
export function nextFireAtJittered(
  schedule: FixedSchedule,
  id: string,
  after: number,
  offset: JitterOffset = jitterOffsetMs,
): number {
  if (!Number.isFinite(after)) {
    throw new ScheduleError("reference time must be a finite epoch time");
  }
  const { intervalMs, anchor } = schedule;
  const requested = offset(id, intervalMs);
  const applied = Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 0), Math.max(0, intervalMs - 1))
    : 0;
  const shifted = anchor + applied;
  const steps = Math.floor((after - shifted) / intervalMs) + 1;
  return shifted + steps * intervalMs;
}

/** Thrown for a schedule that cannot be constructed. */
export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

/**
 * Minute steps that divide an hour evenly, so a step-n minute schedule has no
 * short final gap. 60 is expressed as "every 60 minutes" here and as "every
 * hour" through the hour steps; the candidate set de-duplicates them.
 */
const MINUTE_STEPS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60] as const;

/** Hour steps that divide a day evenly, so a step-n hour schedule stays aligned. */
const HOUR_STEPS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

/** Build the sorted set of cadences the scheduler can represent. */
function buildCadences(): number[] {
  const cadences = new Set<number>();
  for (const step of MINUTE_STEPS) cadences.add(step * MINUTE_MS);
  for (const step of HOUR_STEPS) cadences.add(step * HOUR_MS);
  for (let days = 1; days * DAY_MS <= MAX_CADENCE_MS; days += 1) cadences.add(days * DAY_MS);
  return [...cadences].sort((a, b) => a - b);
}

/** Every supported cadence in ascending order. */
const CADENCES: readonly number[] = buildCadences();

/**
 * Round a requested interval to the nearest supported cron cadence.
 *
 * - Every interval is first ceiled to a whole number of minutes, with a floor of
 *   one minute. Seconds therefore round *up*, matching Claude: `61s` and `89s`
 *   become `2min`, and `121s` becomes `3min`, so a loop never runs more often
 *   than requested.
 * - Whole-minute values that do not map to a clean step, such as `7m` or `90m`,
 *   then snap to the nearest cadence. Ties round up (to the longer cadence).
 * - Day intervals are supported up to {@link MAX_CADENCE_MS}.
 */
export function normalizeCadence(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) {
    throw new ScheduleError("interval must be a finite number of milliseconds");
  }
  // Ceil to whole minutes first (cron's granularity, seconds round up), then
  // choose the nearest clean cron step from that minute grid.
  const minutes = Math.max(1, Math.ceil(intervalMs / MINUTE_MS));
  const requested = minutes * MINUTE_MS;
  let best = CADENCES[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const cadence of CADENCES) {
    const distance = Math.abs(cadence - requested);
    // `<=` lets a later (larger) candidate win an exact tie, i.e. round up.
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = cadence;
    }
  }
  return best;
}

/**
 * A fixed recurring schedule. Instances are frozen so the schedule a task is
 * created with cannot be mutated afterwards.
 */
export interface FixedSchedule {
  /** Normalized cadence; always one of the supported cron steps. */
  readonly intervalMs: number;
  /** Boundary origin in epoch milliseconds. Boundaries are `anchor + k * intervalMs`. */
  readonly anchor: number;
}

/**
 * Build a frozen {@link FixedSchedule}, normalizing the interval and flooring
 * the anchor to a whole millisecond.
 */
export function createSchedule(intervalMs: number, anchor = 0): FixedSchedule {
  if (!Number.isFinite(anchor)) {
    throw new ScheduleError("schedule anchor must be a finite epoch time");
  }
  return Object.freeze({ intervalMs: normalizeCadence(intervalMs), anchor: Math.floor(anchor) });
}

/**
 * The first boundary strictly after `after`.
 *
 * Boundaries are the absolute grid `anchor + k * intervalMs`; the result is
 * independent of when the previous run happened, so a late or long-running
 * dispatch never shifts the schedule. Missed boundaries are skipped rather than
 * replayed, so this returns the next *future* boundary even after a long gap or
 * a forward clock jump.
 */
export function nextFireAt(schedule: FixedSchedule, after: number): number {
  if (!Number.isFinite(after)) {
    throw new ScheduleError("reference time must be a finite epoch time");
  }
  const { intervalMs, anchor } = schedule;
  const steps = Math.floor((after - anchor) / intervalMs) + 1;
  return anchor + steps * intervalMs;
}
