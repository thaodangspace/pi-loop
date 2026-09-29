/**
 * Pure, Pi-independent loop primitives: command parsing and the interval
 * scheduler. Nothing in this file imports the Pi runtime, so it can be tested
 * with deterministic fake timers.
 *
 * The scheduler keeps no task state of its own; the authoritative task record
 * lives in a {@link TaskRegistry}, one per session.
 */
import {
  createSchedule,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  nextFireAt,
  type FixedSchedule,
} from "./schedule.ts";
import type { ScheduledTask, TaskMode, TaskRegistry } from "./task-registry.ts";

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
  schedule?: FixedSchedule;
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
 * The wakeup API an iteration may call while the loop is self-paced.
 *
 * This is the scheduler contract, not a prompt-text convention: a delivered
 * iteration either schedules its next wakeup or stops the loop. Anything that
 * exposes these operations to the model (for example a Pi tool) should delegate
 * here rather than re-implement scheduling.
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
}

export const systemTimers: SchedulerDeps = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One loop scoped to a single session, in either fixed or self-paced mode.
 *
 * The scheduler holds the active task's ID and its timing state; the task record
 * itself lives in the shared {@link TaskRegistry}. Both modes share the same
 * dispatch path, pending-run coalescing, idle gate, and generation guard.
 *
 * Fixed mode guarantees:
 * - A requested interval is normalized to a supported cron cadence (minimum
 *   one minute; seconds and awkward steps round to the nearest cadence).
 * - Fire times are absolute schedule boundaries, so a late tick, a long busy
 *   period, or a clock jump never shifts later boundaries.
 *
 * Self-paced mode guarantees:
 * - An iteration chooses its next wakeup with {@link scheduleNextWakeup}, whose
 *   delay is clamped into [1 minute, 1 hour].
 * - An iteration may stop the loop instead (`stop`).
 * - An iteration that does neither gets one bounded fallback wakeup; if that
 *   fallback iteration also misses, the loop terminates rather than spinning.
 *
 * Shared guarantees:
 * - At most one pending run exists; missed occurrences coalesce into it and are
 *   never replayed as a backlog.
 * - A generation counter makes callbacks from a replaced/stopped loop no-ops.
 * - `stop`/`dispose` are idempotent and leave no live timer.
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
  private timer: unknown = null;
  private generation = 0;
  private disposed = false;
  private schedule: FixedSchedule | undefined;
  private taskId: string | undefined;
  private mode: TaskMode | undefined;
  private awaitingDecision = false;
  private fallbackUsed = false;
  private fallbackDelayMs = DEFAULT_WAKEUP_FALLBACK_MS;
  /** Monotonic id for the latest self-paced delivery, to ignore stale failures. */
  private runToken = 0;

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
  ) {}

  start(intervalMs: number, task: string, options: StartOptions = {}): void {
    if (this.disposed) {
      throw new Error("scheduler has been disposed");
    }
    if (!task.trim()) {
      throw new Error("task must not be empty");
    }
    this.stop();
    const schedule = createSchedule(intervalMs);
    const created = this.registry.create({
      prompt: task,
      mode: "fixed",
      ...(options.maintenance ? { maintenance: true } : {}),
      schedule,
      nextFireAt: nextFireAt(schedule, this.deps.now()),
    });
    this.taskId = created.id;
    this.schedule = schedule;
    this.mode = "fixed";
    this.arm(this.generation, created);
  }

  /**
   * Start a self-paced loop. The prompt is due immediately; each delivered
   * iteration is expected to call {@link scheduleNextWakeup} or `stop` before it
   * settles. A missing choice triggers the bounded fallback described on the
   * class. The task is created in the shared registry with mode `self-paced`.
   */
  startSelfPaced(prompt: string, options: SelfPacedStartOptions = {}): ScheduledTask {
    if (this.disposed) {
      throw new Error("scheduler has been disposed");
    }
    if (!prompt.trim()) {
      throw new Error("task must not be empty");
    }
    const fallbackDelayMs = clampWakeupDelay(options.fallbackDelayMs ?? DEFAULT_WAKEUP_FALLBACK_MS);
    this.stop();
    const created = this.registry.create({
      prompt,
      mode: "self-paced",
      ...(options.maintenance ? { maintenance: true } : {}),
      nextFireAt: this.deps.now(),
    });
    this.taskId = created.id;
    this.mode = "self-paced";
    this.fallbackDelayMs = fallbackDelayMs;
    this.awaitingDecision = false;
    this.fallbackUsed = false;
    this.armSelfPaced(this.generation, created);
    return created;
  }

  /**
   * Schedule the next wakeup of the active self-paced loop.
   *
   * The requested delay is clamped into [1 minute, 1 hour]. An explicit choice
   * clears the fallback allowance, so the loop cannot be terminated for a miss
   * that a later iteration fixed. Throws {@link WakeupError} when no self-paced
   * loop is active or the scheduler is disposed.
   */
  scheduleNextWakeup(delayMs: number, reason?: string): WakeupDecision {
    if (this.disposed) {
      throw new WakeupError("scheduler has been disposed");
    }
    const task = this.currentTask();
    if (!task || task.mode !== "self-paced") {
      throw new WakeupError("no self-paced loop is running");
    }
    const delay = clampWakeupDelay(delayMs);
    const nextFireAtValue = this.deps.now() + delay;
    const updated = this.registry.update(task.id, {
      nextFireAt: nextFireAtValue,
      pending: false,
      reason: reason ?? null,
    });
    this.awaitingDecision = false;
    this.fallbackUsed = false;
    this.clear();
    this.armSelfPaced(this.generation, updated);
    return {
      requestedMs: delayMs,
      delayMs: delay,
      clamped: delay !== delayMs,
      nextFireAt: nextFireAtValue,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  /**
   * End the current self-paced iteration and apply the bounded fallback policy
   * when it neither rescheduled nor stopped. Safe to call at every idle boundary
   * for every mode; returns `{ action: "none" }` when nothing was pending.
   */
  settleIteration(): IterationSettleResult {
    if (this.disposed) {
      return { action: "none" };
    }
    const task = this.currentTask();
    if (!task || task.mode !== "self-paced" || !this.awaitingDecision) {
      return { action: "none" };
    }
    this.awaitingDecision = false;
    return this.applyMissedChoice(task);
  }

  /**
   * Apply the bounded fallback policy for an iteration that produced no next
   * wakeup: grant one fallback wakeup, then terminate on a second consecutive
   * miss so a broken loop can never spin forever. Also used when a maintenance
   * prompt cannot be resolved and no iteration ran to choose a wakeup.
   */
  private applyMissedChoice(task: ScheduledTask): IterationSettleResult {
    if (this.fallbackUsed) {
      this.stop();
      return { action: "terminated" };
    }
    this.fallbackUsed = true;
    const delay = clampWakeupDelay(this.fallbackDelayMs);
    const fallbackAt = this.deps.now() + delay;
    const updated = this.registry.update(task.id, { nextFireAt: fallbackAt, pending: false, reason: null });
    this.clear();
    this.armSelfPaced(this.generation, updated);
    return { action: "fallback", delayMs: delay, nextFireAt: fallbackAt };
  }

  /** Cancel the active loop. Returns whether a loop was running. Idempotent. */
  stop(): boolean {
    const active = this.currentTask() !== undefined;
    this.generation += 1;
    this.clear();
    if (this.taskId !== undefined) {
      this.registry.delete(this.taskId);
    }
    this.taskId = undefined;
    this.schedule = undefined;
    this.mode = undefined;
    this.awaitingDecision = false;
    this.fallbackUsed = false;
    return active;
  }

  /** Permanently disable the scheduler and drop any timer. Idempotent. */
  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  /**
   * Deliver a coalesced pending run when idle. Returns whether a dispatch
   * happened. Safe to call on every idle signal; a no-op otherwise.
   */
  flush(): boolean {
    if (this.disposed) {
      return false;
    }
    const task = this.currentTask();
    if (!task || !task.pending || !this.isIdle()) {
      return false;
    }
    if (task.mode === "self-paced") {
      return this.beginSelfPacedRun(this.generation, task);
    }
    return this.deliverFixed(task, this.generation);
  }

  status(): LoopStatus {
    const task = this.currentTask();
    const selfPaced = task?.mode === "self-paced";
    return {
      active: task !== undefined,
      intervalMs: this.schedule?.intervalMs ?? 0,
      task: task?.prompt ?? "",
      pending: task?.pending ?? false,
      ...(task === undefined ? {} : { mode: task.mode }),
      ...(task?.maintenance ? { maintenance: true } : {}),
      ...(selfPaced ? { awaitingDecision: this.awaitingDecision, fallbackUsed: this.fallbackUsed } : {}),
      ...(task?.reason === undefined ? {} : { reason: task.reason }),
      ...(this.schedule === undefined ? {} : { schedule: this.schedule }),
    };
  }

  private currentTask(): ScheduledTask | undefined {
    return this.taskId === undefined ? undefined : this.registry.get(this.taskId);
  }

  /**
   * Arm a timer for the task's next boundary. The boundary is taken from the
   * stored schedule, so arming late (after a slow tick or a clock jump) skips
   * missed boundaries instead of shifting the schedule.
   */
  private arm(generation: number, task: ScheduledTask): void {
    if (generation !== this.generation) {
      return;
    }
    const schedule = this.registry.get(task.id)?.schedule ?? task.schedule;
    if (!schedule) {
      return;
    }
    const now = this.deps.now();
    const due =
      task.nextFireAt !== undefined && task.nextFireAt > now ? task.nextFireAt : nextFireAt(schedule, now);
    if (due !== task.nextFireAt) {
      this.registry.update(task.id, { nextFireAt: due });
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.onTick(generation);
    }, due - now);
  }

  /** Arm a one-shot timer for the self-paced task's stored `nextFireAt`. */
  private armSelfPaced(generation: number, task: ScheduledTask): void {
    if (generation !== this.generation) {
      return;
    }
    const current = this.registry.get(task.id);
    if (!current || current.mode !== "self-paced") {
      return;
    }
    const now = this.deps.now();
    const due = current.nextFireAt ?? now;
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.onTick(generation);
    }, Math.max(0, due - now));
  }

  private onTick(generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    const task = this.currentTask();
    if (!task) {
      return;
    }
    if (task.mode === "self-paced") {
      this.onSelfPacedTick(generation, task);
      return;
    }
    if (!task.schedule) {
      return;
    }
    if (this.isIdle()) {
      this.deliverFixed(task, generation);
    } else {
      this.registry.update(task.id, { pending: true });
    }
    // Dispatch may have stopped or replaced the loop; do not re-arm then.
    if (generation !== this.generation) {
      return;
    }
    const current = this.currentTask();
    if (!current || !current.schedule) {
      return;
    }
    // Boundaries are absolute, so derive the next one from the schedule rather
    // than from the tick time. Missed boundaries collapse into the current run.
    const due = nextFireAt(current.schedule, this.deps.now());
    const advanced = this.registry.update(current.id, { nextFireAt: due });
    this.arm(generation, advanced);
  }

  /**
   * A self-paced wakeup came due. Deliver it now when idle, otherwise mark it
   * pending so the next idle signal flushes it. No timer is re-armed: the next
   * wakeup is chosen by the iteration that is about to run.
   */
  private onSelfPacedTick(generation: number, task: ScheduledTask): void {
    if (this.isIdle()) {
      this.beginSelfPacedRun(generation, task);
    } else {
      this.registry.update(task.id, { pending: true });
    }
  }

  /**
   * Deliver a due fixed run: resolve its prompt, clear the pending flag, and
   * dispatch. Returns whether a dispatch was attempted.
   *
   * A prompt that cannot be resolved is reported and this run is skipped; the
   * schedule has already advanced, so the next boundary retries without
   * retaining a pending run or spamming retries.
   */
  private deliverFixed(task: ScheduledTask, generation: number): boolean {
    const updated = this.registry.update(task.id, { pending: false });
    let prompt: string;
    try {
      prompt = this.resolvePrompt(updated);
    } catch (error) {
      this.onError?.(error);
      return false;
    }
    this.safeDispatch(updated, prompt, generation);
    return true;
  }

  /**
   * Dispatch one self-paced run and mark the iteration as awaiting a choice.
   * Returns false (and leaves the run pending for retry) when delivery throws.
   *
   * The awaiting flag is set *before* dispatch so a dispatch that synchronously
   * reschedules (which clears the flag and arms the next timer) is not
   * overwritten afterwards.
   *
   * If the prompt cannot be resolved, no iteration runs and therefore no next
   * wakeup can be chosen; the bounded fallback policy applies so a resolution
   * failure cannot stall the loop.
   */
  private beginSelfPacedRun(generation: number, task: ScheduledTask): boolean {
    let prompt: string;
    try {
      prompt = this.resolvePrompt(task);
    } catch (error) {
      this.onError?.(error);
      const settled = this.applyMissedChoice(task);
      return settled.action === "fallback";
    }
    const updated = this.registry.update(task.id, { pending: false });
    this.runToken += 1;
    this.awaitingDecision = true;
    const delivered = this.safeDispatch(updated, prompt, generation, this.runToken);
    // A synchronous dispatch error clears the flag in onDispatchError; a
    // replacement/stop during dispatch owns the flag already, so leave it.
    if (delivered && generation === this.generation && this.currentTask()?.id === task.id) {
      return true;
    }
    return false;
  }

  /** Dispatch a task snapshot and its resolved prompt. Returns false on a synchronous throw. */
  private safeDispatch(task: ScheduledTask, prompt: string, generation: number, token?: number): boolean {
    try {
      const result = this.dispatch(task, prompt);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error) => {
          this.onDispatchError(error, generation, token);
        });
      }
      return true;
    } catch (error) {
      this.onDispatchError(error, generation, token);
      return false;
    }
  }

  private onDispatchError(error: unknown, generation: number, token?: number): void {
    // Retain at most one pending run and retry only at the next tick or idle
    // signal, so a failing dispatch can never spin. A rejection from a task
    // that has since been stopped or replaced must not requeue its successor,
    // so requeue only when the failing dispatch's generation is still current.
    if (generation === this.generation) {
      const task = this.currentTask();
      if (task?.mode === "self-paced") {
        // Only the iteration that is still awaiting a choice may be recovered,
        // so a late rejection cannot requeue a run whose iteration already
        // rescheduled or one from a previous run.
        if (token !== undefined && token === this.runToken && this.awaitingDecision && !task.pending) {
          this.registry.update(task.id, { pending: true });
          this.awaitingDecision = false;
        }
      } else if (task && !task.pending) {
        this.registry.update(task.id, { pending: true });
      }
    }
    this.onError?.(error);
  }

  private clear(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
