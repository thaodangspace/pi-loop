import assert from "node:assert/strict";
import test from "node:test";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import { configReader, FakeCtx, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

function setup(overrides: Partial<LoopExtensionDeps> = {}) {
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
    ...overrides,
    registry,
  });
  return { timers, pi, ctx, registry };
}

test("a bare task uses the configured default and runs at the next boundary", async () => {
  const { readFile, reads } = configReader('{"defaultInterval":"2min"}');
  const { timers, pi, ctx } = setup({ readFile });

  await pi.run("loop", "check things", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 2min: check things/);
  assert.equal(reads(), 1);

  assert.deepEqual(pi.sent, [], "the first run must not be immediate");
  timers.advance(119_999);
  assert.deepEqual(pi.sent, []);
  timers.advance(1);
  assert.deepEqual(pi.sent, ["check things"]);
});

test("a missing config file falls back to 1min", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "cheap check", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min/);
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["cheap check"]);
});

test("a sub-minute default from config is normalized and reported", async () => {
  const { readFile } = configReader('{"defaultInterval":"30s"}');
  const { timers, pi, ctx } = setup({ readFile });

  await pi.run("loop", "cheap check", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min \(normalized from 30s\): cheap check/);

  timers.advance(59_999);
  assert.deepEqual(pi.sent, []);
  timers.advance(1);
  assert.deepEqual(pi.sent, ["cheap check"]);
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

test("maintenance forms warn and leave a running loop untouched", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min keepalive", ctx);
  await pi.run("loop", "5min", ctx);
  assert.equal(ctx.lastNotification()?.type, "warning");
  assert.match(ctx.lastNotification()?.message ?? "", /Maintenance/);

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min: keepalive/);

  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["keepalive"]);
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

test("a dispatch failure notifies and retries only at a safe point", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min risky", ctx);
  pi.sendError = new Error("send failed");
  timers.advance(60_000);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /failed to send: send failed/);
  assert.deepEqual(pi.sent, []);

  pi.sendError = undefined;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["risky"], "the retained run is delivered at the next idle point");
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
