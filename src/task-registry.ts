/**
 * Pure, Pi-independent task registry: the authoritative store of scheduled
 * tasks for one session.
 *
 * The registry owns the task records and their lifetime (stable IDs, maximum
 * count, deterministic disposal). It creates no timers and holds no shared
 * module-level state, so each Pi session gets an isolated instance and the
 * behavior is fully testable with injected time and ID generation.
 *
 * Fixed scheduling, self-paced wakeups, persistence, expiry, and model-facing
 * tools build on this service rather than creating separate schedulers.
 */
import { randomUUID } from "node:crypto";
import type { FixedSchedule } from "./schedule.ts";

/** How a task decides when it should run next. */
export type TaskMode = "fixed" | "self-paced" | "one-shot";

/**
 * One scheduled task. Instances handed out by the registry are frozen
 * snapshots, so callers cannot mutate registry state by holding a reference.
 */
export interface ScheduledTask {
  /** Stable, short identifier assigned at creation and kept for the task's life. */
  readonly id: string;
  /** The prompt to deliver when the task fires. */
  readonly prompt: string;
  readonly mode: TaskMode;
  /** Creation time from the injected clock. */
  readonly createdAt: number;
  /**
   * Schedule representation for fixed tasks: the normalized cadence and the
   * boundary anchor. Absent for self-paced and one-shot tasks.
   */
  readonly schedule?: FixedSchedule;
  /** When the task is next due, if a schedule has been computed yet. */
  readonly nextFireAt?: number;
  /** True when a run was missed while busy and is queued for the next idle moment. */
  readonly pending: boolean;
}

/** Fields required to create a task. */
export interface NewTask {
  prompt: string;
  mode: TaskMode;
  schedule?: FixedSchedule;
  nextFireAt?: number;
}

/**
 * A partial update to an existing task. Use `nextFireAt: null` (or
 * `schedule: null`) to clear the value; omitting a field leaves it unchanged.
 */
export interface TaskUpdate {
  prompt?: string;
  pending?: boolean;
  schedule?: FixedSchedule | null;
  nextFireAt?: number | null;
}

/** Injectable dependencies so the registry is deterministic under test. */
export interface TaskRegistryOptions {
  /** Clock used to stamp `createdAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Stable-ID generator. Defaults to a short random ID. */
  createId?: () => string;
  /** Maximum number of active tasks. Defaults to {@link DEFAULT_MAX_TASKS}. */
  maxTasks?: number;
}

/** Default cap on active tasks per session. */
export const DEFAULT_MAX_TASKS = 50;

/** Base class for registry failures. */
export class TaskRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskRegistryError";
  }
}

/** Thrown when creating a task would exceed the active-task limit. */
export class TaskLimitError extends TaskRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "TaskLimitError";
  }
}

/** Thrown when an operation references an unknown task ID. */
export class TaskNotFoundError extends TaskRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

/** Thrown when mutating a registry that has been disposed. */
export class RegistryDisposedError extends TaskRegistryError {
  constructor(message = "task registry has been disposed") {
    super(message);
    this.name = "RegistryDisposedError";
  }
}

/** Short, unique-enough default ID (8 base-16 chars). */
function defaultCreateId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

function assertPrompt(prompt: string): void {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TaskRegistryError("task prompt must not be empty");
  }
}

/**
 * In-memory registry of scheduled tasks scoped to a single session.
 *
 * Design guarantees:
 * - IDs are assigned once and never change for the lifetime of a task.
 * - Tasks coexist; creating one never replaces another.
 * - The active-task count is capped and the limit is enforced on create.
 * - All reads return frozen snapshots, so external mutation cannot corrupt state.
 * - `dispose` is idempotent, clears all tasks, and blocks later mutation.
 * - Reads after disposal are safe and simply see an empty registry.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, ScheduledTask>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxTasks: number;
  private disposed = false;

  constructor(options: TaskRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
    this.maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
    if (!Number.isInteger(this.maxTasks) || this.maxTasks <= 0) {
      throw new TaskRegistryError("maxTasks must be a positive integer");
    }
  }

  /** Number of active tasks. Safe to read after disposal (always 0). */
  get size(): number {
    return this.tasks.size;
  }

  /** True once the registry has been disposed. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Create and store a task, returning its frozen snapshot with a stable ID.
   *
   * Throws {@link TaskRegistryError} for an empty prompt, {@link RegistryDisposedError}
   * after disposal, and {@link TaskLimitError} at the active-task limit.
   */
  create(input: NewTask): ScheduledTask {
    this.assertMutable();
    assertPrompt(input.prompt);
    if (this.tasks.size >= this.maxTasks) {
      throw new TaskLimitError(`cannot schedule more than ${this.maxTasks} tasks`);
    }
    const task: ScheduledTask = Object.freeze({
      id: this.allocateId(),
      prompt: input.prompt,
      mode: input.mode,
      createdAt: this.now(),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.nextFireAt === undefined ? {} : { nextFireAt: input.nextFireAt }),
      pending: false,
    });
    this.tasks.set(task.id, task);
    return task;
  }

  /** All active tasks, in creation order. */
  list(): ScheduledTask[] {
    return [...this.tasks.values()];
  }

  /** The task with `id`, or `undefined`. */
  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  /** Whether a task with `id` is registered. */
  has(id: string): boolean {
    return this.tasks.has(id);
  }

  /**
   * Remove a task. Returns whether it existed. Idempotent and safe after
   * disposal, so cleanup code can call it unconditionally.
   */
  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  /**
   * Apply a partial update and return the updated snapshot.
   *
   * The ID, mode, and creation time are immutable. Throws
   * {@link TaskNotFoundError} for an unknown ID and {@link RegistryDisposedError}
   * after disposal.
   */
  update(id: string, update: TaskUpdate): ScheduledTask {
    this.assertMutable();
    const current = this.tasks.get(id);
    if (!current) {
      throw new TaskNotFoundError(`no task with id ${id}`);
    }
    if (update.prompt !== undefined) {
      assertPrompt(update.prompt);
    }
    const nextFireAt =
      update.nextFireAt === undefined
        ? current.nextFireAt
        : update.nextFireAt === null
          ? undefined
          : update.nextFireAt;
    const schedule =
      update.schedule === undefined ? current.schedule : update.schedule === null ? undefined : update.schedule;
    const next: ScheduledTask = Object.freeze({
      id: current.id,
      prompt: update.prompt ?? current.prompt,
      mode: current.mode,
      createdAt: current.createdAt,
      pending: update.pending ?? current.pending,
      ...(schedule === undefined ? {} : { schedule }),
      ...(nextFireAt === undefined ? {} : { nextFireAt }),
    });
    this.tasks.set(id, next);
    return next;
  }

  /** Drop every task but keep the registry usable. */
  clear(): void {
    this.tasks.clear();
  }

  /**
   * Drop every task and permanently disable mutation. Idempotent; later
   * `create`/`update` calls throw. Reads stay safe and report an empty registry.
   */
  dispose(): void {
    this.disposed = true;
    this.tasks.clear();
  }

  private assertMutable(): void {
    if (this.disposed) {
      throw new RegistryDisposedError();
    }
  }

  private allocateId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId();
      if (typeof id !== "string" || id.length === 0) {
        throw new TaskRegistryError("createId must return a non-empty string");
      }
      if (!this.tasks.has(id)) {
        return id;
      }
    }
    throw new TaskRegistryError("could not allocate a unique task id");
  }
}
