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
import type { ScheduledTask, TaskRegistry } from "./task-registry.ts";

/** Minimum accepted parse-time interval. Sub-minute values normalize at scheduling. */
export const MIN_INTERVAL_MS = 1_000;
/** Maximum accepted interval; `setTimeout` is capped at a signed 32-bit delay. */
export const MAX_INTERVAL_MS = 2_147_483_647;

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
 * - `<prompt>` (literal task, default interval)
 * - `<interval>` and bare `/loop` (maintenance loops; prompt wiring lands with
 *   the maintenance-mode work)
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
    `${head}/loop <task>                           repeat <task> at the configured default (1min)\n` +
    `/loop <n><unit> <task>                    set the interval (units: s, min, h, d)\n` +
    `/loop <task> every <n><unit>              set the interval after the task\n` +
    `/loop every <n><unit> <task>              Pi-compatible alias for the above\n` +
    `/loop stop                                 cancel the active loop\n` +
    `/loop status                               show the active loop\n` +
    `Intervals round to a cron cadence: seconds up to 1min, and steps such as 7m or 90m to the nearest supported value.`
  );
}

/** Guidance for bare/interval-only maintenance loops that are not wired up yet. */
export function maintenanceText(intervalMs?: number): string {
  const interval = intervalMs === undefined ? "5m" : formatInterval(intervalMs);
  return (
    `Maintenance loops (bare or interval-only /loop) are not available yet.\n` +
    `Add a task to start a loop, e.g. /loop ${interval} <task>.`
  );
}

/** Snapshot of scheduler state for `/loop status`. */
export interface LoopStatus {
  active: boolean;
  /** Effective, normalized cadence in milliseconds. */
  intervalMs: number;
  task: string;
  pending: boolean;
  /** The stored schedule representation, when a fixed loop is active. */
  schedule?: FixedSchedule;
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
 * One fixed loop scoped to a single session.
 *
 * The scheduler holds the active task's ID and its schedule; the task record
 * itself lives in the shared {@link TaskRegistry}.
 *
 * Design guarantees:
 * - A requested interval is normalized to a supported cron cadence (minimum
 *   one minute; seconds and awkward steps round to the nearest cadence).
 * - Fire times are absolute schedule boundaries, so a late tick, a long busy
 *   period, or a clock jump never shifts later boundaries.
 * - At most one pending run exists; missed boundaries coalesce into it and are
 *   never replayed as a backlog.
 * - A generation counter makes callbacks from a replaced/stopped loop no-ops.
 * - `stop`/`dispose` are idempotent and leave no live timer.
 */
export class LoopScheduler {
  private timer: unknown = null;
  private generation = 0;
  private disposed = false;
  private schedule: FixedSchedule | undefined;
  private taskId: string | undefined;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly registry: TaskRegistry,
    private readonly dispatch: (task: ScheduledTask) => void | Promise<void>,
    private readonly isIdle: () => boolean,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(intervalMs: number, task: string): void {
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
      schedule,
      nextFireAt: nextFireAt(schedule, this.deps.now()),
    });
    this.taskId = created.id;
    this.schedule = schedule;
    this.arm(this.generation, created);
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
    const updated = this.registry.update(task.id, { pending: false });
    this.safeDispatch(updated, this.generation);
    return true;
  }

  status(): LoopStatus {
    const task = this.currentTask();
    return {
      active: task !== undefined,
      intervalMs: this.schedule?.intervalMs ?? 0,
      task: task?.prompt ?? "",
      pending: task?.pending ?? false,
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

  private onTick(generation: number): void {
    if (generation !== this.generation) {
      return;
    }
    const task = this.currentTask();
    if (!task || !task.schedule) {
      return;
    }
    if (this.isIdle()) {
      const updated = this.registry.update(task.id, { pending: false });
      this.safeDispatch(updated, generation);
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

  private safeDispatch(task: ScheduledTask, generation: number): void {
    try {
      const result = this.dispatch(task);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error) => {
          this.onDispatchError(error, generation);
        });
      }
    } catch (error) {
      this.onDispatchError(error, generation);
    }
  }

  private onDispatchError(error: unknown, generation: number): void {
    // Retain at most one pending run and retry only at the next tick or idle
    // signal, so a failing dispatch can never spin. A rejection from a task
    // that has since been stopped or replaced must not requeue its successor,
    // so requeue only when the failing dispatch's generation is still current.
    if (generation === this.generation) {
      const task = this.currentTask();
      if (task && !task.pending) {
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
