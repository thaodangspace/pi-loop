/**
 * Pure, Pi-independent fixed scheduling: normalize a requested interval into a
 * cadence a cron-like scheduler can honour, and compute the next boundary from
 * that cadence.
 *
 * Claude Code's `/loop` converts an interval into a cron expression, so the
 * finest granularity is one minute and only cadences that divide a calendar
 * field cleanly survive. This module mirrors that behavior without depending on
 * any runtime: the same inputs always yield the same schedule.
 *
 * The scheduler is anchored on a fixed boundary grid (the Unix epoch by
 * default). Because every supported cadence divides a day evenly, the grid
 * never drifts and boundaries are identical regardless of when a task starts.
 * Local-time cron and timezone-aware anchors are a later change.
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
 * - Anything at or below one minute becomes one minute (cron's granularity).
 * - Intervals that do not map to a clean step, such as `7m` or `90m`, snap to
 *   the nearest cadence. Ties round up (to the longer cadence), matching the
 *   "rounded up" behavior Claude documents for seconds and keeping the loop
 *   from ever running more often than requested.
 * - Day intervals are supported up to {@link MAX_CADENCE_MS}.
 */
export function normalizeCadence(intervalMs: number): number {
  if (!Number.isFinite(intervalMs)) {
    throw new ScheduleError("interval must be a finite number of milliseconds");
  }
  const requested = Math.max(MIN_CADENCE_MS, Math.round(intervalMs));
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
