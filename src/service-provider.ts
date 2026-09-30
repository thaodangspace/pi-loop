/**
 * Provider half of the extension-to-extension service boundary.
 *
 * This module owns session generations and answers discovery requests; it is
 * consumed by `pi-loop`'s own wiring (`src/index.ts`) and by tests. It is **not**
 * a package entrypoint: a consumer only needs `src/service.ts` (exposed as
 * `pi-loop/service`), which keeps the backend internals out of the public
 * surface. `LoopServiceBackend` and `createLoopServiceProvider` are deliberately
 * not re-exported from the package root.
 *
 * The provider holds no module-level state; every generation lives in the
 * closure returned by {@link createLoopServiceProvider}, so two extension
 * instances (two sessions, or two Pi processes) never share a service.
 */
import { randomUUID } from "node:crypto";
import { isCronSchedule } from "./cron.ts";
import type { TaskSchedule } from "./schedule.ts";
import {
  LOOP_SERVICE_CHANGED_CHANNEL,
  LOOP_SERVICE_DISCOVER_CHANNEL,
  LOOP_SERVICE_REPLY_CHANNEL_PREFIX,
  LOOP_SERVICE_VERSION,
  LoopServiceUnavailableError,
  type EventBusLike,
  type LoopCronOptions,
  type LoopScheduleOptions,
  type LoopSelfPacedOptions,
  type LoopServiceDiscoveryResponse,
  type LoopServiceStatus,
  type LoopServiceV1,
  type LoopServiceWakeupDecision,
  type LoopTaskMode,
  type LoopTaskSummary,
} from "./service.ts";

/** The structural task shape {@link summarizeTask} accepts. */
export interface LoopTaskLike {
  readonly id: string;
  readonly mode: LoopTaskMode;
  readonly prompt: string;
  readonly maintenance?: boolean;
  readonly schedule?: TaskSchedule;
  readonly nextFireAt?: number;
  readonly expiresAt?: number;
  readonly pending: boolean;
  readonly reason?: string;
}

/**
 * Project a scheduler/registry task into the public, frozen summary shape.
 *
 * The original task's fields are copied into a fresh object and frozen, so a
 * consumer cannot mutate registry state through the value it receives.
 */
export function summarizeTask(task: LoopTaskLike): LoopTaskSummary {
  const schedule = task.schedule;
  const summary: LoopTaskSummary = {
    id: task.id,
    mode: task.mode,
    prompt: task.prompt,
    maintenance: task.maintenance === true,
    ...(schedule === undefined
      ? {}
      : isCronSchedule(schedule)
        ? { cron: schedule.expression, timeZone: schedule.timeZone }
        : { intervalMs: schedule.intervalMs }),
    ...(task.nextFireAt === undefined ? {} : { nextFireAt: task.nextFireAt }),
    ...(task.expiresAt === undefined ? {} : { expiresAt: task.expiresAt }),
    pending: task.pending,
    ...(task.reason === undefined ? {} : { reason: task.reason }),
  };
  return Object.freeze(summary);
}

/** The provider-side operations the service delegates to, already session-scoped. */
export interface LoopServiceBackend {
  scheduleFixed(intervalMs: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  scheduleCron(expression: string, prompt: string, options?: LoopCronOptions): LoopTaskSummary;
  scheduleOnce(at: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  scheduleSelfPaced(prompt: string, options?: LoopSelfPacedOptions): LoopTaskSummary;
  listTasks(): LoopTaskSummary[];
  deleteTask(id: string): boolean;
  scheduleTaskWakeup(id: string, delayMs: number, reason?: string): LoopServiceWakeupDecision;
  stopTask(id: string): boolean;
}

export interface LoopServiceProviderOptions {
  /** Session-scoped operations the handle delegates to. */
  backend: LoopServiceBackend;
  /** Called after every successful mutation so the host can repaint its UI. */
  onChange?: () => void;
  /** Session-id generator (tests). Defaults to a random UUID. */
  createSessionId?: () => string;
}

/**
 * Owns the session generations and answers discovery requests. One provider per
 * extension instance; never a process-global singleton.
 */
export interface LoopServiceProvider {
  /**
   * Publish a new, live session generation and return its handle. Call this only
   * once the generation's scheduler state is fully reconstructed: every prior
   * handle becomes unavailable immediately.
   */
  beginSession(): LoopServiceV1;
  /**
   * Retire the active generation before a rebuild or on shutdown. Outstanding
   * handles fail closed immediately; no "available" status is published until the
   * next {@link beginSession}.
   */
  endSession(): void;
  /** Mark the service permanently unavailable (for example, disabled) with a reason. */
  setUnavailable(reason: string): void;
  /** The current handle, or undefined while unavailable. */
  current(): LoopServiceV1 | undefined;
  /** Whether a session is currently served. */
  isAvailable(): boolean;
  /** Subscribe to discovery requests on `events`; returns an unsubscribe fn. */
  register(events: EventBusLike): () => void;
  /** Broadcast the current availability on the registered bus. */
  notify(): void;
  /** Stop serving and release the discovery subscription. Idempotent. */
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Validate a discovery request payload and return its reply channel. */
function parseDiscoveryRequest(data: unknown): { replyChannel: string } | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const replyChannel = data.replyChannel;
  if (typeof replyChannel !== "string" || !replyChannel.startsWith(LOOP_SERVICE_REPLY_CHANNEL_PREFIX)) {
    return undefined;
  }
  return { replyChannel };
}

/**
 * Build the provider that owns session generations and replies to discovery.
 *
 * State is entirely closure-local. `beginSession`/`endSession`/`setUnavailable`
 * each advance the generation, so a handle captured before the change fails
 * closed rather than reading or mutating the new session's scheduler.
 */
export function createLoopServiceProvider(options: LoopServiceProviderOptions): LoopServiceProvider {
  const createSessionId = options.createSessionId ?? (() => randomUUID());
  let generation = 0;
  let sessionId: string | undefined;
  let unavailableReason: string | undefined;
  let disposed = false;
  let events: EventBusLike | undefined;
  let unsubscribeDiscovery: (() => void) | undefined;

  /** Reason the service is unavailable, or undefined when it is live. */
  const unavailable = (): string | undefined => {
    if (disposed) {
      return "the pi-loop service has been disposed";
    }
    if (sessionId === undefined) {
      return unavailableReason ?? "pi-loop has no active Pi session";
    }
    return undefined;
  };

  const createHandle = (boundGeneration: number, boundSessionId: string): LoopServiceV1 => {
    const assertActive = (): void => {
      if (disposed || generation !== boundGeneration || sessionId !== boundSessionId) {
        throw new LoopServiceUnavailableError();
      }
    };
    const mutate = <T>(fn: () => T): T => {
      assertActive();
      const result = fn();
      options.onChange?.();
      return result;
    };
    const handle: LoopServiceV1 = {
      version: LOOP_SERVICE_VERSION,
      sessionId: boundSessionId,
      isAvailable: (): boolean =>
        !disposed && generation === boundGeneration && sessionId === boundSessionId,
      scheduleFixed: (intervalMs, prompt, opts) =>
        mutate(() => options.backend.scheduleFixed(intervalMs, prompt, opts)),
      scheduleCron: (expression, prompt, opts) =>
        mutate(() => options.backend.scheduleCron(expression, prompt, opts)),
      scheduleOnce: (at, prompt, opts) => mutate(() => options.backend.scheduleOnce(at, prompt, opts)),
      scheduleSelfPaced: (prompt, opts) => mutate(() => options.backend.scheduleSelfPaced(prompt, opts)),
      listTasks: (): LoopTaskSummary[] => {
        assertActive();
        return Object.freeze(options.backend.listTasks().slice()) as LoopTaskSummary[];
      },
      deleteTask: (id) => mutate(() => options.backend.deleteTask(id)),
      scheduleTaskWakeup: (id, delayMs, reason) =>
        mutate(() => options.backend.scheduleTaskWakeup(id, delayMs, reason)),
      stopTask: (id) => mutate(() => options.backend.stopTask(id)),
    };
    return Object.freeze(handle);
  };

  const notify = (): void => {
    if (!events) {
      return;
    }
    const reason = unavailable();
    const status: LoopServiceStatus =
      reason === undefined
        ? { version: LOOP_SERVICE_VERSION, available: true, sessionId: sessionId! }
        : { version: LOOP_SERVICE_VERSION, available: false, reason };
    events.emit(LOOP_SERVICE_CHANGED_CHANNEL, status);
  };

  const handleDiscovery = (data: unknown): void => {
    const request = parseDiscoveryRequest(data);
    if (!request || !events) {
      return;
    }
    const reason = unavailable();
    if (reason === undefined) {
      events.emit(request.replyChannel, {
        version: LOOP_SERVICE_VERSION,
        available: true,
        sessionId: sessionId!,
        service: createHandle(generation, sessionId!),
      } satisfies LoopServiceDiscoveryResponse);
    } else {
      events.emit(request.replyChannel, {
        version: LOOP_SERVICE_VERSION,
        available: false,
        reason,
      } satisfies LoopServiceDiscoveryResponse);
    }
  };

  const beginSession = (): LoopServiceV1 => {
    if (disposed) {
      throw new LoopServiceUnavailableError("the pi-loop service has been disposed");
    }
    generation += 1;
    sessionId = createSessionId();
    unavailableReason = undefined;
    const handle = createHandle(generation, sessionId);
    notify();
    return handle;
  };

  const endSession = (): void => {
    if (sessionId === undefined) {
      return;
    }
    generation += 1;
    sessionId = undefined;
    unavailableReason = undefined;
    notify();
  };

  const setUnavailable = (reason: string): void => {
    generation += 1;
    sessionId = undefined;
    unavailableReason = reason;
    notify();
  };

  const register = (bus: EventBusLike): (() => void) => {
    const off = unsubscribeDiscovery;
    unsubscribeDiscovery = undefined;
    off?.();
    events = bus;
    const subscription = bus.on(LOOP_SERVICE_DISCOVER_CHANNEL, handleDiscovery);
    if (typeof subscription === "function") {
      unsubscribeDiscovery = subscription;
    }
    return () => {
      unsubscribeDiscovery?.();
      unsubscribeDiscovery = undefined;
    };
  };

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    generation += 1;
    sessionId = undefined;
    notify();
    unsubscribeDiscovery?.();
    unsubscribeDiscovery = undefined;
    events = undefined;
  };

  return {
    beginSession,
    endSession,
    setUnavailable,
    current: () => (unavailable() === undefined ? createHandle(generation, sessionId!) : undefined),
    isAvailable: () => unavailable() === undefined,
    register,
    notify,
    dispose,
  };
}
