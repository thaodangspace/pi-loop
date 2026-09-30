/**
 * Deterministic fakes shared by the test suites: a manual timer queue and a
 * minimal Pi extension API/context.
 */
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ConfigReader } from "../src/config.ts";
import type { SlashCommandLike } from "../src/dispatch.ts";
import type { SchedulerDeps } from "../src/loop-core.ts";
import type { JitterOffset } from "../src/schedule.ts";
import { TaskRegistry } from "../src/task-registry.ts";

interface FakeTimerTask {
  at: number;
  fn: () => void;
}

/** Virtual clock + timer queue implementing the scheduler's timer deps. */
export class FakeTimers implements SchedulerDeps {
  clock = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, FakeTimerTask>();

  /**
   * Task-ID jitter is disabled by default so the boundary/grid suites assert the
   * underlying `anchor + k × cadence` schedule. Jitter-specific tests override
   * this with the real {@link jitterOffsetMs} (or any deterministic function).
   */
  jitterOffset: JitterOffset = () => 0;

  now = (): number => this.clock;

  setTimer = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.clock + ms, fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  get pendingCount(): number {
    return this.tasks.size;
  }

  /**
   * Jump the clock forward without firing pending timers, simulating a process
   * sleep or a clock jump. Overdue timers stay armed and fire on the next
   * `advance`, coalescing every missed boundary into one run.
   */
  sleep(ms: number): void {
    this.clock += ms;
  }

  /** Advance the clock, firing every due timer in timestamp order. */
  advance(ms: number): void {
    const target = this.clock + ms;
    let steps = 0;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, task] of this.tasks) {
        if (task.at <= target && task.at < nextAt) {
          nextAt = task.at;
          nextId = id;
        }
      }
      if (nextId === undefined) {
        break;
      }
      const task = this.tasks.get(nextId)!;
      this.tasks.delete(nextId);
      // Never move the clock backwards when an overdue timer fires after a jump.
      this.clock = Math.max(this.clock, task.at);
      task.fn();
      if (++steps > 10_000) {
        throw new Error("fake timer runaway");
      }
    }
    this.clock = target;
  }
}

/** A registry wired to a fake clock with predictable `t1`, `t2`, ... IDs. */
export function testRegistry(timers: FakeTimers, options: Partial<{ maxTasks: number }> = {}): TaskRegistry {
  let counter = 0;
  return new TaskRegistry({
    now: () => timers.clock,
    createId: () => `t${(counter += 1)}`,
    ...options,
  });
}

export interface FakeNotification {
  message: string;
  type?: "info" | "warning" | "error";
}

/** One `setStatus` call recorded by the fake UI. */
export interface FakeStatusUpdate {
  key: string;
  text: string | undefined;
}

/** One `setWidget` call recorded by the fake UI. */
export interface FakeWidgetUpdate {
  key: string;
  lines: string[] | undefined;
}

/** Minimal command context used by the extension adapter. */
export class FakeCtx {
  readonly notifications: FakeNotification[] = [];
  idle = true;
  /** Run mode; "tui" by default so UI paths are exercised. */
  mode: "tui" | "rpc" | "json" | "print" = "tui";
  /** Whether dialog-capable UI is available (true in TUI and RPC modes). */
  hasUI = true;
  /** Every `setStatus` call, in order. */
  readonly statuses: FakeStatusUpdate[] = [];
  /** Every `setWidget` call, in order. */
  readonly widgets: FakeWidgetUpdate[] = [];
  /** Active-branch entries returned by `sessionManager.getBranch()`. */
  branch: Array<{ type: string; customType?: string; data?: unknown; id?: string; parentId?: string | null }> = [];
  readonly sessionManager = {
    getBranch: (): unknown[] => this.branch,
  };
  readonly ui = {
    notify: (message: string, type?: "info" | "warning" | "error"): void => {
      this.notifications.push({ message, type });
    },
    setStatus: (key: string, text: string | undefined): void => {
      this.statuses.push({ key, text });
    },
    setWidget: (key: string, lines: string[] | undefined): void => {
      this.widgets.push({ key, lines });
    },
  };

  isIdle(): boolean {
    return this.idle;
  }

  lastNotification(): FakeNotification | undefined {
    return this.notifications.at(-1);
  }

  /** The most recent status text, or undefined when none was set. */
  lastStatus(): string | undefined {
    return this.statuses.at(-1)?.text;
  }

  /** The most recent widget lines, or undefined when none was set. */
  lastWidget(): string[] | undefined {
    return this.widgets.at(-1)?.lines;
  }

  asCommandContext(): ExtensionCommandContext {
    return this as unknown as ExtensionCommandContext;
  }
}

export type FakeHandler = (event: unknown, ctx: FakeCtx) => unknown;

export interface FakeSendCall {
  /** The text Pi would deliver to the model, after any expansion. */
  text: string;
  expandPromptTemplates: boolean;
}

/**
 * Minimal ExtensionAPI that records registrations and outbound messages.
 *
 * `sendUserMessage` reproduces the dispatch semantics of the installed Pi
 * (`AgentSession.prompt` in 0.87.1) rather than accepting anything:
 *
 * - `expandPromptTemplates` defaults to false, so text is delivered literally.
 * - With expansion on and a leading `/`, a matching extension command is
 *   *executed* and no prompt is delivered; then `/skill:<name>` is expanded to a
 *   `<skill>` block; then a prompt template is expanded.
 *
 * This makes a bug that enables expansion for a control command show up as an
 * executed command in `executedCommands` instead of a silently delivered string.
 */
export class FakePi {
  readonly commands = new Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void> }>();
  readonly handlers = new Map<string, FakeHandler[]>();
  /** Delivered prompt texts (post-expansion), one per send. */
  readonly sent: string[] = [];
  /** Every send with the expansion flag the dispatcher chose. */
  readonly calls: FakeSendCall[] = [];
  /** Extension commands Pi would have executed instead of sending a prompt. */
  readonly executedCommands: string[] = [];
  /** Slash commands returned by `getCommands()`: extension, prompt, and skill. */
  readonly slashCommands: SlashCommandLike[] = [];
  /** Prompt templates available for expansion, by command name. */
  readonly templates = new Map<string, string>();
  /** Skill bodies available for expansion, by skill name. */
  readonly skills = new Map<string, string>();
  /** Custom entries appended via `appendEntry`, in order. */
  readonly appended: Array<{ customType: string; data: unknown }> = [];
  /**
   * Simulated internal send failure. Real Pi's `sendUserMessage` extension
   * surface is fire-and-forget: it returns `void`, catches the async delivery
   * rejection itself, and reports it through Pi's own error channel. The
   * extension and scheduler therefore never observe it. Setting this records the
   * error in {@link sendErrors} and delivers nothing, without throwing.
   */
  sendError: Error | undefined;
  /** Internal failures recorded by the fire-and-forget send surface. */
  readonly sendErrors: unknown[] = [];

  /** Tools registered via `registerTool`, keyed by name. */
  readonly tools = new Map<string, ToolDefinition>();

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerCommand(name: string, options: { handler: (args: string, ctx: FakeCtx) => Promise<void> }): void {
    this.commands.set(name, options);
    // Real Pi reports registered commands through getCommands().
    if (!this.slashCommands.some((command) => command.name === name && command.source === "extension")) {
      this.slashCommands.push({ name, source: "extension" });
    }
  }

  on(event: string, handler: FakeHandler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((item) => item !== handler),
      );
    };
  }

  /** Pi's `getCommands()`: extension commands, prompt templates, and skills. */
  getCommands(): SlashCommandLike[] {
    return [...this.slashCommands];
  }

  sendUserMessage(content: string | unknown, options?: { expandPromptTemplates?: boolean }): void {
    if (this.sendError) {
      // Pi catches the async rejection internally and emits its own error event;
      // the `void` extension API swallows it, so nothing here may throw.
      this.sendErrors.push(this.sendError);
      return;
    }
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const expand = options?.expandPromptTemplates ?? false;
    let delivered = text;
    if (expand && text.startsWith("/")) {
      const space = text.indexOf(" ");
      const commandName = space === -1 ? text.slice(1) : text.slice(1, space);
      const isExtension = this.slashCommands.some(
        (command) => command.source === "extension" && command.name === commandName,
      );
      if (isExtension) {
        // Pi executes the extension command and sends no prompt.
        this.executedCommands.push(commandName);
        return;
      }
      const skillName = text.startsWith("/skill:")
        ? space === -1
          ? text.slice(7)
          : text.slice(7, space)
        : undefined;
      if (skillName !== undefined && this.skills.has(skillName)) {
        const args = space === -1 ? "" : text.slice(space + 1).trim();
        const block = `<skill name="${skillName}">\n${this.skills.get(skillName)}\n</skill>`;
        delivered = args ? `${block}\n\n${args}` : block;
      } else {
        const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
        const templateName = match?.[1];
        if (templateName !== undefined && this.templates.has(templateName)) {
          delivered = this.templates.get(templateName)!;
        }
      }
    }
    this.calls.push({ text: delivered, expandPromptTemplates: expand });
    this.sent.push(delivered);
  }

  /** Append a custom entry the way Pi persists extension state. */
  appendEntry(customType: string, data?: unknown): void {
    this.appended.push({ customType, data });
  }

  async run(command: string, args: string, ctx: FakeCtx): Promise<void> {
    const registered = this.commands.get(command);
    if (!registered) {
      throw new Error(`command not registered: ${command}`);
    }
    await registered.handler(args, ctx);
  }

  fire(event: string, ctx?: FakeCtx, payload: unknown = { type: event }): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload, ctx as FakeCtx);
    }
  }

  asExtensionApi(): ExtensionAPI {
    return this as unknown as ExtensionAPI;
  }
}

export function configReader(contents: string): { readFile: ConfigReader; reads: () => number } {
  let reads = 0;
  return {
    readFile: async () => {
      reads += 1;
      return contents;
    },
    reads: () => reads,
  };
}

export function missingFile(): NodeJS.ErrnoException {
  return Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
}

/**
 * A synchronous maintenance-prompt reader backed by an in-memory map. Unknown
 * paths throw ENOENT, and every requested path is recorded for assertions.
 */
export function maintenanceReader(files: Record<string, string>): {
  readFile: (filePath: string) => string;
  reads: string[];
} {
  const reads: string[] = [];
  return {
    readFile: (filePath: string): string => {
      reads.push(filePath);
      const contents = files[filePath];
      if (contents === undefined) {
        throw missingFile();
      }
      return contents;
    },
    reads,
  };
}
