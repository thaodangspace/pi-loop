/**
 * Public, versioned service boundary for sibling Pi extensions.
 *
 * `pi-workflow` (or any trusted same-process extension) can depend on `pi-loop`
 * as its scheduler without importing private modules, constructing a second
 * scheduler, or reaching into the task registry. A consumer discovers the
 * service for the *current* Pi session over Pi's documented extension event bus
 * (`pi.events`), then calls the versioned {@link LoopServiceV1} contract.
 *
 * Everything mutable stays owned by `pi-loop`: the registry, due queue, timers,
 * persistence, dispatch, and lifecycle. This module is the consumer-facing half
 * of the boundary: the contract, frozen summaries, the documented errors, and
 * the discovery protocol. The provider that *implements* the contract lives in
 * the internal `service-provider.ts` and is not a package entrypoint.
 *
 * Lifetime: a discovered handle is bound to a *session generation*. Starting or
 * reconstructing a session invalidates the previous generation, so an old handle
 * stops working (and reports itself unavailable) instead of silently operating on
 * the next session's state. There is no process-global singleton; discovery is
 * scoped to the event bus the provider registered on.
 *
 * This module is Pi-independent: it imports only `node:crypto`, so the contract
 * and the discovery protocol are unit testable without a Pi runtime.
 */
import { randomUUID } from "node:crypto";

/**
 * The service contract version. A future incompatible change ships as a new
 * version (V2) alongside, so a consumer can require exactly the version it was
 * written for. `LOOP_SERVICE_DISCOVER_CHANNEL` is versioned for the same reason.
 */
export const LOOP_SERVICE_VERSION = 1 as const;
export type LoopServiceVersion = typeof LOOP_SERVICE_VERSION;

/** Event-bus channel a consumer emits a discovery request on. */
export const LOOP_SERVICE_DISCOVER_CHANNEL = "pi-loop:service:discover:v1";

/**
 * Prefix of the per-request reply channel. A request carries its own reply
 * channel so a consumer can scope the answer to its own request and never
 * observe another consumer's reply.
 */
export const LOOP_SERVICE_REPLY_CHANNEL_PREFIX = "pi-loop:service:reply:v1:";

/** Event-bus channel a provider emits availability changes on. */
export const LOOP_SERVICE_CHANGED_CHANNEL = "pi-loop:service:changed:v1";

/** Default time `discoverLoopService` waits for a reply, in milliseconds. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;

/**
 * The subset of `pi.events` the protocol needs. Declared here so this module does
 * not import the Pi runtime and so a consumer can pass `pi.events` directly.
 *
 * `on` returns an unsubscribe function on current Pi; older lines may return
 * `void`, so the return type is a union and callers handle both.
 */
export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
}

/** How a scheduled task decides when to run. Mirrors the registry's task modes. */
export type LoopTaskMode = "fixed" | "self-paced" | "one-shot";

/**
 * A frozen, serializable view of one scheduled task. Every field is a primitive,
 * so a summary can be persisted, logged, or structured-cloned by the consumer
 * without exposing registry internals.
 */
export interface LoopTaskSummary {
  /** Stable ID; the handle accepted by {@link LoopServiceV1.deleteTask}. */
  readonly id: string;
  readonly mode: LoopTaskMode;
  readonly prompt: string;
  /** True for a maintenance loop whose prompt is re-resolved on every run. */
  readonly maintenance: boolean;
  /** Normalized cadence for interval-scheduled fixed tasks. */
  readonly intervalMs?: number;
  /** 5-field cron expression for calendar-scheduled fixed tasks. */
  readonly cron?: string;
  /** IANA timezone a cron expression is interpreted in. */
  readonly timeZone?: string;
  /** Absolute next fire time, when a schedule has been computed. */
  readonly nextFireAt?: number;
  /** Absolute expiry, after which the task will not run again. */
  readonly expiresAt?: number;
  /** True while a missed run is queued for the next idle moment. */
  readonly pending: boolean;
  /** Self-paced only: the reason supplied with the latest wakeup. */
  readonly reason?: string;
}

/** Options for a fixed or one-shot task. */
export interface LoopScheduleOptions {
  /**
   * Optional absolute expiry. Recurring fixed tasks default to seven days from
   * creation; one-shot and self-paced tasks have no default. A value that lands
   * before the first run is rejected, and a self-paced wakeup that would land
   * after it is rejected and terminates the task.
   */
  readonly expiresAt?: number;
}

/** Options for a recurring cron task. */
export interface LoopCronOptions extends LoopScheduleOptions {
  /** IANA timezone the expression is interpreted in. Default: the process zone. */
  readonly timeZone?: string;
}

/** Options for an independent self-paced task. */
export interface LoopSelfPacedOptions extends LoopScheduleOptions {
  /**
   * Delay used for the single bounded fallback wakeup when an iteration neither
   * reschedules nor stops. Clamped into [1 minute, 1 hour].
   */
  readonly fallbackDelayMs?: number;
}

/** The normalized outcome of an explicit task wakeup. */
export interface LoopServiceWakeupDecision {
  /** The delay the caller asked for, before clamping. */
  readonly requestedMs: number;
  /** The delay actually scheduled, always within [1 minute, 1 hour]. */
  readonly delayMs: number;
  /** True when clamping changed the requested delay. */
  readonly clamped: boolean;
  /** Absolute time the wakeup is due. */
  readonly nextFireAt: number;
  /** Optional reason supplied with the wakeup. */
  readonly reason?: string;
}

/**
 * The versioned service contract. Obtained through {@link discoverLoopService};
 * never constructed by a consumer.
 *
 * Every method that reads or mutates checks that the handle still belongs to the
 * active session generation and throws {@link LoopServiceUnavailableError} once
 * the session has shut down or been reconstructed. Reads never expose mutable
 * registry state; mutations go through the same authoritative scheduler and
 * registry as `/loop` and the model-callable tools.
 */
export interface LoopServiceV1 {
  readonly version: LoopServiceVersion;
  /** Opaque id of the session this handle is bound to. */
  readonly sessionId: string;
  /** Cheap check: false once the bound session generation is no longer active. */
  isAvailable(): boolean;
  /** Create a recurring fixed-interval task. */
  scheduleFixed(intervalMs: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  /** Create a recurring 5-field cron task. */
  scheduleCron(expression: string, prompt: string, options?: LoopCronOptions): LoopTaskSummary;
  /** Create a task that runs once at `at` (absolute epoch milliseconds). */
  scheduleOnce(at: number, prompt: string, options?: LoopScheduleOptions): LoopTaskSummary;
  /** Create an independent self-paced task whose first run is due immediately. */
  scheduleSelfPaced(prompt: string, options?: LoopSelfPacedOptions): LoopTaskSummary;
  /** Snapshot every active task, including the command-owned `/loop` task. */
  listTasks(): LoopTaskSummary[];
  /** Remove a task by ID. Returns false when the ID is unknown. */
  deleteTask(id: string): boolean;
  /**
   * Explicitly reschedule a self-paced task by ID (trusted code only; the model
   * tools remain bound to the executing iteration). The delay is clamped to
   * [1 minute, 1 hour]. Throws when the ID is unknown or is not self-paced.
   */
  scheduleTaskWakeup(id: string, delayMs: number, reason?: string): LoopServiceWakeupDecision;
  /** Cancel a task by ID and any queued run. Returns false when unknown. */
  stopTask(id: string): boolean;
}

/** Thrown when a handle's session generation is no longer active. */
export class LoopServiceUnavailableError extends Error {
  readonly code = "loop-service-unavailable";
  constructor(message = "the pi-loop service for this session is no longer available") {
    super(message);
    this.name = "LoopServiceUnavailableError";
  }
}

/** Thrown for a scheduling input the service rejects (for example, dead expiry). */
export class LoopServiceInputError extends Error {
  readonly code = "loop-service-input";
  constructor(message: string) {
    super(message);
    this.name = "LoopServiceInputError";
  }
}

/** Availability broadcast emitted on {@link LOOP_SERVICE_CHANGED_CHANNEL}. */
export type LoopServiceStatus =
  | { readonly version: LoopServiceVersion; readonly available: true; readonly sessionId: string }
  | { readonly version: LoopServiceVersion; readonly available: false; readonly reason: string };

/** The reply a provider emits for one discovery request. */
export type LoopServiceDiscoveryResponse =
  | {
      readonly version: LoopServiceVersion;
      readonly available: true;
      readonly sessionId: string;
      readonly service: LoopServiceV1;
    }
  | { readonly version: LoopServiceVersion; readonly available: false; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validate an availability/discovery payload into a typed status, or undefined.
 * Shared with the provider so both directions of the protocol agree.
 */
function parseStatus(data: unknown): LoopServiceStatus | undefined {
  if (!isRecord(data) || data.version !== LOOP_SERVICE_VERSION || typeof data.available !== "boolean") {
    return undefined;
  }
  if (data.available === false) {
    return typeof data.reason === "string"
      ? { version: LOOP_SERVICE_VERSION, available: false, reason: data.reason }
      : undefined;
  }
  return typeof data.sessionId === "string"
    ? { version: LOOP_SERVICE_VERSION, available: true, sessionId: data.sessionId }
    : undefined;
}

/**
 * Structural check that `value` is a usable version-1 service handle. Used by the
 * discovery helper so a malformed reply is reported as such instead of handed to
 * the consumer.
 */
export function isLoopServiceV1(value: unknown): value is LoopServiceV1 {
  if (!isRecord(value) || value.version !== LOOP_SERVICE_VERSION || typeof value.sessionId !== "string") {
    return false;
  }
  return (
    typeof value.isAvailable === "function" &&
    typeof value.scheduleFixed === "function" &&
    typeof value.scheduleCron === "function" &&
    typeof value.scheduleOnce === "function" &&
    typeof value.scheduleSelfPaced === "function" &&
    typeof value.listTasks === "function" &&
    typeof value.deleteTask === "function" &&
    typeof value.scheduleTaskWakeup === "function" &&
    typeof value.stopTask === "function"
  );
}

function parseDiscoveryResponse(data: unknown): LoopServiceDiscoveryResponse | undefined {
  const status = parseStatus(data);
  if (status === undefined) {
    return undefined;
  }
  if (!status.available) {
    return { version: LOOP_SERVICE_VERSION, available: false, reason: status.reason };
  }
  const service = isRecord(data) ? data.service : undefined;
  if (!isLoopServiceV1(service)) {
    return undefined;
  }
  return { version: LOOP_SERVICE_VERSION, available: true, sessionId: status.sessionId, service };
}

/** The failure modes of {@link discoverLoopService}. */
export type LoopServiceDiscoveryFailure = "unavailable" | "timeout" | "invalid-response";

/** Result of {@link discoverLoopService}. */
export type LoopServiceDiscovery =
  | { readonly ok: true; readonly service: LoopServiceV1 }
  | {
      readonly ok: false;
      readonly reason: LoopServiceDiscoveryFailure;
      readonly message: string;
    };

export interface DiscoverLoopServiceOptions {
  /** How long to wait for a reply. Defaults to {@link DEFAULT_DISCOVERY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Request-id generator (tests). Defaults to a random UUID. */
  requestId?: () => string;
}

/**
 * Obtain the active `pi-loop` service for this session over `pi.events`.
 *
 * Resolves to `{ ok: false, reason: "unavailable" }` when a provider answers but
 * has no live session (for example, disabled, outside a session, or mid
 * reconstruction), and to `{ ok: false, reason: "timeout" }` when no provider is
 * loaded yet. Callers that load before `pi-loop` should retry, or watch
 * {@link LOOP_SERVICE_CHANGED_CHANNEL} with {@link onLoopServiceChange}. The
 * returned handle is bound to the session generation it was discovered in.
 */
export function discoverLoopService(
  events: EventBusLike,
  options: DiscoverLoopServiceOptions = {},
): Promise<LoopServiceDiscovery> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const requestId = (options.requestId ?? (() => randomUUID()))();
  const replyChannel = `${LOOP_SERVICE_REPLY_CHANNEL_PREFIX}${requestId}`;

  return new Promise<LoopServiceDiscovery>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (result: LoopServiceDiscovery): void => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const subscription = events.on(replyChannel, (data) => {
      const response = parseDiscoveryResponse(data);
      if (response === undefined) {
        finish({
          ok: false,
          reason: "invalid-response",
          message: "pi-loop replied with an unrecognized discovery response",
        });
        return;
      }
      if (!response.available) {
        finish({ ok: false, reason: "unavailable", message: response.reason });
        return;
      }
      finish({ ok: true, service: response.service });
    });
    if (typeof subscription === "function") {
      unsubscribe = subscription;
    }

    events.emit(LOOP_SERVICE_DISCOVER_CHANNEL, {
      version: LOOP_SERVICE_VERSION,
      requestId,
      replyChannel,
    });

    if (!settled) {
      timer = setTimeout(() => {
        finish({
          ok: false,
          reason: "timeout",
          message: `no pi-loop service replied within ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }
  });
}

/**
 * Observe service availability changes (loaded, session started/reconstructed,
 * session ended, disabled). Useful when a consumer loads before `pi-loop`.
 *
 * A provider publishes `available: true` only after the new session's state has
 * been reconstructed, so a synchronous handler can safely discover and read the
 * service when it sees it become available.
 */
export function onLoopServiceChange(
  events: EventBusLike,
  handler: (status: LoopServiceStatus) => void,
): () => void {
  const subscription = events.on(LOOP_SERVICE_CHANGED_CHANNEL, (data) => {
    const status = parseStatus(data);
    if (status !== undefined) {
      handler(status);
    }
  });
  return typeof subscription === "function" ? subscription : () => {};
}
