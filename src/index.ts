/**
 * Pi wiring for the loop extension.
 *
 * `/loop` repeats a task as a user message in the current session. All parsing,
 * scheduling, and config logic lives in the Pi-independent modules so this file
 * only adapts Pi commands, idle signals, and lifecycle events.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadDefaultInterval, loopConfigPath, type ConfigReader } from "./config.ts";
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
import { TaskRegistry, type ScheduledTask } from "./task-registry.ts";

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
  const timers = deps.timers ?? systemTimers;
  const configPath = deps.configPath ?? loopConfigPath();

  // One registry per extension instance, so sessions never share task state.
  // Constructing it creates no timers or other resources.
  const registry = deps.registry ?? new TaskRegistry({ now: () => timers.now() });

  // Latest context is only used for notifications and the authoritative idle
  // check; it is dropped on session shutdown so a replaced session's context is
  // never reused.
  let latestCtx: ExtensionContext | undefined;

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
  );

  const describe = (ctx: ExtensionCommandContext): void => {
    const state = scheduler.status();
    if (!state.active) {
      ctx.ui.notify("No loop is running.", "info");
      return;
    }
    const pending = state.pending ? " (one run queued for the next idle moment)" : "";
    if (state.maintenance) {
      if (state.mode === "self-paced") {
        const awaiting = state.awaitingDecision ? " (waiting for the next wakeup)" : "";
        const reason = state.reason ? ` (last reason: ${state.reason})` : "";
        ctx.ui.notify(`Maintenance loop (self-paced)${pending}${awaiting}${reason}`, "info");
        return;
      }
      ctx.ui.notify(`Maintenance loop every ${formatInterval(state.intervalMs)}${pending}`, "info");
      return;
    }
    if (state.mode === "self-paced") {
      const awaiting = state.awaitingDecision ? " (waiting for the next wakeup)" : "";
      const reason = state.reason ? ` (last reason: ${state.reason})` : "";
      ctx.ui.notify(`Self-paced loop: ${state.task}${pending}${awaiting}${reason}`, "info");
      return;
    }
    ctx.ui.notify(`Loop every ${formatInterval(state.intervalMs)}: ${state.task}${pending}`, "info");
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
      const command = parseLoopCommand(args);

      switch (command.type) {
        case "usage":
          ctx.ui.notify(usageText(command.reason), "warning");
          return;
        case "stop": {
          const stopped = scheduler.stop();
          ctx.ui.notify(stopped ? "Loop stopped." : "No loop is running.", "info");
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
            return;
          }
          scheduler.start(command.intervalMs, BUILT_IN_MAINTENANCE_PROMPT, { maintenance: true });
          const effectiveMs = scheduler.status().intervalMs;
          ctx.ui.notify(
            `Maintenance loop every ${cadenceText(command.intervalMs, effectiveMs)}: loop.md or the built-in prompt, resolved each run.`,
            "info",
          );
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
        return;
      }

      scheduler.start(command.intervalMs, command.task);
      const effectiveMs = scheduler.status().intervalMs;
      ctx.ui.notify(`Loop every ${cadenceText(command.intervalMs, effectiveMs)}: ${command.task}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Refresh the context and idle snapshot whenever an agent run boundary moves.
  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // `agent_settled` is Pi's final idle boundary. Settle any self-paced iteration
  // first (so a run we are about to flush cannot be mistaken for a miss), then
  // flush one coalesced pending run.
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
  });

  pi.on("session_shutdown", () => {
    scheduler.stop();
    // Drop every task so a reused instance cannot leak state into another session.
    registry.clear();
    latestCtx = undefined;
  });
}

/** Default Pi extension factory. */
export default function loopExtension(pi: ExtensionAPI): void {
  createLoopExtension(pi);
}
