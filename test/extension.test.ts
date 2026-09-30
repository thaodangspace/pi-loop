import assert from "node:assert/strict";
import test from "node:test";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import { BUILT_IN_MAINTENANCE_PROMPT } from "../src/maintenance.ts";
import { createTaskEvent, PERSISTENCE_CUSTOM_TYPE } from "../src/persistence.ts";
import { formatClockTime } from "../src/status.ts";
import {
  configReader,
  FakeCtx,
  FakePi,
  FakeTimers,
  maintenanceReader,
  missingFile,
  testRegistry,
} from "./helpers.ts";

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

/** Invoke a registered scheduler tool the way Pi would. */
function callTool(pi: FakePi, name: string, params: unknown, ctx: FakeCtx): Promise<unknown> {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool.execute("call-1", params as never, undefined, undefined, ctx as never) as Promise<unknown>;
}

test("a self-paced loop reports its state and can be stopped", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "watch deploy", ctx);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"]);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Self-paced loop: watch deploy/);
  assert.match(ctx.lastNotification()?.message ?? "", /waiting for the next wakeup/);

  await pi.run("loop", "stop", ctx);
  assert.equal(ctx.lastNotification()?.message, "Loop stopped.");
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["watch deploy"], "a stopped self-paced loop has no future wakeups");
});

test("a bare task starts a self-paced loop with an immediate first run", async () => {
  const { readFile, reads } = configReader('{"defaultInterval":"2min"}');
  const { timers, pi, ctx, registry } = setup({ readFile });

  await pi.run("loop", "check things", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Self-paced loop: check things/);
  assert.match(ctx.lastNotification()?.message ?? "", /fallback wakeup in 2min/);
  assert.equal(reads(), 1, "the fallback delay comes from the configured default");

  const [task] = registry.list();
  assert.ok(task, "starting a self-paced loop registers a task");
  assert.equal(task.mode, "self-paced");
  assert.equal(task.nextFireAt, 0, "the first run is due immediately, not on a cadence boundary");

  assert.deepEqual(pi.sent, []);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["check things"]);
  assert.equal(timers.pendingCount, 0, "no timer is armed until the iteration chooses its next wakeup");
});

test("a missing config file gives the self-paced loop a 1min fallback", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "cheap check", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /fallback wakeup in 1min/);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["cheap check"]);

  // The iteration never reschedules: one fallback wakeup, then termination.
  pi.fire("agent_settled", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /fallback wakeup scheduled in 1min/);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["cheap check", "cheap check"]);

  pi.fire("agent_settled", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /stopped after a repeated missing wakeup/);
  assert.equal(registry.size, 0, "a repeated miss removes the task");
  assert.equal(timers.pendingCount, 0);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["cheap check", "cheap check"], "the terminated loop never runs again");
});

test("a sub-minute fallback from config is clamped to the minute minimum", async () => {
  const { readFile } = configReader('{"defaultInterval":"30s"}');
  const { timers, pi, ctx } = setup({ readFile });

  await pi.run("loop", "cheap check", ctx);
  assert.match(
    ctx.lastNotification()?.message ?? "",
    /fallback wakeup in 1min \(normalized from 30s\)/,
  );

  timers.advance(0);
  assert.deepEqual(pi.sent, ["cheap check"]);
  pi.fire("agent_settled", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /scheduled in 1min/);
});

test("an invalid config reports an error and starts nothing", async () => {
  const { timers, pi, ctx } = setup({ readFile: async () => "{ not json" });

  await pi.run("loop", "check things", ctx);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /Loop config error/);

  await pi.run("loop", "status", ctx);
  assert.equal(ctx.lastNotification()?.message, "No loop is running.");
  timers.advance(120_000);
  assert.deepEqual(pi.sent, []);
  assert.equal(timers.pendingCount, 0);
});

test("an explicit interval overrides the config without reading it", async () => {
  const { readFile, reads } = configReader('{"defaultInterval":"2min"}');
  const { timers, pi, ctx } = setup({ readFile });

  await pi.run("loop", "every 5min ping services", ctx);
  assert.equal(reads(), 0, "the explicit-interval path must not read config");
  assert.match(ctx.lastNotification()?.message ?? "", /every 5min: ping services/);

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["ping services"]);
});

test("an explicit sub-minute interval is normalized to the minute cadence", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 30s ping services", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min \(normalized from 30s\): ping services/);

  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["ping services"]);
});

test("usage errors leave a running loop untouched", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min keepalive", ctx);
  await pi.run("loop", "5x keepalive", ctx);
  assert.equal(ctx.lastNotification()?.type, "warning");
  assert.match(ctx.lastNotification()?.message ?? "", /Usage error/);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min: keepalive/);

  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["keepalive"]);
});

test("malformed interval syntax leaves existing scheduled work unchanged", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min keepalive", ctx);
  await pi.run("loop", "10min check deploy", ctx); // valid: replaces the loop
  assert.match(ctx.lastNotification()?.message ?? "", /every 10min: check deploy/);

  await pi.run("loop", "5x check deploy", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Usage error/);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 10min: check deploy/);

  timers.advance(600_000);
  assert.deepEqual(pi.sent, ["check deploy"]);
});

test("Claude-style interval before the task starts a fixed loop", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "5min check deploy", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 5min: check deploy/);
  assert.deepEqual(pi.sent, [], "the first run must not be immediate");
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["check deploy"]);
});

test("a trailing every clause sets the interval", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "check deploy every 5min", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 5min: check deploy/);
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["check deploy"]);
});

test("a day interval is accepted and reported", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "2d daily report", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 2d: daily report/);
  timers.advance(2 * 86_400_000);
  assert.deepEqual(pi.sent, ["daily report"]);
});

test("bare /loop starts a self-paced maintenance loop that sends the built-in prompt", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Maintenance loop \(self-paced\)/);
  const [task] = registry.list();
  assert.equal(task?.mode, "self-paced");
  assert.equal(task?.maintenance, true, "the task is marked as a maintenance loop");

  assert.deepEqual(pi.sent, [], "the first maintenance run is due immediately, not synchronously");
  timers.advance(0);
  assert.deepEqual(pi.sent, [BUILT_IN_MAINTENANCE_PROMPT]);
});

test("/loop <interval> starts a fixed maintenance loop on the cadence", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "5min", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Maintenance loop every 5min/);
  const [task] = registry.list();
  assert.equal(task?.mode, "fixed");
  assert.equal(task?.maintenance, true);

  assert.deepEqual(pi.sent, []);
  timers.advance(299_999);
  assert.deepEqual(pi.sent, [], "a fixed maintenance loop waits for the next boundary");
  timers.advance(1);
  assert.deepEqual(pi.sent, [BUILT_IN_MAINTENANCE_PROMPT]);
});

test("a project .claude/loop.md overrides the user file and the built-in prompt", async () => {
  const files = maintenanceReader({
    "/proj/.claude/loop.md": "project maintenance instructions",
    "/home/me/.claude/loop.md": "user maintenance instructions",
  });
  const { timers, pi, ctx } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile: files.readFile },
  });

  await pi.run("loop", "5min", ctx);
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["project maintenance instructions"]);
  assert.deepEqual(files.reads, ["/proj/.claude/loop.md"], "the project file wins before the user file is read");
});

test("the user loop.md applies when the project has none", async () => {
  const files = maintenanceReader({ "/home/me/.claude/loop.md": "user maintenance instructions" });
  const { timers, pi, ctx } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile: files.readFile },
  });

  await pi.run("loop", "5min", ctx);
  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["user maintenance instructions"]);
});

test("an unreadable project loop.md is reported and never silently substituted", async () => {
  const reads: string[] = [];
  const readFile = (filePath: string): string => {
    reads.push(filePath);
    if (filePath === "/proj/.claude/loop.md") {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return "user maintenance instructions";
  };
  const { timers, pi, ctx } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile },
  });

  await pi.run("loop", "5min", ctx);
  timers.advance(300_000);

  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(
    ctx.lastNotification()?.message ?? "",
    /Maintenance prompt error: could not read \/proj\/\.claude\/loop\.md/,
  );
  assert.deepEqual(pi.sent, [], "the built-in and user prompts must not be substituted");
  assert.deepEqual(reads, ["/proj/.claude/loop.md"], "an unreadable project file stops resolution");
});

test("an unreadable loop.md on a self-paced maintenance run falls back instead of stalling", async () => {
  const readFile = (): string => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  };
  const { timers, pi, ctx, registry } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile },
  });

  await pi.run("loop", "", ctx);
  timers.advance(0);

  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /Maintenance prompt error/);
  assert.deepEqual(pi.sent, [], "no prompt is sent when resolution fails");
  assert.equal(registry.size, 1, "the loop stays active for the bounded retry");
  assert.equal(timers.pendingCount, 1, "a fallback wakeup is armed so the loop cannot stall");
});

test("a custom prompt loop never reads loop.md", async () => {
  const files = maintenanceReader({ "/proj/.claude/loop.md": "should not be used" });
  const { timers, pi, ctx } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile: files.readFile },
  });

  await pi.run("loop", "every 1min custom task", ctx);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["custom task"]);
  assert.deepEqual(files.reads, [], "custom prompts are isolated from the maintenance files");

  await pi.run("loop", "watch deploy", ctx);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["custom task", "watch deploy"]);
  assert.deepEqual(files.reads, [], "a self-paced custom prompt is isolated too");
});

test("edits to loop.md take effect on the next maintenance iteration", async () => {
  let contents = "first maintenance instructions";
  const readFile = (filePath: string): string => {
    if (filePath === "/proj/.claude/loop.md") {
      return contents;
    }
    throw missingFile();
  };
  const { timers, pi, ctx } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile },
  });

  await pi.run("loop", "1min", ctx);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["first maintenance instructions"]);

  contents = "second maintenance instructions";
  timers.advance(60_000);
  assert.deepEqual(
    pi.sent,
    ["first maintenance instructions", "second maintenance instructions"],
    "the next run re-resolves the file without a restart",
  );
});

test("a maintenance loop coalesces while busy and reports its status", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "1min", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  assert.deepEqual(pi.sent, [], "a busy maintenance tick must not interrupt the agent");

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Maintenance loop every 1min/);
  assert.match(ctx.lastNotification()?.message ?? "", /queued/);

  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, [BUILT_IN_MAINTENANCE_PROMPT]);
});

test("a self-paced maintenance loop uses the bounded fallback and then terminates", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "", ctx);
  timers.advance(0);
  assert.deepEqual(pi.sent, [BUILT_IN_MAINTENANCE_PROMPT]);

  pi.fire("agent_settled", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /fallback wakeup scheduled/);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, [BUILT_IN_MAINTENANCE_PROMPT, BUILT_IN_MAINTENANCE_PROMPT]);

  pi.fire("agent_settled", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /stopped after a repeated missing wakeup/);
  assert.equal(registry.size, 0);
});

test("stop cancels the timer, drops pending work, and reports state", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min ping", ctx);
  await pi.run("loop", "stop", ctx);
  assert.equal(ctx.lastNotification()?.message, "Loop stopped.");
  assert.equal(timers.pendingCount, 0);

  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, []);

  await pi.run("loop", "stop", ctx);
  assert.equal(ctx.lastNotification()?.message, "No loop is running.");
});

test("creating a new loop replaces the previous one on the same boundary grid", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min first", ctx);
  timers.advance(30_000);
  await pi.run("loop", "every 1min second", ctx);
  timers.advance(29_999);
  assert.deepEqual(pi.sent, [], "the replacement still fires at the cadence boundary");

  timers.advance(1);
  assert.deepEqual(pi.sent, ["second"]);
  assert.equal(timers.pendingCount, 1);
});

test("busy ticks coalesce and flush once the agent settles", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min poll", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, [], "busy ticks must not interrupt the agent");

  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["poll"]);

  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["poll"], "a settled event with no pending run is a no-op");
  assert.equal(timers.pendingCount, 1);
});

test("a send failure is swallowed by Pi's fire-and-forget surface", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min risky", ctx);
  const notificationsBefore = ctx.notifications.length;

  pi.sendError = new Error("send failed");
  timers.advance(60_000);
  assert.deepEqual(pi.sent, [], "a failed send delivers nothing");
  assert.equal(pi.sendErrors.length, 1, "the fake records the internal failure the way Pi does");
  assert.equal(
    ctx.notifications.length,
    notificationsBefore,
    "the scheduler cannot observe a failure Pi catches internally",
  );

  // Like real Pi, the run is not retried: the boundary has advanced and the next
  // one runs normally.
  pi.sendError = undefined;
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["risky"]);
});

test("the fake sendUserMessage matches Pi's void fire-and-forget signature", () => {
  const pi = new FakePi();
  assert.equal(pi.sendUserMessage("hello"), undefined);
});

test("session shutdown stops the timer and clears pending work", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "every 1min ping", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  assert.equal(registry.size, 1);
  pi.fire("session_shutdown");

  assert.equal(timers.pendingCount, 0);
  assert.equal(registry.size, 0, "shutdown drops every task");
  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, []);
});

test("each extension instance keeps its own timer and state", async () => {
  const a = setup();
  const b = setup();

  await a.pi.run("loop", "every 1min taskA", a.ctx);
  await b.pi.run("loop", "every 1min taskB", b.ctx);

  assert.equal(a.registry.size, 1);
  assert.equal(b.registry.size, 1);
  assert.notEqual(a.registry, b.registry, "each session gets its own registry");
  assert.equal(a.registry.list()[0]!.prompt, "taskA");
  assert.equal(b.registry.list()[0]!.prompt, "taskB");

  a.timers.advance(60_000);
  assert.deepEqual(a.pi.sent, ["taskA"]);
  assert.deepEqual(b.pi.sent, [], "one session's tick must not dispatch another session's task");

  b.timers.advance(60_000);
  assert.deepEqual(b.pi.sent, ["taskB"]);

  // Mutating one session's registry must not touch the other.
  a.registry.clear();
  assert.equal(a.registry.size, 0);
  assert.equal(b.registry.size, 1, "one session's cleanup leaves the other intact");
});

test("creating the extension allocates no timers or tasks at load time", () => {
  const { timers, registry } = setup();
  assert.equal(timers.pendingCount, 0, "no timer is created at factory load");
  assert.equal(registry.size, 0, "no task is created at factory load");
});

test("the active loop is represented as one fixed registry task", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "every 5min check deploy", ctx);
  const [task] = registry.list();
  assert.ok(task, "starting a loop registers a task");
  assert.equal(task.mode, "fixed");
  assert.equal(task.prompt, "check deploy");
  assert.deepEqual(task.schedule, { intervalMs: 300_000, anchor: 0 });
  assert.equal(task.nextFireAt, 300_000);

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["check deploy"]);
  assert.equal(registry.get(task.id)?.id, task.id, "the ID is stable while the loop runs");
  assert.equal(registry.get(task.id)?.nextFireAt, 600_000);

  await pi.run("loop", "stop", ctx);
  assert.equal(registry.size, 0, "stopping removes the task");
});

test("status reports a pending run and clears it after flush", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min ping", ctx);
  ctx.idle = false;
  timers.advance(60_000);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /queued for the next idle moment/);

  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  await pi.run("loop", "status", ctx);
  assert.doesNotMatch(ctx.lastNotification()?.message ?? "", /queued/);
});

// ---------------------------------------------------------------------------
// Persistent status / widget
// ---------------------------------------------------------------------------

test("the persistent footer and widget show the loop count and local next time", async () => {
  const { pi, ctx, registry } = setup();

  await pi.run("loop", "every 5min check deploy", ctx);
  const [task] = registry.list();
  assert.ok(task?.nextFireAt !== undefined);
  assert.match(ctx.lastStatus() ?? "", /^⟳ 1 loop · next \d{2}:\d{2}$/);
  assert.equal(
    ctx.lastStatus(),
    `⟳ 1 loop · next ${formatClockTime(task.nextFireAt)}`,
    "the footer shows the earliest next fire as local clock time",
  );

  const widget = ctx.lastWidget();
  assert.ok(widget && widget.length === 1, "one widget line per task");
  assert.match(widget[0]!, /\[fixed\]/);
  assert.match(widget[0]!, /every 5min/);
  assert.match(widget[0]!, /check deploy/);
});

test("the footer aggregates mixed task modes and clears when the last task goes", async () => {
  const { pi, ctx, registry } = setup();

  // A self-paced command loop coexists with independent tool-created tasks.
  await pi.run("loop", "watch deploy", ctx);
  await callTool(pi, "schedule_task", { interval: "5min", prompt: "poll" }, ctx);
  await callTool(pi, "schedule_once_task", { delay: "10min", prompt: "once" }, ctx);

  assert.equal(
    ctx.lastStatus(),
    `⟳ 3 loops · 1 fixed · 1 self-paced · 1 one-shot · next ${formatClockTime(0)}`,
    "the footer stays one line and counts every mode",
  );

  const [selfPaced] = registry.list().filter((item) => item.mode === "self-paced");
  await callTool(pi, "delete_scheduled_task", { id: selfPaced!.id }, ctx);
  assert.match(ctx.lastStatus() ?? "", /^⟳ 2 loops · 1 fixed · 1 one-shot · next \d{2}:\d{2}$/);

  for (const item of registry.list()) {
    await callTool(pi, "delete_scheduled_task", { id: item.id }, ctx);
  }
  assert.equal(ctx.lastStatus(), undefined, "no tasks leaves no footer");
});

test("the footer clears when a task expires", async () => {
  const { timers, pi, ctx } = setup();

  // Establish a session context the way Pi does before tools can run.
  pi.fire("session_start", ctx);
  await callTool(pi, "schedule_task", { interval: "1min", prompt: "shortlived", expiresIn: "1min" }, ctx);
  assert.match(ctx.lastStatus() ?? "", /^⟳ 1 loop · next \d{2}:\d{2}$/);

  timers.advance(60_000);
  assert.equal(ctx.lastStatus(), undefined, "an expired task leaves no footer");
});

test("the footer includes a pending run without adding a line", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min poll", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  assert.match(ctx.lastStatus() ?? "", /^⟳ 1 loop · next \d{2}:\d{2}$/, "a queued run stays one line");
  assert.doesNotMatch(ctx.lastStatus() ?? "", /\n/, "the footer is single-line");
});

test("restoring a branch repaints the footer and branch navigation clears it", () => {
  const { pi } = setup();
  const branch = [
    {
      type: "custom",
      customType: PERSISTENCE_CUSTOM_TYPE,
      data: createTaskEvent({
        id: "t1",
        prompt: "persisted",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
        nextFireAt: 60_000,
      }),
    },
  ];

  const restored = new FakeCtx();
  restored.branch = branch;
  pi.fire("session_start", restored);
  assert.equal(
    restored.lastStatus(),
    `⟳ 1 loop · next ${formatClockTime(60_000)}`,
    "a restored session reconstructs the footer from restored state",
  );

  // Navigating to a branch without the entry must drop the stale footer.
  const nav = new FakeCtx();
  nav.branch = [];
  pi.fire("session_tree", nav);
  assert.equal(nav.lastStatus(), undefined, "the footer reflects the entered branch immediately");
});

test("the widget updates when a busy tick queues a run and clears after flush", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min poll", ctx);
  ctx.idle = false;
  timers.advance(60_000);
  assert.match((ctx.lastWidget() ?? []).join("\n"), /pending/, "the tick repaints with the queued run");

  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.doesNotMatch((ctx.lastWidget() ?? []).join("\n"), /pending/);
});

test("stopping the loop clears the persistent status and widget", async () => {
  const { pi, ctx } = setup();

  await pi.run("loop", "every 5min ping", ctx);
  assert.notEqual(ctx.lastStatus(), undefined);

  await pi.run("loop", "stop", ctx);
  assert.equal(ctx.lastStatus(), undefined);
  assert.equal(ctx.lastWidget(), undefined);
});

test("session shutdown clears the persistent status and widget", async () => {
  const { pi, ctx } = setup();

  await pi.run("loop", "every 5min ping", ctx);
  pi.fire("session_shutdown", ctx);
  assert.equal(ctx.lastStatus(), undefined);
  assert.equal(ctx.lastWidget(), undefined);
});

test("a non-UI mode is never painted", async () => {
  const { pi, ctx } = setup();

  ctx.hasUI = false;
  ctx.mode = "json";
  await pi.run("loop", "every 5min ping", ctx);
  assert.equal(ctx.statuses.length, 0);
  assert.equal(ctx.widgets.length, 0);
});

// ---------------------------------------------------------------------------
// Disable switch
// ---------------------------------------------------------------------------

test("the disable switch registers no tools and starts no timers", async () => {
  const { timers, pi, ctx, registry } = setup({ disabled: true });

  assert.equal(pi.tools.size, 0, "no model scheduling tool is registered");

  await pi.run("loop", "every 1min ping", ctx);
  assert.equal(ctx.lastNotification()?.type, "warning");
  assert.match(ctx.lastNotification()?.message ?? "", /disabled/);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /disabled/);

  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, []);
});

test("the disable switch does not restore persisted tasks", () => {
  const { timers, pi, registry } = setup({ disabled: true });
  const ctx = new FakeCtx();
  ctx.branch = [
    {
      type: "custom",
      customType: PERSISTENCE_CUSTOM_TYPE,
      data: createTaskEvent({
        id: "t1",
        prompt: "persisted",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
        nextFireAt: 60_000,
      }),
    },
  ];

  pi.fire("session_start", ctx);
  assert.equal(registry.size, 0, "nothing is restored when disabled");
  assert.equal(timers.pendingCount, 0, "no timer is armed when disabled");
});

test("enabling by default still registers tools and restores", () => {
  const { pi, registry } = setup({ disabled: false });
  assert.equal(pi.tools.size, 7, "the seven scheduling tools are registered");
  const ctx = new FakeCtx();
  ctx.branch = [
    {
      type: "custom",
      customType: PERSISTENCE_CUSTOM_TYPE,
      data: createTaskEvent({
        id: "t1",
        prompt: "persisted",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
        nextFireAt: 60_000,
      }),
    },
  ];
  pi.fire("session_start", ctx);
  assert.equal(registry.has("t1"), true, "restoration keeps working when enabled");
});
