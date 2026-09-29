/**
 * Pure, Pi-independent loop primitives: command parsing and the interval
 * scheduler. Nothing in this file imports the Pi runtime, so it can be tested
 * with deterministic fake timers.
 */

/** Minimum accepted interval. Keeps the scheduler from creating a tight timer. */
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
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}min`;
  return `${ms / 1_000}s`;
}

/** A parsed `/loop` invocation. */
export type LoopCommand =
  | { type: "start"; task: string; intervalMs?: number }
  | { type: "stop" }
  | { type: "status" }
  | { type: "usage"; reason: string };

/**
 * Parse the raw argument string of `/loop`.
 *
 * Precedence: `stop` and `status` are exact commands, `every` introduces an
 * explicit interval, and anything else is a literal task using the default
 * interval. Keeping `stop`/`status` exact means a task such as `stop the build
 * server and restart it` stays a task rather than a control command.
 */
export function parseLoopCommand(rawArgs: string): LoopCommand {
  const args = rawArgs.trim();
  if (!args) {
    return { type: "usage", reason: "missing task" };
  }
  const keyword = args.toLowerCase();
  if (keyword === "stop") {
    return { type: "stop" };
  }
  if (keyword === "status") {
    return { type: "status" };
  }

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
      return { type: "usage", reason: error instanceof Error ? error.message : String(error) };
    }
    const trimmedTask = task.trim();
    if (!trimmedTask) {
      return { type: "usage", reason: "missing task" };
    }
    return { type: "start", intervalMs, task: trimmedTask };
  }

  return { type: "start", task: args };
}

/** User-facing guidance for malformed commands. */
export function usageText(reason?: string): string {
  const head = reason ? `Usage error: ${reason}.\n` : "";
  return (
    `${head}/loop <task>                             repeat <task> at the configured default (1min)\n` +
    `/loop every <n><unit> <task>             set the interval (units: s, min, h)\n` +
    `/loop stop                                cancel the active loop\n` +
    `/loop status                              show the active loop`
  );
}

/** Snapshot of scheduler state for `/loop status`. */
export interface LoopStatus {
  active: boolean;
  intervalMs: number;
  task: string;
  pending: boolean;
}

/** Injected timer primitives so tests can drive time deterministically. */
export interface SchedulerDeps {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const systemTimers: SchedulerDeps = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One interval loop scoped to a single session.
 *
 * Design guarantees:
 * - The first tick fires one full interval after `start`, never immediately.
 * - At most one pending run exists; busy ticks coalesce into it.
 * - A generation counter makes callbacks from a replaced/stopped loop no-ops.
 * - `stop`/`dispose` are idempotent and leave no live timer.
 */
export class LoopScheduler {
  private timer: unknown = null;
  private generation = 0;
  private active = false;
  private disposed = false;
  private pending = false;
  private intervalMs = 0;
  private task = "";

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly dispatch: (task: string) => void | Promise<void>,
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
    this.intervalMs = intervalMs;
    this.task = task;
    this.active = true;
    this.pending = false;
    this.schedule(this.generation);
  }

  /** Cancel the active loop. Returns whether a loop was running. Idempotent. */
  stop(): boolean {
    const wasActive = this.active;
    this.generation += 1;
    this.clear();
    this.active = false;
    this.pending = false;
    this.intervalMs = 0;
    this.task = "";
    return wasActive;
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
    if (this.disposed || !this.active || !this.pending) {
      return false;
    }
    if (!this.isIdle()) {
      return false;
    }
    this.pending = false;
    this.safeDispatch();
    return true;
  }

  status(): LoopStatus {
    return {
      active: this.active,
      intervalMs: this.intervalMs,
      task: this.task,
      pending: this.pending,
    };
  }

  private schedule(generation: number): void {
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      this.onTick(generation);
    }, this.intervalMs);
  }

  private onTick(generation: number): void {
    if (generation !== this.generation || !this.active) {
      return;
    }
    if (this.isIdle()) {
      this.pending = false;
      this.safeDispatch();
    } else {
      this.pending = true;
    }
    // Dispatch may have stopped or replaced the loop; do not re-arm then.
    if (generation !== this.generation || !this.active) {
      return;
    }
    this.schedule(generation);
  }

  private safeDispatch(): void {
    try {
      const result = this.dispatch(this.task);
      if (result && typeof (result as Promise<void>).then === "function") {
        void (result as Promise<void>).catch((error) => {
          this.onDispatchError(error);
        });
      }
    } catch (error) {
      this.onDispatchError(error);
    }
  }

  private onDispatchError(error: unknown): void {
    // Retain at most one pending run and retry only at the next tick or idle
    // signal, so a failing dispatch can never spin.
    if (this.active && !this.pending) {
      this.pending = true;
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
