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
  formatInterval,
  LoopScheduler,
  maintenanceText,
  parseLoopCommand,
  systemTimers,
  usageText,
  type SchedulerDeps,
} from "./loop-core.ts";
import { TaskRegistry } from "./task-registry.ts";

export interface LoopExtensionDeps {
  /** Override the `loop.json` path (tests or an explicit deploy). */
  configPath?: string;
  /** Override the config file reader (tests). */
  readFile?: ConfigReader;
  /** Override timer primitives (tests). */
  timers?: SchedulerDeps;
  /** Override the per-session task registry (tests, or an explicit session). */
  registry?: TaskRegistry;
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

  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      // A user message, never a shell command. Only sent while idle.
      pi.sendUserMessage(task.prompt);
    },
    () => latestCtx?.isIdle() ?? true,
    (error) => notify(`Loop task failed to send: ${errorMessage(error)}`, "error"),
  );

  const describe = (ctx: ExtensionCommandContext): void => {
    const state = scheduler.status();
    if (!state.active) {
      ctx.ui.notify("No loop is running.", "info");
      return;
    }
    const pending = state.pending ? " (one run queued for the next idle moment)" : "";
    ctx.ui.notify(`Loop every ${formatInterval(state.intervalMs)}: ${state.task}${pending}`, "info");
  };

  /** Describe an interval, noting when scheduling rounded it to a cron cadence. */
  const cadenceText = (requestedMs: number, effectiveMs: number): string => {
    if (effectiveMs === requestedMs) {
      return formatInterval(effectiveMs);
    }
    return `${formatInterval(effectiveMs)} (normalized from ${formatInterval(requestedMs)})`;
  };

  pi.registerCommand("loop", {
    description: "Repeat a task at a fixed interval in this session",
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
        case "maintenance":
          // Recognized so interval-looking input never becomes task text, but
          // the maintenance prompt (loop.md) is a later change. Leave any
          // existing loop untouched.
          ctx.ui.notify(maintenanceText(command.intervalMs), "warning");
          return;
        case "start":
          break;
      }

      let intervalMs = command.intervalMs;
      if (intervalMs === undefined) {
        try {
          const resolved = await loadDefaultInterval({ configPath, readFile: deps.readFile });
          intervalMs = resolved.intervalMs;
        } catch (error) {
          ctx.ui.notify(`Loop config error: ${errorMessage(error)}`, "error");
          return;
        }
      }

      scheduler.start(intervalMs, command.task);
      const effectiveMs = scheduler.status().intervalMs;
      ctx.ui.notify(`Loop every ${cadenceText(intervalMs, effectiveMs)}: ${command.task}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Refresh the context and idle snapshot whenever an agent run boundary moves.
  pi.on("agent_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // `agent_settled` is Pi's final idle boundary; flush one coalesced run here.
  pi.on("agent_settled", (_event, ctx) => {
    latestCtx = ctx;
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
