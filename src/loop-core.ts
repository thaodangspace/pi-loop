/**
 * Pure, Pi-independent loop primitives: command parsing and the interval
 * scheduler. Nothing in this file imports the Pi runtime, so it can be tested
 * with deterministic fake timers.
 *
 * The registry is the authoritative store of task records, one per session. The
 * scheduler owns the timing state and the per-task due queue that decide what
 * runs and in which order.
 */
import { DueQueue } from "./due-queue.ts";
import {
  createTaskEvent,
  deleteTaskEvent,
  updateTaskEvent,
  type PersistedEvent,
  type PersistedTask,
} from "./persistence.ts";
import {
  cloneSchedule,
  createSchedule,
  DAY_MS,
  defaultExpiresAt,
  HOUR_MS,
  jitterOffsetMs,
  MAX_CADENCE_MS,
  MINUTE_MS,
  nextTaskFireAt,
  type TaskSchedule,
} from "./schedule.ts";
import { createCronSchedule, isCronSchedule } from "./cron.ts";
import type { RestoredTask, ScheduledTask, TaskMode, TaskRegistry, TaskUpdate } from "./task-registry.ts";

/** Minimum accepted parse-time interval. Sub-minute values normalize at scheduling. */
export const MIN_INTERVAL_MS = 1_000;
/** Maximum accepted interval; `setTimeout` is capped at a signed 32-bit delay. */
export const MAX_INTERVAL_MS = 2_147_483_647;

/** Smallest delay a self-paced iteration may request for its next wakeup. */
export const MIN_WAKEUP_DELAY_MS = MINUTE_MS;
/** Largest delay a self-paced iteration may request for its next wakeup. */
export const MAX_WAKEUP_DELAY_MS = HOUR_MS;
/** Fallback delay used when a self-paced iteration does not choose one. */
export const DEFAULT_WAKEUP_FALLBACK_MS = MINUTE_MS;

/** Unit suffixes accepted in an interval token, mapped to milliseconds. */
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

/** Error thrown for invalid interval syntax or out-of-range values. */
export class IntervalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntervalError";
  }
}

/**
 * Parse a positive-integer interval token such as `30min`, `45s`, `2h`.
 *
 * Rejects empty input, zero, negatives, fractions, unknown units, and values
 * that overflow a safe timer delay. A bare number without a unit is rejected
 * because the unit is required to disambiguate seconds from minutes.
 */
export function parseInterval(text: string): number {
  const token = text.trim().toLowerCase();
  if (!token) {
    throw new IntervalError("interval is empty");
  }
  const match = /^(\d+)([a-z]+)$/.exec(token);
  if (!match) {
    throw new IntervalError(`invalid interval "${text.trim()}": use a positive number with a unit such as 30min`);
  }
  const [, digits, unit] = match as unknown as [string, string, string];
  const unitMs = UNIT_MS[unit];
  if (unitMs === undefined) {
    throw new IntervalError(`unknown interval unit "${unit}"`);
  }
  const magnitude = Number(digits);
  if (!Number.isSafeInteger(magnitude) || magnitude <= 0) {
    throw new IntervalError("interval must be a positive whole number");
  }
  const ms = magnitude * unitMs;
  if (!Number.isSafeInteger(ms) || ms > MAX_INTERVAL_MS) {
    throw new IntervalError("interval is too large");
  }
  if (ms < MIN_INTERVAL_MS) {
    throw new IntervalError("interval must be at least 1s");
  }
  return ms;
}

/** Format a millisecond interval in the largest exact unit. */
export function formatInterval(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS}d`;
  if (ms % HOUR_MS === 0) return `${ms / HOUR_MS}h`;
  if (ms % MINUTE_MS === 0) return `${ms / MINUTE_MS}min`;
  return `${ms / 1_000}s`;
}

/** A parsed `/loop` invocation. */
export type LoopCommand =
  | { type: "start"; task: string; intervalMs?: number }
  | { type: "maintenance"; intervalMs?: number }
  | { type: "stop" }
  | { type: "status" }
  | { type: "usage"; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when `word` is a recognised interval unit (used for spaced forms). */
function isKnownUnit(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(UNIT_MS, word.toLowerCase());
}

/**
 * True when text opens like an interval: an optional sign followed by a digit or
 * a dot-leading number such as `.5h`. Used so fraction-looking input fails
 * closed instead of leaking into the task.
 */
function looksLikeInterval(text: string): boolean {
  return /^[-+]?(?:\d|\.\d)/.test(text);
}

type LeadingInterval =
  | { kind: "interval"; intervalMs: number; task: string }
  | { kind: "malformed"; reason: string }
  | { kind: "none" };

/**
 * Classify a leading interval token, glued (`5m <task>`) or spaced
 * (`5 min <task>`).
 *
 * Any leading numeric token is treated as interval intent. When it cannot be
 * understood as an interval (missing/unknown unit, fraction, out of range, or
 * trailing digits such as `1h30min`) the command fails closed with a reason so
 * interval-looking text can never leak into the task.
 */
function leadingInterval(args: string): LeadingInterval {
  const tokens = args.split(/\s+/);
  const first = tokens[0] ?? "";
  if (!looksLikeInterval(first)) {
    return { kind: "none" };
  }
  let spec: string | undefined;
  let consumed = 1;
  if (/^\d+[a-z]+$/i.test(first)) {
    spec = first;
  } else if (/^\d+$/.test(first) && tokens[1] && isKnownUnit(tokens[1])) {
    spec = `${first}${tokens[1]}`;
    consumed = 2;
  }
  if (!spec) {
    return {
      kind: "malformed",
      reason: `invalid interval "${first}": use a positive number with a unit such as 30min`,
    };
  }
  try {
    return { kind: "interval", intervalMs: parseInterval(spec), task: tokens.slice(consumed).join(" ") };
  } catch (error) {
    return { kind: "malformed", reason: reasonOf(error) };
  }
}

type TrailingInterval =
  | { kind: "interval"; intervalMs: number; prompt: string }
  | { kind: "malformed"; reason: string }
  | { kind: "none" };

/**
 * Classify a trailing `every <interval>` clause (`<prompt> every 5m`).
 *
 * Only the final `every` is considered. Interval-looking text that cannot be
 * parsed fails closed; plain prose after `every` leaves the whole argument as a
 * literal task so tasks such as `review every file in src` keep working.
 */
function trailingInterval(args: string): TrailingInterval {
  const match = /^(?<prompt>[\s\S]*)\s+every(?:\s+(?<interval>[\s\S]+))?$/i.exec(args);
  if (!match?.groups) {
    return { kind: "none" };
  }
  const prompt = match.groups.prompt!.trim();
  if (!prompt) {
    return { kind: "none" };
  }
  const intervalText = (match.groups.interval ?? "").trim();
  if (!intervalText) {
    return { kind: "malformed", reason: "missing interval after every" };
  }
  const spec = /^(\d+)\s*([a-z]+)$/i.exec(intervalText);
  if (!spec) {
    if (looksLikeInterval(intervalText)) {
      return {
        kind: "malformed",
        reason: `invalid interval "${intervalText.split(/\s+/)[0]}": use a positive number with a unit such as 30min`,
      };
    }
    return { kind: "none" };
  }
  try {
    return { kind: "interval", intervalMs: parseInterval(`${spec[1]}${spec[2]}`), prompt };
  } catch (error) {
    return { kind: "malformed", reason: reasonOf(error) };
  }
}

/**
 * Parse the raw argument string of `/loop`.
 *
 * Supported forms:
 * - `<interval> <prompt>` (Claude-style, e.g. `5m check deploy`)
 * - `<prompt> every <interval>`
 * - `<prompt>` (literal self-paced task)
 * - `<interval>` and bare `/loop` (maintenance loops: the built-in maintenance
 *   prompt, or a per-iteration `loop.md`, on a fixed or self-paced schedule)
 * - `every <interval> <prompt>` (Pi compatibility alias)
 *
 * Precedence: `stop`/`status` are exact commands, then the `every` alias, then a
 * trailing `every` clause, then a leading interval, then a literal task. An
 * interval-looking token that cannot be parsed is reported as a usage error
 * rather than becoming task text, and leaves any existing loop untouched.
 */
export function parseLoopCommand(rawArgs: string): LoopCommand {
  const args = rawArgs.trim();
  if (!args) {
    return { type: "maintenance" };
  }
  const keyword = args.toLowerCase();
  if (keyword === "stop") {
    return { type: "stop" };
  }
  if (keyword === "status") {
    return { type: "status" };
  }

  // Pi compatibility alias: `every <interval> <prompt>`.
  const everyMatch = /^every(?:\s+([\s\S]*))?$/i.exec(args);
  if (everyMatch) {
    const rest = (everyMatch[1] ?? "").trim();
    if (!rest) {
      return { type: "usage", reason: "missing interval after every" };
    }
    // Accept both "30min task" and "30 min task".
    const intervalMatch = /^(\d+)\s*([a-z]+)(?:\s+([\s\S]*))?$/i.exec(rest);
    if (!intervalMatch) {
      const firstToken = rest.split(/\s+/)[0] ?? rest;
      return { type: "usage", reason: `invalid interval "${firstToken}"` };
    }
    const [, digits, unit, task = ""] = intervalMatch as unknown as [string, string, string, string | undefined];
    let intervalMs: number;
    try {
      intervalMs = parseInterval(`${digits}${unit}`);
    } catch (error) {
      return { type: "usage", reason: reasonOf(error) };
    }
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      return { type: "maintenance", intervalMs };
    }
    return { type: "start", intervalMs, task: trimmedTask };
  }

  // Claude-style `<prompt> every <interval>`.
  const trailing = trailingInterval(args);
  if (trailing.kind === "malformed") {
    return { type: "usage", reason: trailing.reason };
  }
  if (trailing.kind === "interval") {
    return { type: "start", intervalMs: trailing.intervalMs, task: trailing.prompt };
  }

  // Claude-style `<interval> <prompt>` and interval-only `<interval>`.
  const leading = leadingInterval(args);
  if (leading.kind === "malformed") {
    return { type: "usage", reason: leading.reason };
  }
  if (leading.kind === "interval") {
    const task = leading.task.trim();
    if (!task) {
      return { type: "maintenance", intervalMs: leading.intervalMs };
    }
    return { type: "start", intervalMs: leading.intervalMs, task };
  }

  return { type: "start", task: args };
}

/** User-facing guidance for malformed commands. */
export function usageText(reason?: string): string {
  const head = reason ? `Usage error: ${reason}.\n` : "";
  return (
    `${head}/loop <task>                           self-paced: run <task> now, then choose the next wakeup\n` +
    `/loop <n><unit> <task>                    fixed schedule (units: s, min, h, d)\n` +
    `/loop <task> every <n><unit>              set the fixed interval after the task\n` +
    `/loop every <n><unit> <task>              Pi-compatible alias for the above\n` +
    `/loop                                      maintenance: built-in prompt, self-paced\n` +
    `/loop <n><unit>                           maintenance on a fixed schedule\n` +
    `/loop stop                                 cancel the active loop\n` +
    `/loop status                               show the active loop\n` +
    `Maintenance loops use .claude/loop.md, then ~/.claude/loop.md, then the built-in prompt, resolved fresh each run.\n` +
    `Self-paced wakeup delays clamp to 1min-1h. Fixed intervals round to a cron cadence: seconds up to the next whole minute, and steps such as 7m or 90m to the nearest supported value.`
  );
}

/** Snapshot of scheduler state for `/loop status`. */
export interface LoopStatus {
  active: boolean;
  /** Which mode the active task runs in. Absent when no task is active. */
  mode?: TaskMode;
  /** True when the active loop is a maintenance loop whose prompt is resolved per run. */
  maintenance?: boolean;
  /** Effective, normalized cadence in milliseconds; 0 for self-paced tasks. */
  intervalMs: number;
  task: string;
  pending: boolean;
  /**
   * Self-paced only: true while the current iteration has been delivered but has
   * not yet chosen its next wakeup (or been settled into a fallback).
   */
  awaitingDecision?: boolean;
  /**
   * Self-paced only: true once a fallback wakeup has been scheduled since the
   * last explicit reschedule, so a second miss terminates the loop.
   */
  fallbackUsed?: boolean;
  /** Self-paced only: the reason supplied with the most recent wakeup. */
  reason?: string;
  /** The stored schedule representation, when a fixed loop is active. */
  schedule?: TaskSchedule;
}

/** Thrown when a wakeup operation is used without an active self-paced loop. */
export class WakeupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakeupError";
  }
}

/**
 * Clamp a requested self-paced delay into the supported 1 minute–1 hour range.
 * Non-finite values are rejected rather than silently clamped, so a malformed
 * model request surfaces instead of scheduling an arbitrary wakeup.
 */
export function clampWakeupDelay(delayMs: number): number {
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs)) {
    throw new WakeupError("wakeup delay must be a finite number of milliseconds");
  }
  return Math.min(MAX_WAKEUP_DELAY_MS, Math.max(MIN_WAKEUP_DELAY_MS, delayMs));
}

/** The normalized outcome of a self-paced iteration choosing its next wakeup. */
export interface WakeupDecision {
  /** The delay the iteration asked for, before clamping. */
  requestedMs: number;
  /** The delay actually scheduled, always within [1 minute, 1 hour]. */
  delayMs: number;
  /** True when clamping changed the requested delay. */
  clamped: boolean;
  /** Absolute time the wakeup is due. */
  nextFireAt: number;
  /** Optional human/model-supplied reason for the chosen delay. */
  reason?: string;
}

/** Options accepted when starting a fixed loop. */
export interface StartOptions {
  /** Mark a maintenance loop, whose prompt is re-resolved on every run. */
  maintenance?: boolean;
  /**
   * Optional absolute time after which the task must not run or be restored.
   * Defaults for recurring fixed tasks to `createdAt + DEFAULT_TASK_TTL_MS`
   * (seven days); an explicit value overrides it and may shorten or lengthen it.
   * One-shot and self-paced tasks have no default expiry.
   */
  expiresAt?: number;
}

/** Options accepted when scheduling a recurring cron task. */
export interface CronStartOptions extends StartOptions {
  /**
   * IANA timezone the expression is interpreted in. Defaults to the process's
   * local zone. Tests inject a fixed zone for determinism.
   */
  timeZone?: string;
}

/** Options accepted when starting a self-paced loop. */
export interface SelfPacedStartOptions extends StartOptions {
  /**
   * Delay used for the single bounded fallback wakeup when an iteration neither
   * reschedules nor stops. Clamped into [1 minute, 1 hour].
   */
  fallbackDelayMs?: number;
}

/**
 * What happened when a self-paced iteration settled without (or with) a choice.
 *
 * - `none`: no iteration was awaiting a decision.
 * - `fallback`: a single bounded fallback wakeup was scheduled.
 * - `terminated`: a second consecutive miss stopped the loop.
 */
export type IterationSettleResult =
  | { action: "none" }
  | { action: "fallback"; delayMs: number; nextFireAt: number }
  | { action: "terminated" };

/**
 * The wakeup API an iteration may call while its loop is self-paced.
 *
 * This is the scheduler contract, not a prompt-text convention: a delivered
 * iteration either schedules its next wakeup or stops the loop. The target is
 * always the iteration that is currently executing (falling back to the
 * command-owned loop outside a run), so each self-paced task paces itself
 * independently. Anything that exposes these operations to the model (for
 * example a Pi tool) should delegate here rather than re-implement scheduling.
 */
export interface WakeupService {
  /** Schedule the next wakeup, clamping the delay to [1 minute, 1 hour]. */
  scheduleNextWakeup(delayMs: number, reason?: string): WakeupDecision;
  /** Cancel the loop and all future wakeups. */
  stop(): boolean;
}

/** Injected timer primitives so tests can drive time deterministically. */
export interface SchedulerDeps {
  /** Current time in milliseconds, used to stamp task creation and next-fire times. */
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /**
   * Deterministic phase offset applied to a recurring fixed task's boundaries,
   * derived from its stable ID and cadence. Defaults to
   * {@link jitterOffsetMs}; a test double may inject a fixed offset (for example
   * zero) to assert the underlying un-jittered grid.
   */
  jitterOffset?(id: string, intervalMs: number): number;
}

export const systemTimers: SchedulerDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Per-task scheduling state that the scheduler owns for every task it tracks.
 *
 * The registry remains the authoritative store of the task's public record; this
 * entry holds the state that is not persisted: the callback token, the armed
 * timer, and the self-paced decision flags.
 */
interface TrackedTask {
  /** Stable registry ID; also the key in the due queue. */
  readonly id: string;
  /** Registration order, used to break simultaneous-deadline ties. */
  readonly seq: number;
  /**
   * Token captured by every timer callback for this entry. A callback whose
   * entry has been removed or superseded finds a different token (or no entry)
   * and is ignored, so a stale callback can never dispatch.
   */
  token: number;
  /** The single armed timer for this task, or null while none is armed. */
  timer: unknown;
  /**
   * Absolute time the armed timer is meant to fire. When the delay had to be
   * capped below `timerDue`, the timer fires early and is re-armed for the rest.
   */
  timerDue: number | undefined;
  /** True when the armed timer's delay was capped at the maximum timer delay. */
  timerCapped: boolean;
  /** Self-paced only: a delivered run still owes a next-wakeup decision. */
  awaitingDecision: boolean;
  /** Self-paced only: the one bounded fallback has already been granted. */
  fallbackUsed: boolean;
  /** Self-paced only: the configured fallback delay for this task. */
  fallbackDelayMs: number;
  /** Monotonic id for the latest self-paced delivery, to ignore stale failures. */
  runToken: number;
}

/**
 * One scheduler scoped to a single session, tracking one or more scheduled
 * tasks in either fixed or self-paced mode.
 *
 * The scheduler owns *when each task is due*: a scheduler-local {@link DueQueue}
 * keyed by task ID decides what is flushed and in which order. The registry is
 * still the authoritative store of task records, and its `pending` field is kept
 * in sync as a readable mirror for status and diagnostics, but dispatch is driven
 * by the queue, never by scanning that boolean.
 *
 * Fixed mode guarantees:
 * - A requested interval is normalized to a supported cron cadence (minimum
 *   one minute; seconds and awkward steps round to the nearest cadence).
 * - Fire times are absolute schedule boundaries, so a late tick, a long busy
 *   period, or a clock jump never shifts later boundaries.
 * - Each recurring task gets a deterministic phase offset derived from its
 *   stable ID (see {@link jitterOffsetMs}), bounded to a fraction of its cadence
 *   so load spreads without changing the cadence. One-shot and self-paced tasks
 *   are never jittered.
 * - A recurring task whose schedule is a 5-field {@link CronSchedule} fires at
 *   the expression's local-time occurrences in its timezone, also as absolute
 *   times. Cron boundaries are never jittered, and a missed occurrence is
 *   skipped: the next boundary is recomputed from the expression, never replayed.
 * - A recurring fixed task expires {@link DEFAULT_TASK_TTL_MS} after creation
 *   unless the caller supplied an explicit expiry. A boundary exactly at the
 *   expiry may still run; any later run is dropped, and an expired task is
 *   removed from the registry, its timer, the due queue, and persistence even
 *   if Pi stays busy.
 *
 * Self-paced mode guarantees:
 * - An iteration chooses its next wakeup with {@link scheduleNextWakeup}, whose
 *   delay is clamped into [1 minute, 1 hour].
 * - An iteration may stop the loop instead (`stop`).
 * - An iteration that does neither gets one bounded fallback wakeup; if that
 *   fallback iteration also misses, the task terminates rather than spinning.
 * - Multiple self-paced tasks coexist. Each owns its decision flags, fallback
 *   allowance, run token, and wakeup timer, so a wakeup, stop, or settle applies
 *   only to the iteration that is currently executing. A task that becomes due
 *   while another iteration is active is queued and runs at the next idle
 *   boundary in the documented due order.
 *
 * Due-queue guarantees:
 * - While Pi is busy a due task is only marked in the scheduler's queue; its
 *   timer keeps advancing on the schedule. Repeated misses for the same task
 *   coalesce into that one entry instead of replaying a backlog.
 * - Distinct due tasks flush in a documented deterministic order: earliest
 *   missed deadline first, ties broken by registration order.
 * - A task deleted from the registry or via {@link stopTask}, and any callback
 *   captured before a stop or replacement, is dropped without dispatching.
 * - {@link flush} stops the moment Pi is busy again — including when a dispatch
 *   starts work synchronously — and resumes the remaining tasks at the next idle
 *   boundary, so flushing can never interrupt or re-enter active work.
 *
 * Shared guarantees:
 * - `stop`, `stopAll`, and `dispose` are idempotent and leave no live timer.
 *
 * Prompt resolution:
 * - The prompt for a run is produced by the injected `resolvePrompt` provider at
 *   dispatch time, not read from the task record. Maintenance loops use this to
 *   pick up an edited `loop.md` on the next run.
 * - A provider that throws is reported through `onError`. A fixed run is skipped
 *   and the schedule continues; a self-paced run has no iteration to choose the
 *   next wakeup, so the bounded fallback policy applies instead of stalling.
 */
export class LoopScheduler implements WakeupService {
  private readonly entries = new Map<string, TrackedTask>();
  private readonly due = new DueQueue();
  /** The command-owned task, described by {@link status}. */
  private primaryId: string | undefined;
  private primarySchedule: TaskSchedule | undefined;
  /**
   * The self-paced entry whose iteration is currently executing (or awaiting a
   * decision). Pi runs one agent turn at a time, so at most one entry is bound;
   * wakeup, stop, and settle operations resolve through it before falling back to
   * the command-owned loop. If the bound task is removed mid-turn, the id is kept
   * as a stale sentinel so those operations fail closed until `settleIteration`
   * releases it at the turn boundary; `stopAll`/`dispose` also release it.
   */
  private activeSelfPacedId: string | undefined;
  private disposed = false;
  private nextSeq = 0;
  private nextToken = 1;
  /** Greater than zero while replaying persisted state, when events are suppressed. */
  private restoreDepth = 0;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly registry: TaskRegistry,
    private readonly dispatch: (task: ScheduledTask, prompt: string) => void | Promise<void>,
    private readonly isIdle: () => boolean,
    private readonly onError?: (error: unknown) => void,
    /**
     * Produce the prompt delivered for a run. Called once per dispatch, so a
     * maintenance loop resolves `loop.md` afresh each iteration. Defaults to the
     * task's stored prompt.
     */
    private readonly resolvePrompt: (task: ScheduledTask) => string = (task) => task.prompt,
    /**
     * Sink for persisted fixed/one-shot mutations. Called on create, metadata
     * update, and delete (including expiry), but never for self-paced wakeups and
     * never while replaying persisted state. A sink failure is reported and does
     * not disturb scheduling.
     */
    private readonly persistEvent?: (event: PersistedEvent) => void,
  ) {}

  start(intervalMs: number, task: string, options: StartOptions = {}): void {
    this.assertUsable();
    if (!task.trim()) {
      throw new Error("task must not be empty");
    }
    // A command start replaces the command-owned loop; independently scheduled
    // tasks (scheduleFixed, scheduleSelfPaced) keep running.
    this.stopCommandLoop();
    const { task: created, entry, schedule } = this.createFixedTask(intervalMs, task, options);
    this.primaryId = created.id;
    this.primarySchedule = schedule;
    this.persistCreate(created);
    this.arm(entry, created);
  }

  /**
   * Schedule an additional fixed task without replacing the command-owned loop.
   *
   * The task joins the same scheduler-owned due queue and timer bookkeeping, so
   * it coalesces while busy and flushes in the documented order alongside every
   * other due task. Returns the created registry snapshot.
   */
  scheduleFixed(intervalMs: number, task: string, options: StartOptions = {}): ScheduledTask {
    this.assertUsable();
    if (!task.trim()) {
      throw new Error("task must not be empty");
    }
    const { task: created, entry } = this.createFixedTask(intervalMs, task, options);
    this.persistCreate(created);
    this.arm(entry, created);
    return created;
  }

  /**
   * Schedule a recurring task on a 5-field local-time cron expression.
   *
   * The cron schedule is stored on an ordinary `fixed` registry task and joins
   * the same due queue, persistence, and timer machinery as an interval task.
   * Unlike interval tasks, cron boundaries are exact local-time occurrences and
   * are never jittered. The first occurrence is computed from `now` in
   * `options.timeZone` (default: the process zone).
   */
  scheduleCron(expression: string, task: string, options: CronStartOptions = {}): ScheduledTask {
    this.assertUsable();
    if (!task.trim()) {
      throw new Error("task must not be empty");
    }
    const schedule = createCronSchedule(expression, options.timeZone);
    const { task: created, entry } = this.createScheduledTask(schedule, task, options);
    this.persistCreate(created);
    this.arm(entry, created);
    return created;
  }

  /**
   * Create and track one recurring fixed task.
   *
   * The default lifetime is {@link DEFAULT_TASK_TTL_MS} from creation; an
   * explicit `expiresAt` overrides it (and may shorten or lengthen it). The
   * first fire time is computed *after* the registry allocates the stable ID, so
   * the ID-derived jitter phase is baked into the persisted `nextFireAt` and is
   * reproduced exactly when the task is restored.
   */
  private createFixedTask(
    intervalMs: number,
    task: string,
    options: StartOptions,
  ): { task: ScheduledTask; entry: TrackedTask; schedule: TaskSchedule } {
    return this.createScheduledTask(createSchedule(intervalMs), task, options);
  }

  /** Create and track one recurring task from a built interval or cron schedule. */
  private createScheduledTask(
    schedule: TaskSchedule,
    task: string,
    options: StartOptions,
  ): { task: ScheduledTask; entry: TrackedTask; schedule: TaskSchedule } {
    const now = this.deps.now();
    const created = this.registry.create({
      prompt: task,
      mode: "fixed",
      ...(options.maintenance ? { maintenance: true } : {}),
      schedule,
      expiresAt: options.expiresAt ?? defaultExpiresAt(now),
    });
    const fired = this.registry.update(created.id, {
      nextFireAt: this.nextBoundary(schedule, created.id, now),
    });
    const entry = this.track(fired);
    return { task: fired, entry, schedule };
  }

  /**
   * Schedule a one-shot task that runs once at `at` and then removes itself.
   *
   * One-shot tasks share the due queue, coalescing, and persistence with fixed
   * tasks. A missed one-shot (its fire time passed while the session was closed)
   * is not restored.
   */
  scheduleOnce(at: number, task: string, options: StartOptions = {}): ScheduledTask {
    this.assertUsable();
    if (!task.trim()) {
      throw new Error("task must not be empty");
    }
    if (!Number.isFinite(at)) {
      throw new Error("one-shot time must be a finite epoch time");
    }
    const created = this.registry.create({
      prompt: task,
      mode: "one-shot",
      ...(options.maintenance ? { maintenance: true } : {}),
      nextFireAt: at,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });
    const entry = this.track(created);
    this.persistCreate(created);
    this.armAtTime(entry, at);
    return created;
  }

  /**
   * Rebuild a persisted fixed or one-shot task under its original stable ID.
   *
   * Restoring a task does not emit persistence events, so replaying a branch on
   * session start cannot write duplicate entries. A task whose ID is already
   * tracked is left untouched, so a duplicate replay cannot arm a second timer.
   * Self-paced tasks are never restored. Returns the task, or `undefined` when it
   * could not be restored.
   */
  restore(input: PersistedTask): ScheduledTask | undefined {
    this.assertUsable();
    if (input.mode === "self-paced") {
      return undefined;
    }
    // A one-shot whose time already passed while the session was closed must
    // never be replayed. The persistence planner enforces this too; the guard
    // here keeps a direct `restore` call consistent with that guarantee.
    if (input.mode === "one-shot" && input.nextFireAt !== undefined && input.nextFireAt <= this.deps.now()) {
      return undefined;
    }
    const existing = this.registry.get(input.id);
    if (existing) {
      return existing;
    }
    this.restoreDepth += 1;
    try {
      let task: ScheduledTask;
      try {
        // A fixed task persisted before the default lifetime existed (no
        // `expiresAt`) still gets the seven-day bound, anchored on its original
        // creation time, so a restored task can never outlive an equivalent
        // freshly-created one.
        const expiresAt =
          input.expiresAt ?? (input.mode === "fixed" ? defaultExpiresAt(input.createdAt) : undefined);
        const restored: RestoredTask = {
          id: input.id,
          prompt: input.prompt,
          mode: input.mode,
          ...(input.maintenance ? { maintenance: true } : {}),
          createdAt: input.createdAt,
          ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
          ...(input.nextFireAt === undefined ? {} : { nextFireAt: input.nextFireAt }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
        task = this.registry.restore(restored);
      } catch (error) {
        this.onError?.(error);
        return undefined;
      }
      const entry = this.track(task);
      if (input.primary) {
        this.primaryId = task.id;
        this.primarySchedule = task.schedule;
      }
      if (task.mode === "one-shot") {
        this.armAtTime(entry, task.nextFireAt ?? this.deps.now());
      } else {
        this.arm(entry, task);
      }
      // Arming may have found the task already expired and removed it; report
      // that as "not restored" so callers do not treat it as live.
      if (!this.entries.has(task.id)) {
        return undefined;
      }
      return task;
    } finally {
      this.restoreDepth -= 1;
    }
  }

  /**
   * Apply a partial update to a tracked task and re-arm its timer when its
   * timing changed. Persists an update event for fixed and one-shot tasks; a
   * self-paced task's wakeup state is never persisted.
   */
  updateTask(id: string, update: TaskUpdate): ScheduledTask {
    this.assertUsable();
    const updated = this.registry.update(id, update);
    const entry = this.entries.get(id);
    if (!entry) {
      return updated;
    }
    if (updated.mode === "self-paced") {
      if (update.nextFireAt !== undefined) {
        this.armSelfPaced(entry, updated);
      }
      return updated;
    }
    if (update.schedule !== undefined || update.nextFireAt !== undefined || update.expiresAt !== undefined) {
      if (updated.mode === "one-shot") {
        this.armAtTime(entry, updated.nextFireAt ?? this.deps.now());
      } else {
        this.arm(entry, updated);
      }
    }
    // Re-arming may have expired and removed the task; do not persist a stale update.
    if (!this.entries.has(id)) {
      return updated;
    }
    const patch: Parameters<typeof updateTaskEvent>[1] = {};
    if (update.prompt !== undefined) patch.prompt = updated.prompt;
    if (update.schedule !== undefined && updated.schedule !== undefined) patch.schedule = cloneSchedule(updated.schedule);
    if (update.nextFireAt !== undefined && updated.nextFireAt !== undefined) patch.nextFireAt = updated.nextFireAt;
    if (update.expiresAt !== undefined && updated.expiresAt !== null) patch.expiresAt = updated.expiresAt;
    if (Object.keys(patch).length > 0) {
      this.persist(updateTaskEvent(id, patch));
    }
    return updated;
  }

  /**
   * Start a command-owned self-paced loop. The prompt is due immediately; each
   * delivered iteration is expected to call {@link scheduleNextWakeup} or `stop`
   * before it settles. A missing choice triggers the bounded fallback described
   * on the class.
   *
   * A command start replaces the previous command-owned loop (fixed or
   * self-paced); independently scheduled tasks, including those created with
   * {@link scheduleSelfPaced}, keep running. The task becomes the command-owned
   * loop.
   */
  startSelfPaced(prompt: string, options: SelfPacedStartOptions = {}): ScheduledTask {
    this.assertUsable();
    if (!prompt.trim()) {
      throw new Error("task must not be empty");
    }
    // Replace only the command-owned loop; independent tasks must survive.
    this.stopCommandLoop();
    const created = this.createSelfPacedTask(prompt, options);
    this.primaryId = created.id;
    this.primarySchedule = undefined;
    return created;
  }

  /**
   * Schedule an additional self-paced task without replacing the command-owned
   * loop.
   *
   * Each self-paced task owns its decision flags, fallback allowance, run token,
   * and wakeup timer, so independently created tasks pace themselves and cannot
   * affect one another. The task joins the same scheduler-owned due queue, so it
   * coalesces while busy and flushes in the documented order alongside every
   * other due task.
   */
  scheduleSelfPaced(prompt: string, options: SelfPacedStartOptions = {}): ScheduledTask {
    this.assertUsable();
    if (!prompt.trim()) {
      throw new Error("task must not be empty");
    }
    return this.createSelfPacedTask(prompt, options);
  }

  /** Create and track one self-paced task with its own iteration state. */
  private createSelfPacedTask(prompt: string, options: SelfPacedStartOptions): ScheduledTask {
    const fallbackDelayMs = clampWakeupDelay(options.fallbackDelayMs ?? DEFAULT_WAKEUP_FALLBACK_MS);
    const created = this.registry.create({
      prompt,
      mode: "self-paced",
      ...(options.maintenance ? { maintenance: true } : {}),
      nextFireAt: this.deps.now(),
    });
    const entry = this.track(created);
    entry.fallbackDelayMs = fallbackDelayMs;
    this.armSelfPaced(entry, created);
    return created;
  }

  /**
   * Schedule the next wakeup of the self-paced iteration that is running.
   *
   * The target is the currently executing iteration when one is bound, otherwise
   * the command-owned self-paced loop (the pre-multi-task behavior). Only that
   * task's wakeup state changes, so a choice made by one self-paced task can
   * never reschedule another.
   *
   * The requested delay is clamped into [1 minute, 1 hour]. An explicit choice
   * clears the fallback allowance and any queued missed run, so the loop cannot
   * be terminated for a miss that a later iteration fixed. Throws
   * {@link WakeupError} when no self-paced iteration can be resolved — including
   * when the bound iteration has since been removed — or the scheduler is
   * disposed.
   */
  scheduleNextWakeup(delayMs: number, reason?: string): WakeupDecision {
    if (this.disposed) {
      throw new WakeupError("scheduler has been disposed");
    }
    const entry = this.resolveSelfPacedEntry();
    const task = entry === undefined ? undefined : this.registry.get(entry.id);
    if (!entry || !task || task.mode !== "self-paced") {
      throw new WakeupError("no self-paced loop is running");
    }
    const delay = clampWakeupDelay(delayMs);
    const nextFireAtValue = this.deps.now() + delay;
    const updated = this.registry.update(task.id, {
      nextFireAt: nextFireAtValue,
      pending: false,
      reason: reason ?? null,
    });
    entry.awaitingDecision = false;
    entry.fallbackUsed = false;
    this.due.remove(entry.id);
    this.clearTimer(entry);
    this.armSelfPaced(entry, updated);
    return {
      requestedMs: delayMs,
      delayMs: delay,
      clamped: delay !== delayMs,
      nextFireAt: nextFireAtValue,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /**
   * End the self-paced iteration that actually ran and apply the bounded fallback
   * policy when it neither rescheduled nor stopped. Safe to call at every idle
   * boundary for every mode; returns `{ action: "none" }` when nothing awaited.
   *
   * The target is the currently executing iteration when its binding is live.
   * A stale binding (its task was removed mid-run) fails closed and is cleared at
   * this turn boundary instead of falling back to the command-owned loop. Only
   * outside an executing turn does the command-owned self-paced loop become the
   * backward-compatible target, so settling one self-paced task never grants a
   * fallback to, terminates, reschedules, or stops another.
   */
  settleIteration(): IterationSettleResult {
    if (this.disposed) {
      return { action: "none" };
    }
    if (this.activeSelfPacedId !== undefined) {
      const entry = this.liveBoundEntry();
      // The turn is over: release the binding before settling, so a callback that
      // fires during settlement cannot re-enter.
      this.activeSelfPacedId = undefined;
      if (entry === undefined) {
        return { action: "none" };
      }
      return this.settleEntry(entry);
    }
    const entry = this.primarySelfPacedEntry();
    if (entry === undefined) {
      return { action: "none" };
    }
    return this.settleEntry(entry);
  }

  /** Apply the missed-choice policy to one entry, if it is still awaiting one. */
  private settleEntry(entry: TrackedTask): IterationSettleResult {
    const task = this.registry.get(entry.id);
    if (!task || task.mode !== "self-paced" || !entry.awaitingDecision) {
      return { action: "none" };
    }
    entry.awaitingDecision = false;
    return this.applyMissedChoice(entry, task);
  }

  /**
   * Stop the currently executing self-paced iteration. Falls back to the
   * command-owned loop only when no iteration is executing (backward-compatible
   * direct-scheduler behavior). A stale binding fails closed: it returns false
   * and never retargets another task. Idempotent.
   *
   * Use {@link stopCommandLoop} to cancel the command-owned loop explicitly, for
   * example from `/loop stop`, without touching an executing independent task.
   */
  stop(): boolean {
    if (this.activeSelfPacedId !== undefined) {
      const entry = this.liveBoundEntry();
      if (entry === undefined) {
        // The bound iteration's task is gone; fail closed rather than stopping
        // the command-owned loop or an unrelated task.
        return false;
      }
      this.stopTask(entry.id);
      return true;
    }
    return this.stopCommandLoop();
  }

  /**
   * Cancel the command-owned loop only, leaving independently scheduled tasks
   * (including a self-paced iteration that is currently executing) running.
   * Returns whether a command-owned loop was running. Idempotent.
   *
   * This is the command-scoped stop used by `/loop stop` and by a command start
   * that replaces its own loop; {@link stop} is the iteration-scoped stop.
   */
  stopCommandLoop(): boolean {
    const id = this.primaryId;
    if (id === undefined) {
      return false;
    }
    const active = this.registry.get(id) !== undefined;
    this.stopTask(id);
    return active;
  }

  /**
   * Stop one tracked task: cancel its timer, drop it from the due queue, and
   * remove it from the registry. Returns whether it was tracked.
   *
   * By default a fixed or one-shot task is also persisted as a delete tombstone.
   * Pass `{ persist: false }` for lifecycle teardown (session shutdown, branch
   * reconstruction) where the task should be restored later.
   */
  stopTask(id: string, options: { persist?: boolean } = {}): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      return false;
    }
    const task = this.registry.get(id);
    this.removeEntry(entry);
    if (this.registry.has(id)) {
      this.registry.delete(id);
    }
    if (options.persist !== false && task && task.mode !== "self-paced") {
      this.persist(deleteTaskEvent(id));
    }
    return true;
  }

  /**
   * Stop every tracked task and clear the due queue. Keeps the scheduler usable.
   * Does not persist deletes: teardown must not tombstone tasks that a later
   * reload should restore.
   */
  stopAll(): void {
    for (const entry of [...this.entries.values()]) {
      this.stopTask(entry.id, { persist: false });
    }
    this.due.clear();
    this.primaryId = undefined;
    this.primarySchedule = undefined;
    this.activeSelfPacedId = undefined;
  }

  /** Permanently disable the scheduler and drop every timer. Idempotent. */
  dispose(): void {
    this.stopAll();
    this.disposed = true;
  }

  /**
   * Deliver due tasks while idle, in the scheduler's deterministic order.
   *
   * The queue is drained up front, so a run that re-queues itself on failure is
   * retried at the *next* idle signal rather than spinning inside this call. The
   * loop re-checks `isIdle()` before every task, so a dispatch that starts work
   * synchronously stops the flush; the remaining tasks are re-queued in their
   * original order and resume at the next idle boundary.
   *
   * Returns whether at least one task was dispatched.
   */
  flush(): boolean {
    if (this.disposed) {
      return false;
    }
    const batch = this.due.drain();
    let dispatched = false;
    let index = 0;
    for (; index < batch.length; index += 1) {
      if (!this.isIdle()) {
        break;
      }
      const queued = batch[index]!;
      const entry = this.entries.get(queued.id);
      const task = this.registry.get(queued.id);
      if (!entry || !task) {
        // Deleted from the registry, or never tracked: drop it silently.
        if (entry) {
          this.forget(entry);
        }
        continue;
      }
      if (task.mode === "self-paced") {
        this.beginSelfPacedRun(entry, task);
      } else {
        // A queued run whose task expired during a long busy period is dropped
        // (and removed from persistence) instead of being delivered late.
        if (this.expireIfPast(entry, task)) {
          continue;
        }
        this.deliverFixed(entry, task);
      }
      dispatched = true;
    }
    // Anything we stopped short of (busy again) keeps its place for next idle.
    for (; index < batch.length; index += 1) {
      const queued = batch[index]!;
      if (this.entries.has(queued.id) && this.registry.has(queued.id)) {
        this.due.mark(queued.id, queued.deadline, queued.seq);
      }
    }
    return dispatched;
  }

  status(): LoopStatus {
    const entry = this.primaryEntry();
    const task = entry === undefined ? undefined : this.registry.get(entry.id);
    const selfPaced = task?.mode === "self-paced";
    return {
      active: task !== undefined,
      intervalMs:
        this.primarySchedule !== undefined && !isCronSchedule(this.primarySchedule)
          ? this.primarySchedule.intervalMs
          : 0,
      task: task?.prompt ?? "",
      pending: entry !== undefined && this.due.has(entry.id),
      ...(task === undefined ? {} : { mode: task.mode }),
      ...(task?.maintenance ? { maintenance: true } : {}),
      ...(selfPaced && entry ? { awaitingDecision: entry.awaitingDecision, fallbackUsed: entry.fallbackUsed } : {}),
      ...(task?.reason === undefined ? {} : { reason: task.reason }),
      ...(this.primarySchedule === undefined ? {} : { schedule: this.primarySchedule }),
    };
  }

  /** IDs of every currently due task, in flush order. */
  dueTaskIds(): string[] {
    return this.due.list().map((entry) => entry.id);
  }

  /** IDs of every task the scheduler is tracking, in registration order. */
  trackedTaskIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * The self-paced task a wakeup/stop operation currently targets: the executing
   * iteration when one is bound, otherwise the command-owned self-paced loop.
   * `undefined` when neither exists. Hosts use this to describe or guard
   * iteration-scoped operations without assuming the target is the primary loop.
   */
  activeSelfPacedTask(): ScheduledTask | undefined {
    const entry = this.resolveSelfPacedEntry();
    if (entry === undefined) {
      return undefined;
    }
    const task = this.registry.get(entry.id);
    return task?.mode === "self-paced" ? task : undefined;
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new Error("scheduler has been disposed");
    }
  }

  private primaryEntry(): TrackedTask | undefined {
    return this.primaryId === undefined ? undefined : this.entries.get(this.primaryId);
  }

  /**
   * The tracked entry for a live self-paced binding, or `undefined` when the
   * binding is absent or stale. It deliberately does not clear a stale binding:
   * the executing turn stays fail-closed until {@link settleIteration} (or
   * {@link stopTask}) releases it at the turn boundary.
   */
  private liveBoundEntry(): TrackedTask | undefined {
    if (this.activeSelfPacedId === undefined) {
      return undefined;
    }
    const entry = this.entries.get(this.activeSelfPacedId);
    if (entry === undefined || this.registry.get(entry.id)?.mode !== "self-paced") {
      return undefined;
    }
    return entry;
  }

  /**
   * The command-owned loop entry when it is self-paced, else `undefined`. This is
   * the backward-compatible target for wakeup/stop/settle calls made outside an
   * executing iteration.
   */
  private primarySelfPacedEntry(): TrackedTask | undefined {
    const entry = this.primaryEntry();
    if (entry === undefined) {
      return undefined;
    }
    return this.registry.get(entry.id)?.mode === "self-paced" ? entry : undefined;
  }

  /**
   * Resolve the self-paced entry a wakeup operation targets: the currently
   * executing iteration when its binding is live, otherwise the command-owned
   * self-paced loop. When a binding exists but is stale, this returns `undefined`
   * (fail closed) and never falls back to the command loop, so a late wakeup from
   * one task can never hit another.
   */
  private resolveSelfPacedEntry(): TrackedTask | undefined {
    if (this.activeSelfPacedId !== undefined) {
      return this.liveBoundEntry();
    }
    return this.primarySelfPacedEntry();
  }

  private track(task: ScheduledTask): TrackedTask {
    const entry: TrackedTask = {
      id: task.id,
      seq: this.nextSeq++,
      token: this.nextToken++,
      timer: null,
      timerDue: undefined,
      timerCapped: false,
      awaitingDecision: false,
      fallbackUsed: false,
      fallbackDelayMs: DEFAULT_WAKEUP_FALLBACK_MS,
      runToken: 0,
    };
    this.entries.set(task.id, entry);
    return entry;
  }

  /** Remove an entry's timer and bookkeeping, and clear it from the due queue. */
  private removeEntry(entry: TrackedTask): void {
    if (this.entries.get(entry.id) === entry) {
      this.entries.delete(entry.id);
    }
    this.clearTimer(entry);
    this.due.remove(entry.id);
    if (this.primaryId === entry.id) {
      this.primaryId = undefined;
      this.primarySchedule = undefined;
    }
    // The iteration binding is deliberately NOT cleared here. If this entry was
    // the executing iteration, the agent turn is still active; keeping the now
    // stale id as a sentinel makes later wakeup/stop/settle calls in the same
    // turn fail closed instead of retargeting the command-owned loop or another
    // task. `settleIteration` releases the sentinel at the turn boundary (and
    // `stopAll`/`dispose` release it on teardown).
  }

  /** Drop an entry whose registry task has disappeared, without touching the registry. */
  private forget(entry: TrackedTask): void {
    this.removeEntry(entry);
  }

  /**
   * The next boundary for a task. Interval schedules use the ID-derived jitter
   * phase; cron schedules are exact local-time occurrences and are never
   * jittered.
   */
  private nextBoundary(schedule: TaskSchedule, id: string, after: number): number {
    return nextTaskFireAt(schedule, id, after, this.deps.jitterOffset ?? jitterOffsetMs);
  }

  /**
   * Remove a fixed or one-shot task whose expiry has already passed, without
   * dispatching. A boundary exactly at the expiry is allowed to run; only a run
   * strictly *after* expiry is dropped. Returns whether the task was removed.
   *
   * This is the safety net for a delayed tick or a long busy period: the run-time
   * guard removes the task from the registry, its timer, the due queue, and (at
   * runtime) persistence even when no further boundary is ever reached.
   */
  private expireIfPast(entry: TrackedTask, task: ScheduledTask): boolean {
    const expiresAt = this.registry.get(entry.id)?.expiresAt ?? task.expiresAt;
    if (expiresAt === undefined || expiresAt >= this.deps.now()) {
      return false;
    }
    this.stopTask(entry.id, { persist: this.restoreDepth === 0 });
    return true;
  }

  /**
   * Arm a timer for the task's next boundary. The boundary is taken from the
   * stored schedule, so arming late (after a slow tick or a clock jump) skips
   * missed boundaries instead of shifting the schedule. A task whose next
   * boundary is past its expiry is removed instead of armed.
   */
  private arm(entry: TrackedTask, task: ScheduledTask): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    const schedule = this.registry.get(entry.id)?.schedule ?? task.schedule;
    if (!schedule) {
      return;
    }
    this.clearTimer(entry);
    const now = this.deps.now();
    // Cron boundaries are exact local-time occurrences, so always recompute the
    // true next one (a stored time may be stale after a reload or a long busy
    // period). Interval boundaries keep their stored, ID-jittered phase.
    const due = isCronSchedule(schedule)
      ? this.nextBoundary(schedule, entry.id, now)
      : task.nextFireAt !== undefined && task.nextFireAt > now
        ? task.nextFireAt
        : this.nextBoundary(schedule, entry.id, now);
    const expiresAt = this.registry.get(entry.id)?.expiresAt ?? task.expiresAt;
    if (expiresAt !== undefined && (expiresAt <= now || due > expiresAt)) {
      this.stopTask(entry.id, { persist: this.restoreDepth === 0 });
      return;
    }
    if (due !== task.nextFireAt) {
      this.registry.update(entry.id, { nextFireAt: due });
    }
    this.armTimer(entry, due);
  }

  /** Arm a one-shot timer for the self-paced task's stored `nextFireAt`. */
  private armSelfPaced(entry: TrackedTask, task: ScheduledTask): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    const current = this.registry.get(entry.id);
    if (!current || current.mode !== "self-paced") {
      return;
    }
    this.armAtTime(entry, current.nextFireAt ?? this.deps.now());
  }

  /** Arm a timer to fire once at `due`, clamped so it never fires in the past. */
  private armAtTime(entry: TrackedTask, due: number): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    this.clearTimer(entry);
    this.armTimer(entry, due);
  }

  /**
   * Arm one timer for the absolute time `due`.
   *
   * The delay is capped at {@link MAX_CADENCE_MS} because `setTimeout` treats an
   * oversized delay as zero (a spin). When capped, the callback fires early and
   * {@link onTick} re-arms for the remainder, so a boundary arbitrarily far in
   * the future (a yearly cron occurrence) is still reached without overflow.
   */
  private armTimer(entry: TrackedTask, due: number): void {
    const token = entry.token;
    entry.timerDue = due;
    const remaining = due - this.deps.now();
    entry.timerCapped = remaining > MAX_CADENCE_MS;
    const delayMs = Math.max(0, Math.min(remaining, MAX_CADENCE_MS));
    entry.timer = this.deps.setTimer(() => {
      entry.timer = null;
      // A replaced task has a fresh entry (and token); a stopped task has none.
      if (this.entries.get(entry.id) !== entry || entry.token !== token) {
        return;
      }
      this.onTick(entry);
    }, delayMs);
  }

  private onTick(entry: TrackedTask): void {
    const task = this.registry.get(entry.id);
    if (!task) {
      this.forget(entry);
      return;
    }
    // A capped timer fires early (see `armTimer`); re-arm for the remainder
    // instead of treating the early wake as a real boundary.
    if (entry.timerCapped && entry.timerDue !== undefined && this.deps.now() < entry.timerDue) {
      this.armTimer(entry, entry.timerDue);
      return;
    }
    if (task.mode === "self-paced") {
      this.onSelfPacedTick(entry, task);
      return;
    }
    // A delayed tick (a sleep, a clock jump) may arrive after expiry. Remove the
    // task instead of delivering an expired run, even while Pi is busy.
    if (this.expireIfPast(entry, task)) {
      return;
    }
    if (task.mode === "one-shot") {
      // A one-shot either fires once now or is queued for the next idle moment;
      // it is never re-armed.
      if (this.isIdle()) {
        this.deliverFixed(entry, task);
      } else {
        this.markDue(entry, task.nextFireAt ?? this.deps.now());
      }
      return;
    }
    if (!task.schedule) {
      return;
    }
    if (this.isIdle()) {
      this.deliverFixed(entry, task);
    } else {
      // Busy: record the miss in the scheduler's queue and keep the schedule.
      this.markDue(entry, task.nextFireAt ?? this.deps.now());
    }
    // Dispatch may have stopped or replaced this task; do not re-arm then.
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    const current = this.registry.get(entry.id);
    if (!current || !current.schedule) {
      return;
    }
    // Boundaries are absolute and ID-jittered, so derive the next one from the
    // schedule rather than from the tick time. Missed boundaries collapse into
    // the one queue entry already recorded.
    const due = this.nextBoundary(current.schedule, current.id, this.deps.now());
    const advanced = this.registry.update(current.id, { nextFireAt: due });
    this.arm(entry, advanced);
  }

  /**
   * A self-paced wakeup came due. Deliver it now when idle, otherwise mark it
   * due so the next idle signal flushes it. No timer is re-armed: the next
   * wakeup is chosen by the iteration that is about to run.
   */
  private onSelfPacedTick(entry: TrackedTask, task: ScheduledTask): void {
    if (this.isIdle()) {
      this.beginSelfPacedRun(entry, task);
    } else {
      this.markDue(entry, task.nextFireAt ?? this.deps.now());
    }
  }

  /** Record a missed run in the scheduler queue, coalescing a repeat. */
  private markDue(entry: TrackedTask, deadline: number): void {
    if (this.entries.get(entry.id) !== entry) {
      return;
    }
    if (this.due.mark(entry.id, deadline, entry.seq)) {
      this.setPending(entry.id, true);
    }
  }

  /** Mirror the queue state onto the registry record for status/diagnostics. */
  private setPending(id: string, pending: boolean): void {
    if (this.registry.has(id)) {
      this.registry.update(id, { pending });
    }
  }

  /**
   * Deliver a due fixed or one-shot run: resolve its prompt, clear its queued
   * state, and dispatch. Returns whether a dispatch was attempted. A one-shot is
   * removed after it fires (or fails to resolve) so it never repeats.
   *
   * A prompt that cannot be resolved is reported and this run is skipped; the
   * schedule has already advanced, so the next boundary retries without
   * retaining a queued run or spamming retries.
   */
  private deliverFixed(entry: TrackedTask, task: ScheduledTask): boolean {
    this.due.remove(entry.id);
    // Last line of defense: never dispatch a task whose expiry has passed.
    if (this.expireIfPast(entry, task)) {
      return false;
    }
    if (this.entries.get(entry.id) !== entry || !this.registry.has(entry.id)) {
      return false;
    }
    const updated = this.registry.update(entry.id, { pending: false });
    let prompt: string;
    try {
      prompt = this.resolvePrompt(updated);
    } catch (error) {
      this.onError?.(error);
      if (updated.mode === "one-shot") {
        this.stopTask(entry.id);
      }
      return false;
    }
    this.safeDispatch(updated, prompt, entry);
    if (updated.mode === "one-shot") {
      this.stopTask(entry.id);
    }
    return true;
  }

  /**
   * Dispatch one self-paced run and mark the iteration as awaiting a choice.
   * Returns false (and leaves the run queued for retry) when delivery throws.
   *
   * The awaiting flag is set *before* dispatch so a dispatch that synchronously
   * reschedules (which clears the flag and arms the next timer) is not
   * overwritten afterwards. The entry is bound as the current executing
   * iteration for the same reason, so an inline {@link scheduleNextWakeup} or
   * {@link stop} resolves to this task rather than the command-owned loop.
   *
   * Only one self-paced iteration runs at a time (Pi dispatches one agent turn at
   * a time). When a different iteration is already bound, this run is queued for
   * the next idle boundary instead of running concurrently, so each task's
   * decision state stays unambiguous.
   *
   * If the prompt cannot be resolved, no iteration runs and therefore no next
   * wakeup can be chosen; the bounded fallback policy applies so a resolution
   * failure cannot stall the loop.
   */
  private beginSelfPacedRun(entry: TrackedTask, task: ScheduledTask): boolean {
    this.due.remove(entry.id);
    if (this.activeSelfPacedId !== undefined && this.activeSelfPacedId !== entry.id) {
      // Another iteration (or a turn whose bound task was removed) owns the
      // active agent turn. Coalesce this due wakeup into the queue rather than
      // delivering it concurrently.
      this.markDue(entry, task.nextFireAt ?? this.deps.now());
      return false;
    }
    let prompt: string;
    try {
      prompt = this.resolvePrompt(task);
    } catch (error) {
      this.onError?.(error);
      const settled = this.applyMissedChoice(entry, task);
      return settled.action === "fallback";
    }
    if (this.entries.get(entry.id) !== entry || !this.registry.has(entry.id)) {
      return false;
    }
    const updated = this.registry.update(entry.id, { pending: false });
    entry.runToken += 1;
    entry.awaitingDecision = true;
    this.activeSelfPacedId = entry.id;
    const delivered = this.safeDispatch(updated, prompt, entry, entry.runToken);
    // A synchronous dispatch error clears the flag in onDispatchError; a
    // replacement/stop during dispatch owns the entry already, so leave it.
    if (delivered && this.entries.get(entry.id) === entry && this.registry.get(entry.id)?.id === task.id) {
      return true;
    }
    return false;
  }

  /**
   * Apply the bounded fallback policy for an iteration that produced no next
   * wakeup: grant one fallback wakeup, then remove the task on a second
   * consecutive miss so a broken loop can never spin forever. Also used when a
   * maintenance prompt cannot be resolved and no iteration ran to choose a
   * wakeup.
   */
  private applyMissedChoice(entry: TrackedTask, task: ScheduledTask): IterationSettleResult {
    if (this.entries.get(entry.id) !== entry) {
      return { action: "none" };
    }
    if (entry.fallbackUsed) {
      this.stopTask(entry.id);
      return { action: "terminated" };
    }
    entry.fallbackUsed = true;
    const delay = clampWakeupDelay(entry.fallbackDelayMs);
    const fallbackAt = this.deps.now() + delay;
    const updated = this.registry.update(entry.id, { nextFireAt: fallbackAt, pending: false, reason: null });
    this.due.remove(entry.id);
    this.clearTimer(entry);
    this.armSelfPaced(entry, updated);
    return { action: "fallback", delayMs: delay, nextFireAt: fallbackAt };
  }

  /** Dispatch a task snapshot and its resolved prompt. Returns false on a synchronous throw. */
  private safeDispatch(task: ScheduledTask, prompt: string, entry: TrackedTask, token?: number): boolean {
    try {
      const result = this.dispatch(task, prompt);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error) => {
          this.onDispatchError(error, entry, token);
        });
      }
      return true;
    } catch (error) {
      this.onDispatchError(error, entry, token);
      return false;
    }
  }

  private onDispatchError(error: unknown, entry: TrackedTask, token?: number): void {
    // Retain at most one queued run per task and retry only at the next tick or
    // idle signal, so a failing dispatch can never spin. A rejection from a task
    // that has since been stopped or replaced must not requeue its successor,
    // so requeue only when the failing dispatch's entry is still current.
    if (this.entries.get(entry.id) === entry) {
      const task = this.registry.get(entry.id);
      if (task?.mode === "self-paced") {
        // Only the iteration that is still awaiting a choice may be recovered,
        // so a late rejection cannot requeue a run whose iteration already
        // rescheduled or one from a previous run.
        if (token !== undefined && token === entry.runToken && entry.awaitingDecision && !this.due.has(entry.id)) {
          entry.awaitingDecision = false;
          this.markDue(entry, task.nextFireAt ?? this.deps.now());
        }
      } else if (task && !this.due.has(entry.id)) {
        this.markDue(entry, task.nextFireAt ?? this.deps.now());
      }
    }
    this.onError?.(error);
  }

  private clearTimer(entry: TrackedTask): void {
    if (entry.timer !== null) {
      this.deps.clearTimer(entry.timer);
      entry.timer = null;
    }
  }

  /**
   * Persist one mutation. Suppressed while replaying persisted state so a reload
   * cannot append duplicate events. A failing sink is reported through `onError`
   * and never interrupts scheduling.
   */
  private persist(event: PersistedEvent): void {
    if (this.restoreDepth > 0 || !this.persistEvent) {
      return;
    }
    try {
      this.persistEvent(event);
    } catch (error) {
      this.onError?.(error);
    }
  }

  private persistCreate(task: ScheduledTask): void {
    const snapshot = this.snapshot(task);
    if (snapshot) {
      this.persist(createTaskEvent(snapshot));
    }
  }

  /** Build the persisted view of a task, or `undefined` for an ephemeral one. */
  private snapshot(task: ScheduledTask): PersistedTask | undefined {
    if (task.mode === "self-paced") {
      return undefined;
    }
    return {
      id: task.id,
      prompt: task.prompt,
      mode: task.mode,
      ...(task.maintenance ? { maintenance: true } : {}),
      ...(this.primaryId === task.id ? { primary: true } : {}),
      createdAt: task.createdAt,
      ...(task.schedule === undefined ? {} : { schedule: cloneSchedule(task.schedule) }),
      ...(task.nextFireAt === undefined ? {} : { nextFireAt: task.nextFireAt }),
      ...(task.expiresAt === undefined ? {} : { expiresAt: task.expiresAt }),
    };
  }
}
