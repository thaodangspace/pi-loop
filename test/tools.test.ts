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
    // Isolate tests from an ambient PI_LOOP_DISABLE; switch tests opt in.
    disabled: false,
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
      NAMES.scheduleSelfPaced,
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

  const selfPaced = pi.tools.get(NAMES.scheduleSelfPaced)!;
  assert.match(selfPaced.description, /^Mutating\./);
  assert.deepEqual(
    Object.keys((selfPaced.parameters as { properties: Record<string, unknown> }).properties).sort(),
    ["fallbackDelay", "prompt"],
  );
  assert.deepEqual(
    [...((selfPaced.parameters as { required?: string[] }).required ?? [])],
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

test("/loop status lists the command loop and every tool task with ID and mode", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 5min command", ctx);
  const created = await callTool<{ task: { id: string } }>(
    pi,
    NAMES.scheduleTask,
    { interval: "10min", prompt: "tool task" },
    ctx,
  );

  await pi.run("loop", "status", ctx);
  const message = ctx.lastNotification()?.message ?? "";
  assert.match(message, /Loop every 5min: command/, "the command-owned summary is kept");
  assert.match(message, /2 scheduled tasks:/);
  assert.match(message, new RegExp(`${created.details.task.id} · \\[fixed\\] · every 10min`));
  assert.match(message, /\[fixed\] · primary · every 5min/);
  assert.match(message, /tool task/);

  // The tool mutation also refreshed the persistent widget.
  assert.match((ctx.lastWidget() ?? []).join("\n"), /tool task/);
  timers.advance(0);
  assert.deepEqual(pi.sent, [], "status is read-only");
});

test("schedule_self_paced_task creates independent tasks with distinct IDs and an immediate first run", async () => {
  const { timers, pi, registry } = setup();

  const a = await callTool<{ task: { id: string; mode: string; nextFireAt?: number } }>(
    pi,
    NAMES.scheduleSelfPaced,
    { prompt: "A" },
  );
  const b = await callTool<{ task: { id: string; mode: string }; fallbackDelayMs: number }>(
    pi,
    NAMES.scheduleSelfPaced,
    { prompt: "B", fallbackDelay: "5min" },
  );

  assert.equal(a.details.task.mode, "self-paced");
  assert.equal(a.details.task.nextFireAt, timers.clock, "the first run is due immediately");
  assert.notEqual(a.details.task.id, b.details.task.id, "each task gets a stable distinct ID");
  assert.equal(b.details.fallbackDelayMs, 5 * 60_000);
  assert.equal(registry.size, 2, "the second task never replaces the first");
  assert.equal(timers.pendingCount, 2, "each task arms its own immediate timer");

  const list = await callTool<{
    count: number;
    tasks: Array<{ id: string; mode: string; nextFireAt?: number }>;
  }>(pi, NAMES.listTasks, {});
  assert.equal(list.details.count, 2);
  assert.deepEqual(
    list.details.tasks.map((task) => task.id),
    [a.details.task.id, b.details.task.id],
    "creation order is preserved",
  );
  assert.deepEqual(list.details.tasks.map((task) => task.mode), ["self-paced", "self-paced"]);
});

test("two tool-created self-paced tasks run independently and schedule their own wakeups", async () => {
  const { timers, pi, ctx, registry } = setup();
  const a = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleSelfPaced, { prompt: "A" });
  const b = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleSelfPaced, { prompt: "B" });
  const aId = a.details.task.id;
  const bId = b.details.task.id;

  // Both first runs are due at once; the earlier registration executes and the
  // other is queued behind its turn.
  timers.advance(0);
  assert.deepEqual(pi.sent, ["A"]);
  assert.equal(registry.get(bId)?.pending, true, "B waits for the next idle boundary");

  const wakeA = await callTool<{ nextFireAt: number }>(
    pi,
    NAMES.scheduleWakeup,
    { delayMs: 2 * 60_000, reason: "A later" },
    ctx,
  );
  assert.equal(wakeA.details.nextFireAt, 2 * 60_000);
  assert.equal(registry.get(aId)?.nextFireAt, 2 * 60_000);
  assert.equal(registry.get(bId)?.nextFireAt, 0, "A's choice does not reschedule B");

  // The settle boundary releases A and flushes the queued B.
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["A", "B"]);

  const wakeB = await callTool<{ nextFireAt: number }>(
    pi,
    NAMES.scheduleWakeup,
    { delayMs: 10 * 60_000, reason: "B later" },
    ctx,
  );
  assert.equal(wakeB.details.nextFireAt, 10 * 60_000);
  assert.equal(registry.get(aId)?.nextFireAt, 2 * 60_000, "B's choice does not move A");

  // stop_wakeup ends only the iteration that invoked it; A survives untouched.
  const stopped = await callTool<{ id: string; prompt: string }>(pi, NAMES.stopWakeup, {}, ctx);
  assert.equal(stopped.details.id, bId);
  assert.equal(stopped.details.prompt, "B");
  assert.equal(registry.has(bId), false);
  assert.equal(registry.has(aId), true);

  // Release B's stale binding, then A's earlier wakeup still fires.
  pi.fire("agent_settled", ctx);
  timers.advance(2 * 60_000);
  assert.deepEqual(pi.sent, ["A", "B", "A"], "A's own wakeup is honoured after B is stopped");
});

test("a tool-created self-paced task coexists with the command-owned /loop", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "command paced", ctx);
  const tool = await callTool<{ task: { id: string } }>(
    pi,
    NAMES.scheduleSelfPaced,
    { prompt: "tool paced" },
    ctx,
  );
  assert.equal(registry.size, 2, "the tool task never replaces the command loop");

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Self-paced loop: command paced/);
  assert.match(ctx.lastNotification()?.message ?? "", /tool paced/);

  // Both are due now; the command loop was registered first and runs, and the
  // tool-created task is queued.
  timers.advance(0);
  assert.deepEqual(pi.sent, ["command paced"]);
  assert.equal(registry.get(tool.details.task.id)?.pending, true);

  // /loop stop cancels only the command-owned loop.
  await pi.run("loop", "stop", ctx);
  assert.equal(registry.has(tool.details.task.id), true, "the tool-created task survives");
  assert.equal(registry.size, 1);
});

test("schedule_wakeup and stop_wakeup fail closed outside an executing iteration", async () => {
  const { timers, pi, ctx, registry } = setup();

  // A command-owned self-paced loop exists, but its first iteration has not run.
  await pi.run("loop", "watch deploy", ctx);
  const id = registry.list()[0]!.id;
  const nextFireAt = registry.get(id)?.nextFireAt;

  await assert.rejects(
    callTool(pi, NAMES.scheduleWakeup, { delayMs: 60_000 }, ctx),
    (error: unknown) => error instanceof WakeupError && /no self-paced loop/.test(error.message),
  );
  await assert.rejects(
    callTool(pi, NAMES.stopWakeup, {}, ctx),
    (error: unknown) => error instanceof WakeupError && /no self-paced loop/.test(error.message),
  );
  assert.equal(registry.has(id), true, "the primary outside an iteration is untouched");
  assert.equal(registry.get(id)?.nextFireAt, nextFireAt, "it is not rescheduled");

  // Once the iteration executes, the tools are scoped to it.
  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"]);
  const stopped = await callTool<{ id: string }>(pi, NAMES.stopWakeup, {}, ctx);
  assert.equal(stopped.details.id, id);
  assert.equal(registry.has(id), false);
});

test("delete_scheduled_task cancels an independent self-paced task outside an iteration", async () => {
  const { timers, pi, registry } = setup();
  const a = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleSelfPaced, { prompt: "A" });
  const b = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleSelfPaced, { prompt: "B" });

  await callTool(pi, NAMES.deleteTask, { id: a.details.task.id });
  assert.equal(registry.has(a.details.task.id), false);
  assert.equal(registry.has(b.details.task.id), true, "the other self-paced task is untouched");
  assert.equal(timers.pendingCount, 1, "only the deleted task's timer is cleared");

  timers.advance(0);
  assert.deepEqual(pi.sent, ["B"], "the deleted task never runs");
});

test("a tool-created self-paced fallback delay is validated and clamped like /loop", async () => {
  const { timers, pi, ctx, registry } = setup();

  await assert.rejects(
    callTool(pi, NAMES.scheduleSelfPaced, { prompt: "   " }),
    /prompt must be a non-empty string/,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleSelfPaced, { prompt: "/loop stop" }),
    (error: unknown) => error instanceof ScheduledPromptRejectedError,
  );
  await assert.rejects(
    callTool(pi, NAMES.scheduleSelfPaced, { prompt: "ok", fallbackDelay: "5x" }),
    (error: unknown) => error instanceof IntervalError && /unknown interval unit/.test(error.message),
  );
  assert.equal(registry.size, 0, "no invalid self-paced task is registered");
  assert.equal(timers.pendingCount, 0, "no timer is armed for a rejected task");

  const clampedUp = await callTool<{ fallbackDelayMs: number; fallbackClamped: boolean }>(
    pi,
    NAMES.scheduleSelfPaced,
    { prompt: "short", fallbackDelay: "30s" },
  );
  assert.equal(clampedUp.details.fallbackDelayMs, 60_000, "below the floor clamps up to 1min");
  assert.equal(clampedUp.details.fallbackClamped, true);

  const clampedDown = await callTool<{ fallbackDelayMs: number; fallbackClamped: boolean }>(
    pi,
    NAMES.scheduleSelfPaced,
    { prompt: "long", fallbackDelay: "2h" },
  );
  assert.equal(clampedDown.details.fallbackDelayMs, 60 * 60_000, "above the ceiling clamps down to 1h");
  assert.equal(clampedDown.details.fallbackClamped, true);

  // The clamp reaches the scheduler: the fallback granted after a missed choice
  // uses the clamped delay, not the requested one.
  timers.advance(0);
  assert.deepEqual(pi.sent, ["short"], "the earlier registration runs first");
  pi.fire("agent_settled", ctx);
  assert.equal(
    registry.get(registry.list()[0]!.id)?.nextFireAt,
    timers.clock + 60_000,
    "the 30s fallback is clamped up to 1min",
  );
});

test("schedule_self_paced_task shares the active-task limit", async () => {
  const { pi, registry } = setup({ registry: testRegistry(new FakeTimers(), { maxTasks: 1 }) });

  await callTool(pi, NAMES.scheduleSelfPaced, { prompt: "first" });
  await assert.rejects(
    callTool(pi, NAMES.scheduleSelfPaced, { prompt: "second" }),
    (error: unknown) => error instanceof TaskLimitError,
  );
  assert.equal(registry.size, 1);
});

test("independent self-paced tasks coexist with fixed, cron, and one-shot tasks", async () => {
  const { timers, pi, registry } = setup();
  const fixed = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleTask, {
    interval: "5min",
    prompt: "fixed",
  });
  const cron = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleCronTask, {
    cron: "*/5 * * * *",
    prompt: "cron",
    timeZone: "UTC",
  });
  const once = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleOnceTask, {
    delay: "30min",
    prompt: "once",
  });
  const paced = await callTool<{ task: { id: string } }>(pi, NAMES.scheduleSelfPaced, {
    prompt: "paced",
  });

  assert.equal(registry.size, 4);
  const list = await callTool<{ tasks: Array<{ id: string; mode: string }> }>(pi, NAMES.listTasks, {});
  assert.deepEqual(
    list.details.tasks.map((task) => task.mode),
    ["fixed", "fixed", "one-shot", "self-paced"],
  );

  // Only the self-paced task is due immediately; the others wait for a boundary.
  timers.advance(0);
  assert.deepEqual(pi.sent, ["paced"]);

  // The self-paced task can be cancelled while the others stay scheduled.
  await callTool(pi, NAMES.deleteTask, { id: paced.details.task.id });
  assert.equal(registry.has(fixed.details.task.id), true);
  assert.equal(registry.has(cron.details.task.id), true);
  assert.equal(registry.has(once.details.task.id), true);

  timers.advance(5 * 60_000);
  assert.ok(pi.sent.includes("fixed"), "the fixed task still fires");
  assert.ok(pi.sent.includes("cron"), "the cron task still fires");
});
