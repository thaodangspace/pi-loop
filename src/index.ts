/**
 * Pi wiring for the loop extension.
 *
 * `/loop` repeats a task as a user message in the current session. All parsing,
 * scheduling, and config logic lives in the Pi-independent modules so this file
 * only adapts Pi commands, idle signals, and lifecycle events.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  isLoopDisabled,
  loadDefaultInterval,
  loopConfigPath,
  LOOP_DISABLE_ENV,
  type ConfigReader,
} from "./config.ts";
import {
  createScheduledPromptDispatcher,
  ScheduledPromptRejectedError,
} from "./dispatch.ts";
import {
  clampWakeupDelay,
  formatInterval,
  LoopScheduler,
  parseLoopCommand,
  systemTimers,
  usageText,
  type SchedulerDeps,
} from "./loop-core.ts";
import {
  BUILT_IN_MAINTENANCE_PROMPT,
  MaintenancePromptError,
  resolveMaintenancePrompt,
  type ResolveMaintenanceOptions,
} from "./maintenance.ts";
import { collectEntries, PERSISTENCE_CUSTOM_TYPE, planRestore } from "./persistence.ts";
import { jitterOffsetMs } from "./schedule.ts";
import { formatStatusLine, formatTaskLines } from "./status.ts";
import { TaskRegistry, type ScheduledTask } from "./task-registry.ts";
import { registerSchedulerTools } from "./tools.ts";

export interface LoopExtensionDeps {
  /** Override the `loop.json` path (tests or an explicit deploy). */
  configPath?: string;
  /** Override the config file reader (tests). */
  readFile?: ConfigReader;
  /** Override timer primitives (tests). */
  timers?: SchedulerDeps;
  /** Override the per-session task registry (tests, or an explicit session). */
  registry?: TaskRegistry;
  /** Override maintenance prompt resolution: project/user paths and reader (tests). */
  maintenance?: ResolveMaintenanceOptions;
  /**
   * Explicit disable switch (tests, or an embedding host). When omitted, the
   * {@link LOOP_DISABLE_ENV} environment variable decides. A disabled extension
   * registers no scheduling tools, restores no tasks, and starts no timers.
   */
  disabled?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Register the `/loop` command and its lifecycle hooks on a Pi instance.
 *
 * Exported separately from the default factory so tests can inject timers,
 * config reads, and a fake Pi API.
 */
export function createLoopExtension(pi: ExtensionAPI, deps: LoopExtensionDeps = {}): void {
  // Explicit dependency beats the environment; see LOOP_DISABLE_ENV. Resolved
  // synchronously at load time so a disabled process never registers tools or
  // arms a timer.
  const disabled = deps.disabled ?? isLoopDisabled();
  const baseTimers = deps.timers ?? systemTimers;
  const configPath = deps.configPath ?? loopConfigPath();

  // Latest context is only used for notifications, the persistent status/widget,
  // and the authoritative idle check; it is dropped on session shutdown so a
  // replaced session's context is never reused.
  let latestCtx: ExtensionContext | undefined;
  /** Set below; invoked after each scheduler timer callback repaints the UI. */
  let afterTimerFire: (() => void) | undefined;

  // Wrap the injected timer primitives so every scheduler tick (a due boundary,
  // a self-paced wakeup, or an expiry) refreshes the visible status. Time and
  // jitter still come from the underlying primitives, so test clocks are exact.
  const timers: SchedulerDeps = {
    now: () => baseTimers.now(),
    setTimer: (fn, ms) =>
      baseTimers.setTimer(() => {
        try {
          fn();
        } finally {
          afterTimerFire?.();
        }
      }, ms),
    clearTimer: (handle) => baseTimers.clearTimer(handle),
    // Forward to the injected jitter function, falling back to the real
    // ID-derived hash exactly as the scheduler would when none is injected.
    jitterOffset: (id, intervalMs) => (baseTimers.jitterOffset ?? jitterOffsetMs)(id, intervalMs),
  };

  // One registry per extension instance, so sessions never share task state.
  // Constructing it creates no timers or other resources.
  const registry = deps.registry ?? new TaskRegistry({ now: () => timers.now() });

  /** Stable keys for the persistent status text and the editor-adjacent widget. */
  const STATUS_KEY = "loop";

  /**
   * Repaint the persistent status/widget from the authoritative registry.
   *
   * A no-op without a UI (JSON/print modes, or before a context exists) and when
   * the UI surface is absent. With no tasks both surfaces are explicitly cleared
   * so a stopped loop leaves nothing behind.
   */
  const refreshUi = (ctx: ExtensionContext | undefined = latestCtx): void => {
    if (!ctx || !ctx.hasUI) {
      return;
    }
    const tasks = registry.list();
    if (tasks.length === 0) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(STATUS_KEY, undefined);
      return;
    }
    const now = timers.now();
    ctx.ui.setStatus(STATUS_KEY, formatStatusLine(tasks));
    ctx.ui.setWidget(STATUS_KEY, formatTaskLines(tasks, now), { placement: "belowEditor" });
  };

  afterTimerFire = () => refreshUi();

  const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
    latestCtx?.ui.notify(message, type);
  };

  // Maintenance loops resolve their prompt on every run, so an edited
  // `.claude/loop.md` or `~/.claude/loop.md` takes effect on the next iteration.
  // The unified dispatcher classifies the resolved text so a maintenance file
  // that names a control command is rejected before it can be sent.
  const dispatcher = createScheduledPromptDispatcher({
    commands: () => pi.getCommands(),
    send: (text, options) => {
      pi.sendUserMessage(text, options);
    },
  });

  const resolvePrompt = (task: ScheduledTask): string => {
    const raw = task.maintenance ? resolveMaintenancePrompt(deps.maintenance).prompt : task.prompt;
    // Reject control/unsupported forms at resolution time so the scheduler's
    // existing skip (fixed) / bounded-fallback (self-paced) handling applies,
    // instead of a run that can never be delivered.
    const decision = dispatcher.classify(raw);
    if (decision.action === "reject") {
      throw new ScheduledPromptRejectedError(decision);
    }
    return raw;
  };

  const scheduler = new LoopScheduler(
    timers,
    registry,
    (_task, prompt) => {
      // A user message, never a shell command. The dispatcher decides whether Pi
      // should expand a skill/template or send the text literally, and refuses
      // to send a rejected control form.
      dispatcher.dispatch(prompt);
    },
    () => latestCtx?.isIdle() ?? true,
    (error) => {
      if (error instanceof MaintenancePromptError) {
        notify(`Maintenance prompt error: ${error.message}`, "error");
        return;
      }
      if (error instanceof ScheduledPromptRejectedError) {
        notify(`Scheduled prompt rejected: ${error.message}`, "error");
        return;
      }
      notify(`Loop task failed to send: ${errorMessage(error)}`, "error");
    },
    resolvePrompt,
    // Persist fixed and one-shot mutations as Pi session custom entries so the
    // tasks survive reload/resume; self-paced wakeups are never persisted.
    (event) => {
      pi.appendEntry(PERSISTENCE_CUSTOM_TYPE, event);
    },
  );

  // Model-callable tools share this scheduler and registry with `/loop`, so the
  // command and the tools always see and mutate the same session-scoped state.
  // In disable mode no scheduling tool is registered at all, so the model cannot
  // create or mutate tasks; `/loop` still explains why.
  if (!disabled) {
    registerSchedulerTools(pi, {
      scheduler,
      registry,
      now: () => timers.now(),
      classifyPrompt: (prompt) => dispatcher.classify(prompt),
      onChange: () => refreshUi(),
    });
  }

  /**
   * Rebuild this session's scheduler state from the active branch only.
   *
   * Disposes the previous branch/session state first, then replays this
   * extension's custom entries in branch order. Abandoned branches are not
   * replayed because they are not part of `getBranch()`. Restoring writes no new
   * entries, and a task whose ID is already tracked is not duplicated.
   */
  const reconstruct = (ctx: ExtensionContext): void => {
    // In disable mode nothing is restored, so no timer can be armed from a
    // resumed session's history.
    if (disabled) {
      refreshUi(ctx);
      return;
    }
    // Teardown is non-persisting: a reload must not tombstone the tasks it is
    // about to restore.
    scheduler.stopAll();
    registry.clear();
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const plan = planRestore(collectEntries(branch), timers.now());
    for (const issue of plan.issues) {
      notify(`Loop persistence: ${issue}`, "warning");
    }
    for (const task of plan.tasks) {
      scheduler.restore(task);
    }
    refreshUi(ctx);
  };

  /** Describe the command-owned loop, or undefined when none is active. */
  const describePrimary = (state: ReturnType<LoopScheduler["status"]>): string | undefined => {
    if (!state.active) {
      return undefined;
    }
    const pending = state.pending ? " (one run queued for the next idle moment)" : "";
    if (state.maintenance) {
      if (state.mode === "self-paced") {
        const awaiting = state.awaitingDecision ? " (waiting for the next wakeup)" : "";
        const reason = state.reason ? ` (last reason: ${state.reason})` : "";
        return `Maintenance loop (self-paced)${pending}${awaiting}${reason}`;
      }
      return `Maintenance loop every ${formatInterval(state.intervalMs)}${pending}`;
    }
    if (state.mode === "self-paced") {
      const awaiting = state.awaitingDecision ? " (waiting for the next wakeup)" : "";
      const reason = state.reason ? ` (last reason: ${state.reason})` : "";
      return `Self-paced loop: ${state.task}${pending}${awaiting}${reason}`;
    }
    return `Loop every ${formatInterval(state.intervalMs)}: ${state.task}${pending}`;
  };

  /**
   * Show the command-owned loop (when one is active) followed by every tracked
   * task, so independent tool-created tasks are visible with their IDs, modes,
   * next due/wakeup, and queued state.
   */
  const describe = (ctx: ExtensionCommandContext): void => {
    const tasks = registry.list();
    if (tasks.length === 0) {
      ctx.ui.notify("No loop is running.", "info");
      return;
    }
    const lines: string[] = [];
    const primary = describePrimary(scheduler.status());
    if (primary !== undefined) {
      lines.push(primary);
    }
    lines.push(`${tasks.length} scheduled task${tasks.length === 1 ? "" : "s"}:`);
    lines.push(...formatTaskLines(tasks, timers.now()));
    ctx.ui.notify(lines.join("\n"), "info");
  };

  /** Describe an interval, noting when scheduling rounded it to a cron cadence. */
  const cadenceText = (requestedMs: number, effectiveMs: number): string => {
    if (effectiveMs === requestedMs) {
      return formatInterval(effectiveMs);
    }
    return `${formatInterval(effectiveMs)} (normalized from ${formatInterval(requestedMs)})`;
  };

  /** Describe a self-paced fallback delay, noting when it was clamped. */
  const fallbackText = (requestedMs: number): string => {
    const clamped = clampWakeupDelay(requestedMs);
    if (clamped === requestedMs) {
      return formatInterval(clamped);
    }
    return `${formatInterval(clamped)} (normalized from ${formatInterval(requestedMs)})`;
  };

  /** Read the optional `loop.json` fallback delay for a self-paced loop. */
  const readFallbackDelay = async (ctx: ExtensionCommandContext): Promise<number | undefined> => {
    try {
      const resolved = await loadDefaultInterval({ configPath, readFile: deps.readFile });
      return resolved.intervalMs;
    } catch (error) {
      ctx.ui.notify(`Loop config error: ${errorMessage(error)}`, "error");
      return undefined;
    }
  };

  pi.registerCommand("loop", {
    description: "Repeat a task at an interval, or let each iteration pace itself in this session",
    getArgumentCompletions: (prefix) => {
      const options = ["stop", "status", "every "];
      const matches = options.filter((option) => option.startsWith(prefix));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      latestCtx = ctx;
      if (disabled) {
        refreshUi(ctx);
        ctx.ui.notify(
          `Loop scheduling is disabled (${LOOP_DISABLE_ENV}); /loop and the scheduling tools are unavailable.`,
          "warning",
        );
        return;
      }
      const command = parseLoopCommand(args);

      switch (command.type) {
        case "usage":
          ctx.ui.notify(usageText(command.reason), "warning");
          return;
        case "stop": {
          const stopped = scheduler.stop();
          ctx.ui.notify(stopped ? "Loop stopped." : "No loop is running.", "info");
          refreshUi(ctx);
          return;
        }
        case "status":
          describe(ctx);
          return;
        case "maintenance": {
          // Bare `/loop` and interval-only `/loop <n><unit>` run the maintenance
          // prompt. It is not fixed at start: the prompt is resolved fresh on
          // every run from `.claude/loop.md`, then `~/.claude/loop.md`, then the
          // built-in prompt, so a missing or unreadable file is reported at the
          // first iteration rather than blocking the command.
          if (command.intervalMs === undefined) {
            const fallbackDelayMs = await readFallbackDelay(ctx);
            if (fallbackDelayMs === undefined) {
              return;
            }
            scheduler.startSelfPaced(BUILT_IN_MAINTENANCE_PROMPT, {
              fallbackDelayMs,
              maintenance: true,
            });
            ctx.ui.notify(
              `Maintenance loop (self-paced): loop.md or the built-in prompt, resolved each run (fallback wakeup in ${fallbackText(fallbackDelayMs)} if no next wakeup is chosen).`,
              "info",
            );
            refreshUi(ctx);
            return;
          }
          scheduler.start(command.intervalMs, BUILT_IN_MAINTENANCE_PROMPT, { maintenance: true });
          const effectiveMs = scheduler.status().intervalMs;
          ctx.ui.notify(
            `Maintenance loop every ${cadenceText(command.intervalMs, effectiveMs)}: loop.md or the built-in prompt, resolved each run.`,
            "info",
          );
          refreshUi(ctx);
          return;
        }
        case "start":
          break;
      }

      // Fail fast on a slash-prefixed task that is a control command or an
      // unknown skill, so no loop is created that could never deliver its run.
      // Plain slash text (a path, prose) and known skills/templates pass.
      const startDecision = dispatcher.classify(command.task);
      if (startDecision.action === "reject") {
        ctx.ui.notify(`Scheduled prompt rejected: ${startDecision.reason}`, "error");
        return;
      }

      if (command.intervalMs === undefined) {
        // Prompt-only `/loop <task>` is self-paced: the iteration chooses its
        // next wakeup. The optional config interval becomes the bounded fallback
        // delay used when an iteration does not choose one.
        const fallbackDelayMs = await readFallbackDelay(ctx);
        if (fallbackDelayMs === undefined) {
          return;
        }
        scheduler.startSelfPaced(command.task, { fallbackDelayMs });
        ctx.ui.notify(
          `Self-paced loop: ${command.task} (fallback wakeup in ${fallbackText(fallbackDelayMs)} if no next wakeup is chosen).`,
          "info",
        );
        refreshUi(ctx);
        return;
      }

      scheduler.start(command.intervalMs, command.task);
      const effectiveMs = scheduler.status().intervalMs;
      ctx.ui.notify(`Loop every ${cadenceText(command.intervalMs, effectiveMs)}: ${command.task}`, "info");
      refreshUi(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    reconstruct(ctx);
  });

  // Navigating the session tree changes the active branch, so rebuild from the
  // new branch: tasks created on an abandoned branch are dropped and tasks on
  // the entered branch are restored (without duplicating entries).
  pi.on("session_tree", (_event, ctx) => {
    latestCtx = ctx;
    reconstruct(ctx);
  });

  // Refresh the context and idle snapshot whenever an agent run boundary moves.
  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
    refreshUi(ctx);
  });

  // `agent_settled` is Pi's final idle boundary. Settle any self-paced iteration
  // first (so a run we are about to flush cannot be mistaken for a miss), then
  // flush every distinct due task in the scheduler's deterministic order. A
  // flush stops early if a dispatch starts work again; the remainder resumes at
  // the next idle boundary.
  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx;
    const settled = scheduler.settleIteration();
    if (settled.action === "fallback") {
      ctx.ui.notify(
        `Self-paced loop did not choose a next wakeup; one fallback wakeup scheduled in ${formatInterval(settled.delayMs)}.`,
        "warning",
      );
    } else if (settled.action === "terminated") {
      ctx.ui.notify(
        "Self-paced loop stopped after a repeated missing wakeup. Start it again with /loop if needed.",
        "warning",
      );
    }
    scheduler.flush();
    refreshUi(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // Stop every tracked task (not just the command-owned loop) so no timer or
    // stale callback survives, then drop the records.
    scheduler.stopAll();
    // Drop every task so a reused instance cannot leak state into another session.
    registry.clear();
    // Clear the persistent surfaces before the context is dropped.
    refreshUi(ctx);
    latestCtx = undefined;
  });
}

/** Default Pi extension factory. */
export default function loopExtension(pi: ExtensionAPI): void {
  createLoopExtension(pi);
}
