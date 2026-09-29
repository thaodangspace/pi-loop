/**
 * Model-callable scheduler tools.
 *
 * These tools expose the session's existing scheduler and task registry to the
 * model without duplicating any scheduling logic: every mutation goes through
 * {@link LoopScheduler} (fixed creation, per-task cancellation, self-paced
 * wakeup reschedule/stop) and every read comes from the authoritative
 * {@link TaskRegistry}. `/loop` and the tools therefore share one registry, one
 * due queue, and one set of timers, so `/loop status`, `/loop stop`, and the
 * tools stay coherent.
 *
 * Contract notes (installed `@earendil-works/pi-coding-agent` 0.87.1):
 *
 * - `ToolDefinition` has no `annotations`/`readOnlyHint` field. Read-only vs
 *   mutating intent is expressed through the model-facing description prefix,
 *   `promptGuidelines`, and `executionMode: "sequential"` (the tools share
 *   mutable scheduler state).
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
import { formatInterval, parseInterval, type LoopScheduler } from "./loop-core.ts";
import {
  TaskNotFoundError,
  type ScheduledTask,
  type TaskMode,
  type TaskRegistry,
} from "./task-registry.ts";

/** Stable tool names, exported so tests and docs share one source of truth. */
export const SCHEDULER_TOOL_NAMES = {
  scheduleTask: "schedule_task",
  listTasks: "list_scheduled_tasks",
  deleteTask: "delete_scheduled_task",
  scheduleWakeup: "schedule_wakeup",
  stopWakeup: "stop_wakeup",
} as const;

/** A serializable view of one task, returned in tool results. */
export interface ScheduledTaskSummary {
  /** Stable ID; the handle accepted by `delete_scheduled_task`. */
  id: string;
  mode: TaskMode;
  prompt: string;
  /** True for a maintenance loop whose prompt is re-resolved on every run. */
  maintenance: boolean;
  /** Normalized cadence for fixed tasks. */
  intervalMs?: number;
  /** Absolute next fire time, when a schedule has been computed. */
  nextFireAt?: number;
  /** Absolute expiry, after which the task will not run again. */
  expiresAt?: number;
  /** True while a missed run is queued for the next idle moment. */
  pending: boolean;
  /** Self-paced only: the reason supplied with the latest wakeup. */
  reason?: string;
}

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
}

/** Project a registry snapshot into the fields the tools expose. */
export function summarizeTask(task: ScheduledTask): ScheduledTaskSummary {
  return {
    id: task.id,
    mode: task.mode,
    prompt: task.prompt,
    maintenance: task.maintenance === true,
    ...(task.schedule === undefined ? {} : { intervalMs: task.schedule.intervalMs }),
    ...(task.nextFireAt === undefined ? {} : { nextFireAt: task.nextFireAt }),
    ...(task.expiresAt === undefined ? {} : { expiresAt: task.expiresAt }),
    pending: task.pending,
    ...(task.reason === undefined ? {} : { reason: task.reason }),
  };
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

/**
 * Build the typed tool definitions. Kept separate from registration so tests
 * (and other hosts) can inspect the exact schema without a live Pi instance.
 */
export function createSchedulerTools(deps: SchedulerToolDeps): ToolDefinition<any, any, any>[] {
  const { scheduler, registry, now } = deps;

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
      return textResult(
        `Scheduled task ${summary.id} every ${formatInterval(summary.intervalMs ?? intervalMs)}` +
          (summary.expiresAt === undefined
            ? ""
            : `, expiring in ${formatInterval(summary.expiresAt - now())}`),
        { ok: true, task: summary } satisfies ScheduleTaskResult,
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
                  task.intervalMs === undefined ? task.mode : `every ${formatInterval(task.intervalMs)}`;
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
      "Mutating. Choose the next wakeup for the active self-paced loop, clamping the delay to 1 minute–1 hour through the scheduler's wakeup service. Throws when no self-paced loop is running, so it cannot reschedule a fixed task.",
    promptSnippet: "Choose the next wakeup for the active self-paced loop",
    promptGuidelines: [
      "schedule_wakeup only applies to the active self-paced loop and clamps the delay to [1min, 1h]; prefer stop_wakeup to end the loop.",
    ],
    parameters: ScheduleWakeupParams,
    executionMode: "sequential",
    async execute(_toolCallId, params): Promise<AgentToolResult<ScheduleWakeupResult>> {
      if (typeof params.delayMs !== "number") {
        throw new Error("delayMs must be a number of milliseconds");
      }
      const decision = scheduler.scheduleNextWakeup(params.delayMs, params.reason);
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
      "Mutating. Stop the active self-paced loop and cancel all of its future wakeups. Throws when no self-paced loop is running; fixed tasks and tool-created tasks are unaffected.",
    promptSnippet: "Stop the active self-paced loop and its wakeups",
    promptGuidelines: [
      "stop_wakeup is valid only for the active self-paced loop; it does not stop fixed scheduled tasks (use delete_scheduled_task).",
    ],
    parameters: StopWakeupParams,
    executionMode: "sequential",
    async execute(): Promise<AgentToolResult<StopWakeupResult>> {
      const status = scheduler.status();
      // The scheduler has no primary-only stop for a specific mode, so scope the
      // tool to the active self-paced loop explicitly. Self-paced loops are only
      // ever the command-owned primary task, so at most one exists.
      const active = registry.list().find((task) => task.mode === "self-paced");
      if (!status.active || status.mode !== "self-paced" || active === undefined) {
        throw new Error("no self-paced loop is running");
      }
      const stopped = scheduler.stop();
      if (!stopped) {
        throw new Error("no self-paced loop is running");
      }
      return textResult(
        `Stopped self-paced loop${active.prompt ? `: ${active.prompt}` : ""}`,
        { ok: true, id: active.id, prompt: active.prompt } satisfies StopWakeupResult,
      );
    },
  };

  return [scheduleTask, listTasks, deleteTask, scheduleWakeup, stopWakeup];
}

/** Register every scheduler tool on a Pi instance. */
export function registerSchedulerTools(pi: ExtensionAPI, deps: SchedulerToolDeps): void {
  for (const tool of createSchedulerTools(deps)) {
    pi.registerTool(tool);
  }
}
