/**
 * Model-callable scheduler tools.
 *
 * These tools expose the session's existing scheduler and task registry to the
 * model without duplicating any scheduling logic: every mutation goes through
 * {@link LoopScheduler} (fixed/cron/one-shot/self-paced creation, per-task
 * cancellation, self-paced wakeup reschedule/stop) and every read comes from the
 * authoritative
 * {@link TaskRegistry}. `/loop` and the tools therefore share one registry, one
 * due queue, and one set of timers, so `/loop status`, `/loop stop`, and the
 * tools stay coherent.
 *
 * Contract notes (the declared minimum `@earendil-works/pi-coding-agent`
 * 0.87.1; also verified against 0.99.1, whose optional `annotations` field is
 * deliberately unused so the same source typechecks on both):
 *
 * - The minimum `ToolDefinition` has no `annotations`/`readOnlyHint` field.
 *   Read-only vs mutating intent is expressed through the model-facing
 *   description prefix, `promptGuidelines`, and `executionMode: "sequential"`
 *   (the tools share mutable scheduler state).
 * - Pi's contract is "throw from `execute()` to produce a failed tool result"
 *   (`docs/extensions.md`). Unknown IDs, invalid intervals/prompts, the task
 *   limit, and wakeup misuse therefore throw typed errors; successful calls
 *   return `{ content, details }`.
 * - Tool names are deliberately distinct from the `/loop` slash command.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ScheduledPromptDecision } from "./dispatch.ts";
import { ScheduledPromptRejectedError } from "./dispatch.ts";
import {
  clampWakeupDelay,
  DEFAULT_WAKEUP_FALLBACK_MS,
  formatInterval,
  parseInterval,
  WakeupError,
  type LoopScheduler,
} from "./loop-core.ts";
import {
  TaskNotFoundError,
  type TaskMode,
  type TaskRegistry,
} from "./task-registry.ts";
import { summarizeTask } from "./service-provider.ts";
import type { LoopTaskSummary } from "./service.ts";

/** Stable tool names, exported so tests and docs share one source of truth. */
export const SCHEDULER_TOOL_NAMES = {
  scheduleTask: "schedule_task",
  scheduleCronTask: "schedule_cron_task",
  scheduleOnceTask: "schedule_once_task",
  scheduleSelfPaced: "schedule_self_paced_task",
  listTasks: "list_scheduled_tasks",
  deleteTask: "delete_scheduled_task",
  scheduleWakeup: "schedule_wakeup",
  stopWakeup: "stop_wakeup",
} as const;

/** A serializable view of one task, returned in tool results. */
export type ScheduledTaskSummary = LoopTaskSummary;

export interface ScheduleTaskResult {
  ok: true;
  task: ScheduledTaskSummary;
}

export interface ListTasksResult {
  ok: true;
  count: number;
  tasks: ScheduledTaskSummary[];
}

export interface DeleteTaskResult {
  ok: true;
  id: string;
  prompt: string;
  mode: TaskMode;
}

export interface ScheduleWakeupResult {
  ok: true;
  /** The delay the model asked for, before clamping. */
  requestedMs: number;
  /** The delay actually scheduled, always within 1 minute–1 hour. */
  delayMs: number;
  /** True when the scheduler clamped the requested delay. */
  clamped: boolean;
  nextFireAt: number;
  reason?: string;
}

export interface StopWakeupResult {
  ok: true;
  id: string;
  prompt: string;
}

/**
 * Injected scheduler state. The extension passes its own scheduler/registry so
 * the tools and `/loop` operate on the same session-scoped objects.
 */
export interface SchedulerToolDeps {
  scheduler: LoopScheduler;
  registry: TaskRegistry;
  /** Clock used to turn a relative expiry into an absolute time. */
  now: () => number;
  /**
   * Classify a candidate prompt exactly like `/loop` does. A rejected form
   * (extension command, interactive command, unknown skill) throws so the model
   * cannot schedule a task that could never be delivered.
   */
  classifyPrompt?: (prompt: string) => ScheduledPromptDecision;
  /**
   * Called after every successful mutation so the host can refresh its visible
   * state (for example the persistent status/widget). Never called for the
   * read-only `list_scheduled_tasks`.
   */
  onChange?: () => void;
}

/** A serializable view of one task created on a cron or one-shot schedule. */
export interface ScheduleOnceResult {
  ok: true;
  task: ScheduledTaskSummary;
}

/** The result of creating an independent self-paced task. */
export interface ScheduleSelfPacedResult {
  ok: true;
  task: ScheduledTaskSummary;
  /** Effective fallback wakeup delay after the 1min–1h clamp. */
  fallbackDelayMs: number;
  /** True when the requested `fallbackDelay` was clamped into range. */
  fallbackClamped: boolean;
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function requirePrompt(prompt: unknown): string {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
  return prompt;
}

/** An ISO-8601 timestamp with an explicit UTC offset (`Z` or `±hh:mm`). */
const ABSOLUTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Resolve a one-shot time from exactly one of `delay` (a relative interval) or
 * `at` (an absolute ISO-8601 timestamp). An absolute time must carry an explicit
 * offset so its meaning never depends on the host's local zone, and must be in
 * the future so the scheduled run is not silently dropped as already missed.
 */
function resolveOneShotTime(params: { delay?: string; at?: string }, now: number): number {
  const hasDelay = params.delay !== undefined;
  const hasAt = params.at !== undefined;
  if (hasDelay === hasAt) {
    throw new Error("give exactly one of delay or at");
  }
  if (params.delay !== undefined) {
    return now + parseInterval(params.delay);
  }
  const text = (params.at ?? "").trim();
  if (!ABSOLUTE_ISO.test(text)) {
    throw new Error(
      `at must be an ISO-8601 timestamp with an explicit offset or Z, got "${params.at}"`,
    );
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    throw new Error(`at is not a valid timestamp: "${params.at}"`);
  }
  if (parsed <= now) {
    throw new Error("at must be in the future");
  }
  return parsed;
}

/**
 * Build the typed tool definitions. Kept separate from registration so tests
 * (and other hosts) can inspect the exact schema without a live Pi instance.
 */
export function createSchedulerTools(deps: SchedulerToolDeps): ToolDefinition<any, any, any>[] {
  const { scheduler, registry, now } = deps;
  /** Refresh host-visible state after a successful mutation. */
  const changed = (): void => deps.onChange?.();

  const classify = (prompt: string): void => {
    const decision = deps.classifyPrompt?.(prompt);
    if (decision?.action === "reject") {
      throw new ScheduledPromptRejectedError(decision);
    }
  };

  const ScheduleTaskParams = Type.Object({
    interval: Type.String({
      description:
        "Fixed cadence as a positive number plus a unit: s, min, h, or d (for example \"30min\" or \"2h\"). The scheduler normalizes it to the nearest cron step, so values below 1min round up.",
    }),
    prompt: Type.String({
      description:
        "Prompt text delivered as a user message on every run. Plain text, a prompt template, or a known /skill: command.",
    }),
    expiresIn: Type.Optional(
      Type.String({
        description:
          "Optional lifetime as a number plus a unit (for example \"2d\"). The task is removed at creation time + this duration. Defaults to the scheduler's 7-day recurring-task lifetime; the value must outlast the first run.",
      }),
    ),
  });

  const ScheduleCronTaskParams = Type.Object({
    cron: Type.String({
      description:
        "Standard 5-field cron expression in local time: minute hour day-of-month month day-of-week. Each field accepts *, a value, a range (a-b), a step (*/n or a-b/n), a comma list, and 3-letter month/day names (for example \"0 9 * * 1-5\"). If both day fields are restricted, a day matches when either does.",
    }),
    prompt: Type.String({
      description:
        "Prompt text delivered as a user message on every run. Plain text, a prompt template, or a known /skill: command.",
    }),
    timeZone: Type.Optional(
      Type.String({
        description:
          "IANA timezone the expression is interpreted in (for example \"America/New_York\"). Defaults to the session's local zone.",
      }),
    ),
    expiresIn: Type.Optional(
      Type.String({
        description:
          "Optional lifetime as a number plus a unit (for example \"30d\"). The task is removed at creation time + this duration. Defaults to the scheduler's 7-day recurring-task lifetime, so pass a longer value for a weekly or rarer schedule.",
      }),
    ),
  });

  const ScheduleOnceTaskParams = Type.Object({
    prompt: Type.String({
      description:
        "Prompt text delivered once as a user message. Plain text, a prompt template, or a known /skill: command.",
    }),
    delay: Type.Optional(
      Type.String({
        description:
          "Run once after this delay, as a positive number plus a unit: s, min, h, or d (for example \"30min\"). Exactly one of delay or at must be given.",
      }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "Run once at this absolute ISO-8601 timestamp with an explicit offset or Z (for example \"2026-10-01T09:00:00-04:00\"). Exactly one of at or delay must be given, and the time must be in the future.",
      }),
    ),
  });

  const ScheduleSelfPacedParams = Type.Object({
    prompt: Type.String({
      description:
        "Prompt text delivered as a user message on every run. Plain text, a prompt template, or a known /skill: command.",
    }),
    fallbackDelay: Type.Optional(
      Type.String({
        description:
          "Optional fallback wakeup delay as a positive number plus a unit (for example \"5min\"). Used once if an iteration neither reschedules nor stops. Clamped into 1 minute–1 hour like the /loop fallback; defaults to 1min.",
      }),
    ),
  });

  const ListTasksParams = Type.Object({});

  const DeleteTaskParams = Type.Object({
    id: Type.String({
      description: "Stable task ID exactly as returned by schedule_task or list_scheduled_tasks.",
    }),
  });

  const ScheduleWakeupParams = Type.Object({
    delayMs: Type.Number({
      description:
        "Delay in milliseconds until the next wakeup. The scheduler clamps it into [1 minute, 1 hour].",
    }),
    reason: Type.Optional(
      Type.String({ description: "Optional short reason for the chosen delay, shown in status." }),
    ),
  });

  const StopWakeupParams = Type.Object({});

  const scheduleTask: ToolDefinition<typeof ScheduleTaskParams, ScheduleTaskResult> = {
    name: SCHEDULER_TOOL_NAMES.scheduleTask,
    label: "Schedule Task",
    description:
      "Mutating. Create a recurring scheduled task that delivers a prompt in this session on a fixed cadence. Independent of the /loop command loop; persisted across reloads. Returns the stable task ID. Throws for an invalid interval or prompt.",
    promptSnippet: "Create a recurring scheduled prompt task in this session",
    promptGuidelines: [
      "schedule_task creates a fixed recurring task alongside any /loop command loop; it does not replace the loop. Use list_scheduled_tasks to see IDs and delete_scheduled_task to cancel one.",
    ],
    parameters: ScheduleTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleTaskResult>> {
      const prompt = requirePrompt(params.prompt);
      classify(prompt);
      const intervalMs = parseInterval(params.interval);
      const expiresAt =
        params.expiresIn === undefined ? undefined : now() + parseInterval(params.expiresIn);
      const task = scheduler.scheduleFixed(intervalMs, prompt, {
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      // A long interval with a shorter expiry never reaches a first boundary: the
      // scheduler creates then immediately removes the task. Report that instead
      // of returning an ID that is no longer live.
      if (!registry.has(task.id)) {
        throw new Error(
          `task would expire before its first run; shorten the interval or increase expiresIn`,
        );
      }
      const summary = summarizeTask(registry.get(task.id) ?? task);
      changed();
      return textResult(
        `Scheduled task ${summary.id} every ${formatInterval(summary.intervalMs ?? intervalMs)}` +
          (summary.expiresAt === undefined
            ? ""
            : `, expiring in ${formatInterval(summary.expiresAt - now())}`),
        { ok: true, task: summary } satisfies ScheduleTaskResult,
      );
    },
  };

  const scheduleCronTask: ToolDefinition<typeof ScheduleCronTaskParams, ScheduleTaskResult> = {
    name: SCHEDULER_TOOL_NAMES.scheduleCronTask,
    label: "Schedule Cron Task",
    description:
      "Mutating. Create a recurring task from a standard 5-field local-time cron expression (minute hour day-of-month month day-of-week). Independent of the /loop command loop; persisted across reloads. Returns the stable task ID. Throws a field-specific error for an invalid schedule.",
    promptSnippet: "Create a recurring task from a 5-field local-time cron expression",
    promptGuidelines: [
      "schedule_cron_task interprets the expression in timeZone (default: the session's local zone). Use list_scheduled_tasks and delete_scheduled_task to inspect and cancel it.",
    ],
    parameters: ScheduleCronTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleTaskResult>> {
      const prompt = requirePrompt(params.prompt);
      classify(prompt);
      const expiresAt =
        params.expiresIn === undefined ? undefined : now() + parseInterval(params.expiresIn);
      const task = scheduler.scheduleCron(params.cron, prompt, {
        ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
      // A cron occurrence beyond the expiry never runs; report that instead of
      // returning an ID that is no longer live.
      if (!registry.has(task.id)) {
        throw new Error("task would expire before its first run; increase expiresIn");
      }
      const summary = summarizeTask(registry.get(task.id) ?? task);
      changed();
      const expiry =
        summary.expiresAt === undefined
          ? ""
          : `, expiring in ${formatInterval(summary.expiresAt - now())}`;
      return textResult(
        `Scheduled task ${summary.id} on cron "${summary.cron}" (${summary.timeZone})${expiry}`,
        { ok: true, task: summary } satisfies ScheduleTaskResult,
      );
    },
  };

  const scheduleOnceTask: ToolDefinition<typeof ScheduleOnceTaskParams, ScheduleOnceResult> = {
    name: SCHEDULER_TOOL_NAMES.scheduleOnceTask,
    label: "Schedule One-Shot Task",
    description:
      "Mutating. Create a task that fires once and then removes itself. Give exactly one of delay (relative) or at (an absolute ISO-8601 timestamp with an explicit offset). Persisted across reloads, but a run missed while unmounted is dropped, never replayed. Returns the stable task ID.",
    promptSnippet: "Create a task that runs once and then removes itself",
    promptGuidelines: [
      "schedule_once_task runs alongside the /loop command loop; it does not replace it. A missed one-shot is discarded after resume rather than replayed.",
    ],
    parameters: ScheduleOnceTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleOnceResult>> {
      const prompt = requirePrompt(params.prompt);
      classify(prompt);
      const at = resolveOneShotTime(params, now());
      const task = scheduler.scheduleOnce(at, prompt);
      const summary = summarizeTask(registry.get(task.id) ?? task);
      changed();
      return textResult(
        `Scheduled one-shot task ${summary.id} at ${new Date(at).toISOString()}: ${summary.prompt}`,
        { ok: true, task: summary } satisfies ScheduleOnceResult,
      );
    },
  };

  const scheduleSelfPacedTask: ToolDefinition<
    typeof ScheduleSelfPacedParams,
    ScheduleSelfPacedResult
  > = {
    name: SCHEDULER_TOOL_NAMES.scheduleSelfPaced,
    label: "Schedule Self-Paced Task",
    description:
      "Mutating. Create an independent self-paced task: its first run is due immediately, and each iteration chooses its own next wakeup with schedule_wakeup or ends itself with stop_wakeup. Never replaces the /loop command loop or another self-paced task; not persisted across reloads. Returns the stable task ID. Throws for an invalid prompt or fallbackDelay.",
    promptSnippet: "Create an independent self-paced task whose first run is due now",
    promptGuidelines: [
      "schedule_self_paced_task runs alongside the /loop command loop and other self-paced tasks; it never replaces them. Use list_scheduled_tasks to see IDs and delete_scheduled_task to cancel one.",
      "Reschedule the self-paced iteration that is currently executing with schedule_wakeup, or end it with stop_wakeup; those tools are iteration-scoped and fail outside a running iteration.",
    ],
    parameters: ScheduleSelfPacedParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleSelfPacedResult>> {
      const prompt = requirePrompt(params.prompt);
      classify(prompt);
      // Same validation (parseInterval) and clamp (scheduleSelfPaced, echoed
      // here for the result) as the command-owned self-paced loop.
      const requestedFallbackMs =
        params.fallbackDelay === undefined ? undefined : parseInterval(params.fallbackDelay);
      const task = scheduler.scheduleSelfPaced(
        prompt,
        requestedFallbackMs === undefined ? {} : { fallbackDelayMs: requestedFallbackMs },
      );
      const summary = summarizeTask(registry.get(task.id) ?? task);
      const fallbackDelayMs = clampWakeupDelay(requestedFallbackMs ?? DEFAULT_WAKEUP_FALLBACK_MS);
      changed();
      return textResult(
        `Scheduled self-paced task ${summary.id}; first run is due immediately` +
          `, fallback wakeup in ${formatInterval(fallbackDelayMs)} if no next wakeup is chosen`,
        {
          ok: true,
          task: summary,
          fallbackDelayMs,
          fallbackClamped: requestedFallbackMs !== undefined && fallbackDelayMs !== requestedFallbackMs,
        } satisfies ScheduleSelfPacedResult,
      );
    },
  };

  const listTasks: ToolDefinition<typeof ListTasksParams, ListTasksResult> = {
    name: SCHEDULER_TOOL_NAMES.listTasks,
    label: "List Scheduled Tasks",
    description:
      "Read-only. List every active scheduled task in this session with its stable ID, mode, next fire time, expiry, and queued/pending status. Includes the /loop command loop and tasks created by schedule_task.",
    promptSnippet: "List active scheduled tasks and their IDs",
    promptGuidelines: [
      "list_scheduled_tasks is read-only and never changes scheduling or timers.",
    ],
    parameters: ListTasksParams,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<ListTasksResult>> {
      const tasks = registry.list().map(summarizeTask);
      const text =
        tasks.length === 0
          ? "No scheduled tasks."
          : tasks
              .map((task) => {
                const cadence =
                  task.cron !== undefined
                    ? `cron "${task.cron}" (${task.timeZone})`
                    : task.intervalMs === undefined
                      ? task.mode
                      : `every ${formatInterval(task.intervalMs)}`;
                const pending = task.pending ? ", pending" : "";
                const expiry = task.expiresAt === undefined ? "" : `, expiresAt ${task.expiresAt}`;
                return `${task.id} [${task.mode}] ${cadence}${pending}${expiry}: ${task.prompt}`;
              })
              .join("\n");
      return textResult(text, { ok: true, count: tasks.length, tasks } satisfies ListTasksResult);
    },
  };

  const deleteTask: ToolDefinition<typeof DeleteTaskParams, DeleteTaskResult> = {
    name: SCHEDULER_TOOL_NAMES.deleteTask,
    label: "Delete Scheduled Task",
    description:
      "Mutating. Delete one scheduled task by its stable ID, cancelling its timer and any queued run. Throws a not-found error when the ID is unknown; never affects another task.",
    promptSnippet: "Delete a scheduled task by ID and cancel its queued run",
    promptGuidelines: [
      "delete_scheduled_task matches the ID exactly and is a no-op on other tasks; an unknown ID is reported as an error.",
    ],
    parameters: DeleteTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<DeleteTaskResult>> {
      const task = registry.get(params.id);
      if (!task) {
        throw new TaskNotFoundError(`no scheduled task with id "${params.id}"`);
      }
      scheduler.stopTask(params.id);
      // Defensive: stopTask removes a tracked task from the registry. If the
      // registry held an untracked record, drop it so delete always converges.
      if (registry.has(params.id)) {
        registry.delete(params.id);
      }
      changed();
      return textResult(`Deleted scheduled task ${task.id}${task.prompt ? `: ${task.prompt}` : ""}`, {
        ok: true,
        id: task.id,
        prompt: task.prompt,
        mode: task.mode,
      } satisfies DeleteTaskResult);
    },
  };

  const scheduleWakeup: ToolDefinition<typeof ScheduleWakeupParams, ScheduleWakeupResult> = {
    name: SCHEDULER_TOOL_NAMES.scheduleWakeup,
    label: "Schedule Wakeup",
    description:
      "Mutating. Choose the next wakeup for the self-paced iteration that is currently executing, clamping the delay to 1 minute–1 hour through the scheduler's wakeup service. Throws when no self-paced iteration is executing, so it can never reschedule the command-owned loop, a fixed task, or another self-paced task.",
    promptSnippet: "Choose the next wakeup for the self-paced iteration that is running",
    promptGuidelines: [
      "schedule_wakeup only applies to the self-paced iteration that invoked it and clamps the delay to [1min, 1h]; it fails closed outside an executing iteration. Prefer stop_wakeup to end the iteration.",
    ],
    parameters: ScheduleWakeupParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleWakeupResult>> {
      if (typeof params.delayMs !== "number") {
        throw new Error("delayMs must be a number of milliseconds");
      }
      // Bind to the iteration that is actually executing. This deliberately does
      // not use `activeSelfPacedTask`, which also resolves the command-owned loop
      // outside a run; a call made outside an iteration must fail closed.
      if (scheduler.executingSelfPacedTask() === undefined) {
        throw new WakeupError(
          "no self-paced loop is running: schedule_wakeup only applies to the self-paced iteration that is currently executing",
        );
      }
      const decision = scheduler.scheduleNextWakeup(params.delayMs, params.reason);
      changed();
      const text = decision.clamped
        ? `Next wakeup in ${formatInterval(decision.delayMs)} (clamped from ${formatInterval(decision.requestedMs)})`
        : `Next wakeup in ${formatInterval(decision.delayMs)}`;
      return textResult(
        decision.reason === undefined ? text : `${text}: ${decision.reason}`,
        {
          ok: true,
          requestedMs: decision.requestedMs,
          delayMs: decision.delayMs,
          clamped: decision.clamped,
          nextFireAt: decision.nextFireAt,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        } satisfies ScheduleWakeupResult,
      );
    },
  };

  const stopWakeup: ToolDefinition<typeof StopWakeupParams, StopWakeupResult> = {
    name: SCHEDULER_TOOL_NAMES.stopWakeup,
    label: "Stop Self-Paced Loop",
    description:
      "Mutating. Stop the self-paced iteration that is currently executing and cancel all of its future wakeups. Throws when no self-paced iteration is executing, so it never stops the command-owned loop, a fixed task, or another self-paced task.",
    promptSnippet: "Stop the self-paced iteration that is running and its wakeups",
    promptGuidelines: [
      "stop_wakeup is valid only for the self-paced iteration that invoked it; it does not stop fixed scheduled tasks or other self-paced tasks (use delete_scheduled_task for those).",
    ],
    parameters: StopWakeupParams,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<StopWakeupResult>> {
      // Scope the tool to the self-paced iteration that is executing now. Unlike
      // `activeSelfPacedTask`, this never falls back to the command-owned loop, so
      // a stop outside an iteration (including one where only the command-owned
      // self-paced loop exists) fails closed instead of cancelling the primary.
      const executing = scheduler.executingSelfPacedTask();
      if (executing === undefined) {
        throw new WakeupError(
          "no self-paced loop is running: stop_wakeup only applies to the self-paced iteration that is currently executing",
        );
      }
      const stopped = scheduler.stop();
      if (!stopped) {
        throw new WakeupError(
          "no self-paced loop is running: stop_wakeup only applies to the self-paced iteration that is currently executing",
        );
      }
      changed();
      return textResult(
        `Stopped self-paced loop${executing.prompt ? `: ${executing.prompt}` : ""}`,
        { ok: true, id: executing.id, prompt: executing.prompt } satisfies StopWakeupResult,
      );
    },
  };

  return [
    scheduleTask,
    scheduleCronTask,
    scheduleOnceTask,
    scheduleSelfPacedTask,
    listTasks,
    deleteTask,
    scheduleWakeup,
    stopWakeup,
  ];
}

/** Register every scheduler tool on a Pi instance. */
export function registerSchedulerTools(pi: ExtensionAPI, deps: SchedulerToolDeps): void {
  for (const tool of createSchedulerTools(deps)) {
    pi.registerTool(tool);
  }
}
