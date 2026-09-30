/**
 * Model-callable scheduler tools: registration contract and invocation through
 * the extension harness (shared registry + scheduler with `/loop`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import { CronScheduleError } from "../src/cron.ts";
import { IntervalError, WakeupError } from "../src/loop-core.ts";
import { ScheduledPromptRejectedError } from "../src/dispatch.ts";
import { TaskLimitError, TaskNotFoundError } from "../src/task-registry.ts";
import { SCHEDULER_TOOL_NAMES } from "../src/tools.ts";
import type { FixedSchedule } from "../src/schedule.ts";
import { FakeCtx, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

const NAMES = SCHEDULER_TOOL_NAMES;

function setup(overrides: Partial<LoopExtensionDeps> = {}) {
  const { maintenance, ...rest } = overrides;
  const timers = new FakeTimers();
  const pi = new FakePi();
  const ctx = new FakeCtx();
  const registry = overrides.registry ?? testRegistry(timers);
  createLoopExtension(pi.asExtensionApi(), {
    configPath: "/tmp/loop.json",
    timers,
    readFile: async () => {
      throw missingFile();
    },
    ...rest,
    maintenance: {
      cwd: "/tmp/pi-loop-project",
      homeDir: "/tmp/pi-loop-home",
      readFile: () => {
        throw missingFile();
      },
      ...maintenance,
    },
    registry,
  });
  return { timers, pi, ctx, registry };
}

/** Invoke a registered tool the way Pi would, returning its typed result. */
async function callTool<T = unknown>(
  pi: FakePi,
  name: string,
  params: unknown,
  ctx: FakeCtx = new FakeCtx(),
): Promise<AgentToolResult<T>> {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool.execute("call-1", params as never, undefined, undefined, ctx as never) as Promise<
    AgentToolResult<T>
  >;
}

test("every scheduler tool is registered with a distinct name and typed schema", () => {
  const { pi } = setup();

  const names = [...pi.tools.keys()];
  assert.deepEqual(
    names.sort(),
    [
      NAMES.scheduleTask,
      NAMES.scheduleCronTask,
      NAMES.scheduleOnceTask,
      NAMES.listTasks,
      NAMES.deleteTask,
      NAMES.scheduleWakeup,
      NAMES.stopWakeup,
    ].sort(),
  );
  assert.equal(new Set(names).size, names.length, "tool names must be distinct");
  assert.ok(!pi.commands.has("schedule_task"), "tool names must not collide with slash commands");

  const schedule = pi.tools.get(NAMES.scheduleTask)!;
  assert.match(schedule.description, /^Mutating\./);
  assert.equal(schedule.executionMode, "sequential", "tools share mutable scheduler state");
  assert.ok(Array.isArray(schedule.promptGuidelines) && schedule.promptGuidelines.length > 0);
  const params = schedule.parameters as {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.equal(params.type, "object");
  assert.deepEqual(Object.keys(params.properties).sort(), ["expiresIn", "interval", "prompt"]);
  assert.deepEqual([...(params.required ?? [])].sort(), ["interval", "prompt"]);

  const cron = pi.tools.get(NAMES.scheduleCronTask)!;
  assert.match(cron.description, /^Mutating\./);
  assert.deepEqual(
    Object.keys((cron.parameters as { properties: Record<string, unknown> }).properties).sort(),
    ["cron", "expiresIn", "prompt", "timeZone"],
  );
  assert.deepEqual(
    [...((cron.parameters as { required?: string[] }).required ?? [])].sort(),
    ["cron", "prompt"],
  );

  const once = pi.tools.get(NAMES.scheduleOnceTask)!;
  assert.match(once.description, /^Mutating\./);
  assert.deepEqual(
    Object.keys((once.parameters as { properties: Record<string, unknown> }).properties).sort(),
    ["at", "delay", "prompt"],
  );
  assert.deepEqual(
    [...((once.parameters as { required?: string[] }).required ?? [])],
    ["prompt"],
  );

  const list = pi.tools.get(NAMES.listTasks)!;
  assert.match(list.description, /^Read-only\./);
  assert.deepEqual(Object.keys((list.parameters as { properties: object }).properties), []);

  const remove = pi.tools.get(NAMES.deleteTask)!;
  assert.match(remove.description, /^Mutating\./);
  assert.deepEqual(Object.keys((remove.parameters as { properties: object }).properties), ["id"]);

  const wakeup = pi.tools.get(NAMES.scheduleWakeup)!;
  assert.deepEqual(
    Object.keys((wakeup.parameters as { properties: object }).properties).sort(),
    ["delayMs", "reason"],
  );

  const stop = pi.tools.get(NAMES.stopWakeup)!;
  assert.match(stop.description, /^Mutating\./);
});

test("schedule_task creates a fixed task that fires and can be listed", async () => {
  const { timers, pi, ctx, registry } = setup();

  const result = await callTool<{ ok: boolean; task: { id: string; intervalMs: number; nextFireAt: number } }>(
    pi,
    NAMES.scheduleTask,
    { interval: "5min", prompt: "check deploy" },
    ctx,
  );
  assert.equal(result.details.ok, true);
  const id = result.details.task.id;
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /Scheduled task/);
  assert.equal(registry.get(id)?.prompt, "check deploy");
  assert.equal(registry.get(id)?.mode, "fixed");
  assert.equal((registry.get(id)?.schedule as FixedSchedule | undefined)?.intervalMs, 300_000);

  const list = await callTool<{ count: number; tasks: Array<{ id: string; pending: boolean }> }>(
    pi,
    NAMES.listTasks,
    {},
  );
  assert.equal(list.details.count, 1);
  assert.equal(list.details.tasks[0]!.id, id);

  assert.deepEqual(pi.sent, [], "a fixed task waits for its first boundary");
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["check deploy"]);
});

test("schedule_task honours an explicit expiry and rejects one shorter than the first run", async () => {
  const { timers, pi, registry } = setup();

  const ok = await callTool<{ task: { expiresAt: number; id: string } }>(
    pi,
    NAMES.scheduleTask,
    { interval: "1min", prompt: "short lived", expiresIn: "2h" },
  );
  assert.equal(ok.details.task.expiresAt, timers.clock + 2 * 3_600_000);
  assert.equal(registry.has(ok.details.task.id), true);

  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "5min", prompt: "doomed", expiresIn: "1s" }),
    /expire before its first run/,
  );
  assert.equal(registry.size, 1, "a task that expires immediately is not registered");
});

test("schedule_task rejects malformed intervals, empty prompts and control prompts", async () => {
  const { pi, registry } = setup();

  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "5x", prompt: "whatever" }),
    (error: unknown) => error instanceof IntervalError && /unknown interval unit/.test(error.message),
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "0min", prompt: "whatever" }),
    (error: unknown) => error instanceof IntervalError && /positive whole number/.test(error.message),
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "   " }),
    /prompt must be a non-empty string/,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "/loop stop" }),
    (error: unknown) => error instanceof ScheduledPromptRejectedError,
  );
  assert.equal(registry.size, 0, "no invalid schedule is ever registered");
});

test("schedule_task surfaces the active-task limit", async () => {
  const { timers, pi, registry } = setup({ registry: testRegistry(new FakeTimers(), { maxTasks: 1 }) });

  await callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "first" });
  await assert.rejects(
    callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "second" }),
    (error: unknown) => error instanceof TaskLimitError,
  );
  assert.equal(registry.size, 1);
  assert.equal(timers.pendingCount, 1, "the rejected task armed no timer");
});

test("delete_scheduled_task removes exactly the matching ID and reports unknown IDs", async () => {
  const { timers, pi, registry } = setup();
  const first = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleTask, {
    interval: "1min",
    prompt: "first",
  });
  const second = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleTask, {
    interval: "1min",
    prompt: "second",
  });

  await callTool(pi, NAMES.deleteTask, { id: first.details.task.id });
  assert.equal(registry.has(first.details.task.id), false);
  assert.equal(registry.has(second.details.task.id), true, "a different task is untouched");
  assert.equal(timers.pendingCount, 1, "only the deleted task's timer is cleared");
  assert.ok(
    pi.appended.some((entry) => (entry.data as { kind?: string }).kind === "delete"),
    "deletion is persisted as a tombstone for reload",
  );

  await assert.rejects(
    callTool(pi, NAMES.deleteTask, { id: "nope" }),
    (error: unknown) => error instanceof TaskNotFoundError && /no scheduled task with id "nope"/.test(error.message),
  );
});

test("deleting a pending task drops its queued run", async () => {
  const { timers, pi, ctx, registry } = setup();
  const created = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleTask, {
    interval: "1min",
    prompt: "poll",
  });
  const id = created.details.task.id;

  // Give the extension a live context (tool calls alone do not update it) so the
  // busy/idle gate reflects `ctx.idle`.
  pi.fire("agent_start", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  assert.equal(registry.get(id)?.pending, true, "the busy tick is queued");

  await callTool(pi, NAMES.deleteTask, { id }, ctx);
  assert.equal(registry.has(id), false);
  assert.equal(timers.pendingCount, 0, "the armed timer is cleared");

  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, [], "the queued run never dispatches after deletion");
});

test("list_scheduled_tasks is read-only and reflects the authoritative registry", async () => {
  const { timers, pi, registry } = setup();
  await callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "one" });
  await callTool(pi, NAMES.scheduleTask, { interval: "1min", prompt: "two" });
  const before = { size: registry.size, timers: timers.pendingCount };

  const list = await callTool<{ count: number; tasks: Array<{ prompt: string }> }>(pi, NAMES.listTasks, {});
  assert.equal(list.details.count, 2);
  assert.deepEqual(
    list.details.tasks.map((task) => task.prompt),
    ["one", "two"],
    "creation order is preserved",
  );
  assert.deepEqual({ size: registry.size, timers: timers.pendingCount }, before, "list mutates nothing");
});

test("schedule_wakeup clamps through the service and stop_wakeup ends the self-paced loop", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "watch deploy", ctx);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"]);

  const clamped = await callTool<{
    delayMs: number;
    requestedMs: number;
    clamped: boolean;
    reason?: string;
  }>(pi, NAMES.scheduleWakeup, { delayMs: 30_000, reason: "back off" });
  assert.equal(clamped.details.requestedMs, 30_000);
  assert.equal(clamped.details.delayMs, 60_000, "below the 1min minimum is clamped up");
  assert.equal(clamped.details.clamped, true);
  assert.equal(clamped.details.reason, "back off");
  assert.equal(timers.pendingCount, 1);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /last reason: back off/);

  const stopped = await callTool<{ id: string; prompt: string }>(pi, NAMES.stopWakeup, {}, ctx);
  assert.equal(stopped.details.prompt, "watch deploy");
  const id = registry.list()[0]?.id;
  assert.equal(id, undefined, "the self-paced task is removed");
  assert.equal(timers.pendingCount, 0);

  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, ["watch deploy"], "no wakeup survives the stop");
});

test("schedule_wakeup and stop_wakeup refuse a fixed or missing loop", async () => {
  const { pi, ctx } = setup();

  await assert.rejects(
    callTool(pi, NAMES.scheduleWakeup, { delayMs: 60_000 }),
    (error: unknown) => error instanceof WakeupError && /no self-paced loop/.test(error.message),
  );
  await assert.rejects(callTool(pi, NAMES.stopWakeup, {}), /no self-paced loop is running/);

  await pi.run("loop", "every 5min ping", ctx);
  await assert.rejects(callTool(pi, NAMES.scheduleWakeup, { delayMs: 60_000 }), /no self-paced loop/);
  await assert.rejects(callTool(pi, NAMES.stopWakeup, {}), /no self-paced loop is running/);
  assert.equal(pi.commands.size >= 1, true, "the fixed loop is untouched by the failed calls");
});

test("tools and /loop share one registry without replacing each other", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "every 1min command", ctx);
  await callTool(pi, NAMES.scheduleTask, { interval: "5min", prompt: "tool task" });
  assert.equal(registry.size, 2, "the command loop and the tool task coexist");

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min: command/, "status stays command-owned");

  const list = await callTool<{ tasks: Array<{ prompt: string; mode: string }> }>(pi, NAMES.listTasks, {});
  assert.deepEqual(
    list.details.tasks.map((task) => task.prompt),
    ["command", "tool task"],
  );

  await pi.run("loop", "stop", ctx);
  assert.equal(registry.size, 1, "/loop stop leaves tool-created tasks alone");
  assert.equal(registry.list()[0]!.prompt, "tool task");

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["tool task"]);
});

test("a tool-created task is restored from session history under the same stable ID", async () => {
  const { timers, pi, registry } = setup();
  const created = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleTask, {
    interval: "5min",
    prompt: "persisted",
  });
  const id = created.details.task.id;

  // Replay the appended create entry through a fresh session context.
  const reloaded = new FakeCtx();
  reloaded.branch = pi.appended.map(({ customType, data }) => ({ type: "custom", customType, data }));
  pi.fire("session_start", reloaded);

  assert.equal(registry.has(id), true, "the stable ID survives the reload");
  assert.equal(registry.get(id)?.prompt, "persisted");
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["persisted"]);
});

test("schedule_cron_task creates a local-time cron task that fires and lists", async () => {
  const { timers, pi, registry } = setup();
  const result = await callTool<{
    ok: boolean;
    task: { id: string; cron?: string; timeZone?: string; nextFireAt?: number };
  }>(pi, NAMES.scheduleCronTask, { cron: "*/5 * * * *", prompt: "cron ping", timeZone: "UTC" });

  assert.equal(result.details.ok, true);
  const id = result.details.task.id;
  assert.equal(result.details.task.cron, "*/5 * * * *");
  assert.equal(result.details.task.timeZone, "UTC");
  assert.equal(result.details.task.nextFireAt, 300_000);
  assert.match(result.content[0]!.type === "text" ? result.content[0]!.text : "", /cron "\*\/5/);
  assert.equal(registry.get(id)?.mode, "fixed", "a cron task is a fixed registry task");

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["cron ping"]);

  const list = await callTool<{ tasks: Array<{ cron?: string; timeZone?: string }> }>(
    pi,
    NAMES.listTasks,
    {},
  );
  assert.equal(list.details.tasks[0]!.cron, "*/5 * * * *");
  assert.equal(list.details.tasks[0]!.timeZone, "UTC");
});

test("schedule_cron_task reports the invalid cron field and expires-before-first-run", async () => {
  const { pi, registry } = setup();

  await assert.rejects(
    callTool(pi, NAMES.scheduleCronTask, { cron: "61 * * * *", prompt: "bad" }),
    (error: unknown) => error instanceof CronScheduleError && error.field === "minute",
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleCronTask, { cron: "* * * * *", prompt: "/loop stop" }),
    (error: unknown) => error instanceof ScheduledPromptRejectedError,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleCronTask, {
      cron: "0 0 1 1 *",
      prompt: "yearly",
      timeZone: "UTC",
      expiresIn: "1d",
    }),
    /expire before its first run/,
  );
  assert.equal(registry.size, 0, "no invalid cron schedule is registered");
});

test("schedule_once_task runs once from a relative delay, then removes itself", async () => {
  const { timers, pi, registry } = setup();
  const result = await callTool<{ ok: boolean; task: { id: string; mode: string; nextFireAt?: number } }>(
    pi,
    NAMES.scheduleOnceTask,
    { delay: "30min", prompt: "run once" },
  );

  assert.equal(result.details.task.mode, "one-shot");
  assert.equal(result.details.task.nextFireAt, 30 * 60_000);
  assert.equal(registry.size, 1);

  timers.advance(30 * 60_000);
  assert.deepEqual(pi.sent, ["run once"]);
  assert.equal(registry.size, 0, "a one-shot removes itself after firing");
  timers.advance(60 * 60_000);
  assert.deepEqual(pi.sent, ["run once"], "a one-shot never repeats");
});

test("schedule_once_task accepts an absolute offset timestamp and rejects ambiguity", async () => {
  const { timers, pi } = setup();
  const at = new Date(10 * 60_000).toISOString(); // clock starts at 0
  await callTool(pi, NAMES.scheduleOnceTask, { at, prompt: "absolute" });
  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, ["absolute"]);

  await assert.rejects(callTool(pi, NAMES.scheduleOnceTask, { prompt: "none" }), /exactly one of delay or at/);
  await assert.rejects(
    callTool(pi, NAMES.scheduleOnceTask, { delay: "1min", at, prompt: "both" }),
    /exactly one of delay or at/,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleOnceTask, { at: new Date(0).toISOString(), prompt: "past" }),
    /must be in the future/,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleOnceTask, { at: "2026-10-01T09:00:00", prompt: "no offset" }),
    /explicit offset or Z/,
  );
});

test("a tool-created cron task is restored from session history under the same stable ID", async () => {
  const { timers, pi, registry } = setup();
  const created = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleCronTask, {
    cron: "*/5 * * * *",
    prompt: "persisted cron",
    timeZone: "UTC",
  });
  const id = created.details.task.id;

  const reloaded = new FakeCtx();
  reloaded.branch = pi.appended.map(({ customType, data }) => ({ type: "custom", customType, data }));
  pi.fire("session_start", reloaded);

  assert.equal(registry.has(id), true, "the stable cron ID survives the reload");
  assert.equal(registry.get(id)?.prompt, "persisted cron");
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["persisted cron"]);
});
