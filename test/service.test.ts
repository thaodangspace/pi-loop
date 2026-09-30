/**
 * Integration tests for the public, versioned extension-to-extension service.
 *
 * These exercise the real extension wiring (command + tools + service on one
 * scheduler/registry) through the fake Pi harness, plus the provider/discovery
 * protocol in isolation. They cover consumer discovery, load order, multiple
 * session isolation, dispose/reconstruction invalidation, shared-registry
 * coherence, explicit task-ID operations, and the documented error/result
 * shapes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import {
  discoverLoopService,
  isLoopServiceV1,
  LOOP_SERVICE_CHANGED_CHANNEL,
  LOOP_SERVICE_VERSION,
  LoopServiceUnavailableError,
  onLoopServiceChange,
  type LoopServiceV1,
  type LoopTaskSummary,
} from "../src/service.ts";
import { createLoopServiceProvider, type LoopServiceBackend } from "../src/service-provider.ts";
import { WakeupError } from "../src/loop-core.ts";
import { PERSISTENCE_CUSTOM_TYPE } from "../src/persistence.ts";
import { FakeCtx, FakeEventBus, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

function setup(overrides: Partial<LoopExtensionDeps> = {}) {
  const { maintenance, ...rest } = overrides;
  const timers = new FakeTimers();
  const pi = new FakePi();
  const ctx = new FakeCtx();
  const registry = overrides.registry ?? testRegistry(timers);
  createLoopExtension(pi.asExtensionApi(), {
    configPath: "/tmp/loop.json",
    timers,
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

async function discover(pi: FakePi, ctx: FakeCtx, options?: { timeoutMs?: number }) {
  pi.fire("session_start", ctx);
  return discoverLoopService(pi.events, options);
}

function expectService(result: Awaited<ReturnType<typeof discoverLoopService>>): LoopServiceV1 {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.service;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("a consumer discovers the active service for the current session", async () => {
  const { pi, ctx } = setup();
  const service = expectService(await discover(pi, ctx));

  assert.equal(service.version, LOOP_SERVICE_VERSION);
  assert.equal(service.isAvailable(), true);
  assert.equal(typeof service.sessionId, "string");
  assert.equal(isLoopServiceV1(service), true, "the handle satisfies the public type guard");
});

test("no provider means discovery reports a timeout, not a crash", async () => {
  const bus = new FakeEventBus();
  const result = await discoverLoopService(bus, { timeoutMs: 0 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "timeout");
  }
});

test("a disabled pi-loop is detectable and reports why", async () => {
  const { pi, ctx } = setup({ disabled: true });
  // Disabled registers no scheduling tools but still answers discovery.
  assert.equal(pi.tools.size, 0);

  pi.fire("session_start", ctx);
  const result = await discoverLoopService(pi.events, { timeoutMs: 0 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "unavailable");
    assert.match(result.message, /disabled/);
  }
});

test("discovery before a session starts reports 'unavailable', then succeeds", async () => {
  const { pi, ctx } = setup();
  // The extension is loaded, but no session has started yet.
  const before = await discoverLoopService(pi.events, { timeoutMs: 0 });
  assert.equal(before.ok, false);
  if (!before.ok) {
    assert.equal(before.reason, "unavailable");
    assert.match(before.message, /no active Pi session/);
  }

  pi.fire("session_start", ctx);
  const after = await discoverLoopService(pi.events, { timeoutMs: 0 });
  assert.equal(after.ok, true);
});

test("load order is handled by watching the availability channel", async () => {
  const { pi, ctx } = setup();
  const seen: string[] = [];
  const stop = onLoopServiceChange(pi.events, (status) => {
    seen.push(status.available ? status.sessionId : `unavailable:${status.reason}`);
  });

  // Watcher registered before the session starts sees the transition.
  pi.fire("session_start", ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], expectService(await discoverLoopService(pi.events)).sessionId);

  stop();
  pi.fire("session_start", ctx);
  assert.equal(seen.length, 1, "unsubscribing stops delivery");
  assert.ok(pi.events.channels().includes(LOOP_SERVICE_CHANGED_CHANNEL));
});

// ---------------------------------------------------------------------------
// Shared authoritative scheduler / registry
// ---------------------------------------------------------------------------

test("a service-created task appears through list_scheduled_tasks and /loop status", async () => {
  const { timers, pi, ctx, registry } = setup();
  const service = expectService(await discover(pi, ctx));

  const summary = service.scheduleFixed(60_000, "from extension");
  assert.equal(summary.mode, "fixed");
  assert.equal(summary.intervalMs, 60_000);
  assert.equal(summary.pending, false);
  assert.equal(Object.isFrozen(summary), true, "summaries are frozen snapshots");
  assert.deepEqual(summary, JSON.parse(JSON.stringify(summary)), "summaries are serializable");

  // Same authoritative registry as the tools and command.
  assert.equal(registry.get(summary.id)?.prompt, "from extension");
  const listed = (await callTool(pi, "list_scheduled_tasks", {}, ctx)) as {
    details: { tasks: LoopTaskSummary[] };
  };
  assert.deepEqual(
    listed.details.tasks.map((task) => task.id),
    [summary.id],
  );

  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", new RegExp(summary.id));

  // Same timer machinery: the run is delivered on the cadence.
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["from extension"]);
});

test("a task created by a tool is visible to the service and vice versa", async () => {
  const { pi, ctx } = setup();
  const service = expectService(await discover(pi, ctx));

  const viaTool = (await callTool(pi, "schedule_task", { interval: "5min", prompt: "tool task" }, ctx)) as {
    details: { task: LoopTaskSummary };
  };
  const viaService = service.scheduleCron("0 9 * * 1-5", "service task", { timeZone: "UTC" });

  const ids = service.listTasks().map((task) => task.id).sort();
  assert.deepEqual(ids, [viaTool.details.task.id, viaService.id].sort());
  assert.equal(viaService.cron, "0 9 * * 1-5");
  assert.equal(viaService.timeZone, "UTC");
});

test("deleting through the service removes the same authoritative task", async () => {
  const { timers, pi, ctx, registry } = setup();
  const service = expectService(await discover(pi, ctx));

  const viaTool = (await callTool(pi, "schedule_task", { interval: "1min", prompt: "tool task" }, ctx)) as {
    details: { task: LoopTaskSummary };
  };
  assert.equal(registry.has(viaTool.details.task.id), true);

  assert.equal(service.deleteTask(viaTool.details.task.id), true);
  assert.equal(registry.has(viaTool.details.task.id), false, "the authoritative registry no longer holds it");
  assert.equal(timers.pendingCount, 0, "its timer is cancelled");
  assert.deepEqual(service.listTasks(), []);

  // Unknown IDs are a predictable false, not a crash.
  assert.equal(service.deleteTask("does-not-exist"), false);
});

test("a consumer creates an independent self-paced task alongside the command loop", async () => {
  const { timers, pi, ctx, registry } = setup();
  const service = expectService(await discover(pi, ctx));

  await pi.run("loop", "every 5min command task", ctx);
  const commandLoop = registry.list()[0]!;

  const paced = service.scheduleSelfPaced("service self-paced");
  assert.equal(paced.mode, "self-paced");
  assert.equal(registry.size, 2, "the command loop survives; tasks coexist");
  assert.equal(registry.get(commandLoop.id)?.prompt, "command task");

  // Stopping the service task leaves the command-owned loop untouched.
  assert.equal(service.stopTask(paced.id), true);
  assert.equal(registry.has(paced.id), false);
  assert.equal(registry.get(commandLoop.id)?.prompt, "command task");

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["command task"]);
});

test("a service-created fixed task is persisted and restored under the same ID", async () => {
  const { pi, ctx, registry } = setup();
  const service = expectService(await discover(pi, ctx));

  const summary = service.scheduleFixed(60_000, "durable task");
  // Persisted through the same Pi session-custom-entry sink as the command/tools.
  assert.equal(pi.appended.length, 1);
  assert.equal(pi.appended[0]!.customType, PERSISTENCE_CUSTOM_TYPE);

  // Reconstruct a fresh session from that branch, the way Pi resumes.
  const resumed = new FakeCtx();
  resumed.branch = pi.appended.map((entry) => ({
    type: "custom",
    customType: entry.customType,
    data: entry.data,
  }));
  pi.fire("session_start", resumed);

  assert.equal(registry.has(summary.id), true, "restored under the same stable ID");
  assert.equal(registry.get(summary.id)?.prompt, "durable task");
});

// ---------------------------------------------------------------------------
// Explicit task-ID operations
// ---------------------------------------------------------------------------

test("explicit task-ID wakeup reschedules only the named self-paced task", async () => {
  const { timers, pi, ctx, registry } = setup();
  const service = expectService(await discover(pi, ctx));

  const paced = service.scheduleSelfPaced("pace me");
  assert.equal(timers.pendingCount, 1, "the first run is armed immediately");

  const decision = service.scheduleTaskWakeup(paced.id, 30_000, "wait a bit");
  assert.equal(decision.requestedMs, 30_000);
  assert.equal(decision.delayMs, 60_000, "the delay clamps up to the 1 minute minimum");
  assert.equal(decision.clamped, true);
  assert.equal(decision.reason, "wait a bit");
  assert.equal(registry.get(paced.id)?.reason, "wait a bit");

  timers.advance(59_999);
  assert.deepEqual(pi.sent, [], "the wakeup waits for the clamped delay");
  timers.advance(1);
  assert.deepEqual(pi.sent, ["pace me"]);
});

test("explicit operations fail predictably for unknown or non-self-paced IDs", async () => {
  const { pi, ctx } = setup();
  const service = expectService(await discover(pi, ctx));

  assert.throws(() => service.scheduleTaskWakeup("nope", 60_000), WakeupError);

  const fixed = service.scheduleFixed(60_000, "fixed task");
  assert.throws(() => service.scheduleTaskWakeup(fixed.id, 60_000), WakeupError);

  assert.equal(service.stopTask("nope"), false);
});

test("service rejects undeliverable and dead-on-arrival tasks", async () => {
  const { pi, ctx } = setup();
  const service = expectService(await discover(pi, ctx));

  // A control command is rejected by the shared dispatcher policy.
  assert.throws(() => service.scheduleFixed(60_000, "/loop stop"), /extension command/);
  // An interval longer than the expiry can never reach a first boundary.
  assert.throws(() => service.scheduleFixed(86_400_000, "never runs", { expiresAt: 1_000 }), /expire/);
});

// ---------------------------------------------------------------------------
// Session isolation and handle lifetime
// ---------------------------------------------------------------------------

test("two sessions never share a scheduler service", async () => {
  const a = setup();
  const b = setup();

  const serviceA = expectService(await discover(a.pi, a.ctx));
  const serviceB = expectService(await discover(b.pi, b.ctx));
  assert.notEqual(serviceA.sessionId, serviceB.sessionId, "each session gets its own id");

  const taskA = serviceA.scheduleFixed(60_000, "task A");
  assert.equal(serviceA.listTasks().length, 1);
  assert.deepEqual(serviceB.listTasks(), [], "session B never sees session A's task");
  assert.equal(b.registry.has(taskA.id), false);

  a.timers.advance(60_000);
  assert.deepEqual(a.pi.sent, ["task A"]);
  assert.deepEqual(b.pi.sent, [], "session A's tick does not dispatch in session B");
});

test("session shutdown invalidates outstanding handles", async () => {
  const { pi, ctx } = setup();
  const handle = expectService(await discover(pi, ctx));
  handle.scheduleFixed(60_000, "before shutdown");

  pi.fire("session_shutdown", ctx);

  assert.equal(handle.isAvailable(), false, "the handle reports itself stale");
  assert.throws(() => handle.listTasks(), LoopServiceUnavailableError);
  assert.throws(() => handle.scheduleFixed(60_000, "after"), LoopServiceUnavailableError);

  // A later session is discoverable as a fresh generation.
  const next = expectService(await discover(pi, ctx));
  assert.notEqual(next.sessionId, handle.sessionId);
  assert.equal(next.isAvailable(), true);
  assert.deepEqual(next.listTasks(), [], "the new session starts clean");
});

test("availability is published only after reconstruction completes", async () => {
  const { pi, ctx, registry } = setup();
  pi.fire("session_start", ctx);
  const service = expectService(await discoverLoopService(pi.events));
  const stale = service.scheduleFixed(60_000, "stale task");
  assert.equal(registry.has(stale.id), true);

  // A synchronous listener records what the authoritative state is at the exact
  // instant the service is advertised as available. Nothing here may be deferred
  // to a microtask, or the ordering bug this guards against would be hidden.
  let tasksAtPublish: string[] | undefined;
  let advertisedSessionId: string | undefined;
  const stop = onLoopServiceChange(pi.events, (status) => {
    if (!status.available) {
      return;
    }
    tasksAtPublish = registry.list().map((task) => task.id);
    advertisedSessionId = status.sessionId;
  });

  // Navigate to an empty branch: reconstruction drops the scheduled task. If the
  // provider advertised availability before rebuilding, the listener would still
  // see the stale task here.
  const nav = new FakeCtx();
  nav.branch = [];
  pi.fire("session_tree", nav);

  assert.ok(advertisedSessionId, "the change listener saw the service become available");
  assert.deepEqual(tasksAtPublish, [], "the registry is already rebuilt when availability is advertised");
  assert.equal(registry.has(stale.id), false);

  // The newly advertised handle is bound to that rebuilt state.
  const advertised = expectService(await discoverLoopService(pi.events));
  assert.equal(advertised.sessionId, advertisedSessionId);
  assert.deepEqual(advertised.listTasks(), []);
  stop();
});

test("session-tree reconstruction invalidates the previous handle", async () => {
  const { pi, ctx } = setup();
  const before = expectService(await discover(pi, ctx));

  const nav = new FakeCtx();
  nav.branch = [];
  pi.fire("session_tree", nav);

  assert.equal(before.isAvailable(), false, "navigating branches invalidates the old handle");
  assert.throws(() => before.listTasks(), LoopServiceUnavailableError);

  const after = expectService(await discoverLoopService(pi.events));
  assert.equal(after.isAvailable(), true);
  assert.notEqual(after.sessionId, before.sessionId);
});

// ---------------------------------------------------------------------------
// Provider protocol in isolation
// ---------------------------------------------------------------------------

function stubBackend(calls: string[]): LoopServiceBackend {
  const summary = (id: string, prompt: string): LoopTaskSummary =>
    Object.freeze({
      id,
      mode: "fixed" as const,
      prompt,
      maintenance: false,
      intervalMs: 60_000,
      pending: false,
    });
  return {
    scheduleFixed: (_intervalMs, prompt) => {
      calls.push("scheduleFixed");
      return summary("s1", prompt);
    },
    scheduleCron: (_expression, prompt) => {
      calls.push("scheduleCron");
      return summary("s2", prompt);
    },
    scheduleOnce: (_at, prompt) => {
      calls.push("scheduleOnce");
      return summary("s3", prompt);
    },
    scheduleSelfPaced: (prompt) => {
      calls.push("scheduleSelfPaced");
      return { ...summary("s4", prompt), mode: "self-paced" };
    },
    listTasks: () => {
      calls.push("listTasks");
      return [summary("s1", "task")];
    },
    deleteTask: () => {
      calls.push("deleteTask");
      return true;
    },
    scheduleTaskWakeup: () => {
      calls.push("scheduleTaskWakeup");
      return { requestedMs: 60_000, delayMs: 60_000, clamped: false, nextFireAt: 60_000 };
    },
    stopTask: () => {
      calls.push("stopTask");
      return true;
    },
  };
}

test("provider replies only while a session generation is active", async () => {
  const bus = new FakeEventBus();
  let session = 0;
  const provider = createLoopServiceProvider({
    backend: stubBackend([]),
    createSessionId: () => `session-${(session += 1)}`,
  });
  provider.register(bus);

  const before = await discoverLoopService(bus, { timeoutMs: 0 });
  assert.equal(before.ok, false);

  const handle = provider.beginSession();
  assert.equal(provider.isAvailable(), true);
  const discovered = expectService(await discoverLoopService(bus, { timeoutMs: 0 }));
  assert.equal(discovered.sessionId, handle.sessionId);
  assert.equal(discovered.isAvailable(), true);

  provider.endSession();
  assert.equal(handle.isAvailable(), false);
  const after = await discoverLoopService(bus, { timeoutMs: 0 });
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.reason, "unavailable");
    assert.match(after.message, /no active Pi session/);
  }

  provider.setUnavailable("disabled for a test");
  const unavailable = await discoverLoopService(bus, { timeoutMs: 0 });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) {
    assert.match(unavailable.message, /disabled for a test/);
  }
});

test("provider forwards mutations, triggers onChange, and freezes list results", async () => {
  const bus = new FakeEventBus();
  const calls: string[] = [];
  let changes = 0;
  const provider = createLoopServiceProvider({
    backend: stubBackend(calls),
    onChange: () => {
      changes += 1;
    },
    createSessionId: () => "session-x",
  });
  provider.register(bus);
  provider.beginSession();

  const service = expectService(await discoverLoopService(bus, { timeoutMs: 0 }));
  const created = service.scheduleFixed(60_000, "abc");
  assert.equal(created.id, "s1");

  const list = service.listTasks();
  assert.equal(Object.isFrozen(list), true, "the list itself is frozen");

  service.deleteTask("s1");
  service.scheduleTaskWakeup("s1", 60_000);
  service.stopTask("s1");
  assert.deepEqual(calls, [
    "scheduleFixed",
    "listTasks",
    "deleteTask",
    "scheduleTaskWakeup",
    "stopTask",
  ]);
  // listTasks is read-only; the other four mutations repainted the host.
  assert.equal(changes, 4);
});

test("isLoopServiceV1 rejects malformed handles", () => {
  assert.equal(isLoopServiceV1(undefined), false);
  assert.equal(isLoopServiceV1({ version: 1, sessionId: "x" }), false);
  assert.equal(isLoopServiceV1({ version: 2, sessionId: "x" }), false);
});
