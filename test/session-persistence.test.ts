import assert from "node:assert/strict";
import test from "node:test";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import { createTaskEvent, PERSISTENCE_CUSTOM_TYPE } from "../src/persistence.ts";
import { FakeCtx, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

function setup(overrides: Partial<LoopExtensionDeps> = {}) {
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
    maintenance: {
      cwd: "/proj",
      homeDir: "/home",
      readFile: () => {
        throw missingFile();
      },
    },
    ...overrides,
    registry,
  });
  return { timers, pi, ctx, registry };
}

/** Turn the entries a fake Pi persisted into the branch a resumed session sees. */
function branchFrom(pi: FakePi): FakeCtx["branch"] {
  return pi.appended.map((entry) => ({ type: "custom", customType: entry.customType, data: entry.data }));
}

function resume(pi: FakePi, branch: FakeCtx["branch"]): FakeCtx {
  const ctx = new FakeCtx();
  ctx.branch = branch;
  pi.fire("session_start", ctx);
  return ctx;
}

test("a fixed loop persists a create entry and resumes with the same ID and schedule", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 5min check deploy", ctx);
  assert.equal(pi.appended.length, 1, "starting a fixed loop appends one create event");
  assert.equal(pi.appended[0]!.customType, PERSISTENCE_CUSTOM_TYPE);
  const [original] = registry.list();
  assert.ok(original);

  const resumed = resume(pi, branchFrom(pi));
  assert.equal(registry.size, 1, "the task is reconstructed");
  const [restored] = registry.list();
  assert.equal(restored!.id, original.id, "the stable ID is preserved");
  assert.deepEqual(restored!.schedule, { intervalMs: 300_000, anchor: 0 });
  assert.equal(timers.pendingCount, 1, "exactly one timer is re-armed");
  assert.equal(pi.appended.length, 1, "restoring writes no duplicate entries");
  assert.deepEqual(resumed.notifications, [], "a clean restore reports nothing");

  timers.advance(300_000);
  assert.deepEqual(pi.sent, ["check deploy"], "the resumed task keeps firing on the grid");
});

test("a resumed command loop is still reported and stoppable", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 5min check deploy", ctx);
  assert.equal((pi.appended[0]!.data as { task: { primary?: boolean } }).task.primary, true);

  resume(pi, branchFrom(pi));
  await pi.run("loop", "status", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /Loop every 5min: check deploy/);

  await pi.run("loop", "stop", ctx);
  assert.equal(ctx.lastNotification()?.message, "Loop stopped.");
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});

test("a duplicate reload does not duplicate tasks or timers", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 1min ping", ctx);

  const branch = branchFrom(pi);
  resume(pi, branch);
  resume(pi, branch);

  assert.equal(registry.size, 1);
  assert.equal(timers.pendingCount, 1);
  assert.equal(pi.appended.length, 1, "replaying never appends events");
});

test("stop persists a tombstone so a resumed session stays stopped", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 1min ping", ctx);
  await pi.run("loop", "stop", ctx);
  assert.deepEqual(
    pi.appended.map((entry) => (entry.data as { kind: string }).kind),
    ["create", "delete"],
  );

  resume(pi, branchFrom(pi));
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});

test("self-paced loops are ephemeral: nothing is persisted and nothing is restored", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "watch deploy", ctx);
  assert.equal(pi.appended.length, 0, "self-paced wakeup state is never persisted");

  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"]);

  resume(pi, branchFrom(pi));
  assert.equal(registry.size, 0, "no self-paced task is reconstructed");
  assert.equal(timers.pendingCount, 0);
});

test("session shutdown does not tombstone, so a later resume restores the task", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 1min ping", ctx);

  pi.fire("session_shutdown");
  assert.equal(registry.size, 0, "shutdown drops in-memory state");
  assert.equal(timers.pendingCount, 0);
  assert.equal(
    pi.appended.some((entry) => (entry.data as { kind?: string }).kind === "delete"),
    false,
    "teardown must not delete the persisted task",
  );

  resume(pi, branchFrom(pi));
  assert.equal(registry.size, 1, "the task comes back after a resume");
  assert.equal(timers.pendingCount, 1);
});

test("branch navigation drops the abandoned branch's tasks", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 1min ping", ctx);
  assert.equal(registry.size, 1);

  // The entered branch has no loop entry, so the previous task must be disposed.
  const navCtx = new FakeCtx();
  navCtx.branch = [];
  pi.fire("session_tree", navCtx);
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});

function custom(data: unknown): FakeCtx["branch"][number] {
  return { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data };
}

test("expired, missed, and self-paced entries are skipped and reported", () => {
  const { timers, pi, registry } = setup();
  const branch: FakeCtx["branch"] = [
    custom(
      createTaskEvent({
        id: "expired",
        prompt: "gone",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
        expiresAt: 0,
      }),
    ),
    custom(createTaskEvent({ id: "missed", prompt: "late", mode: "one-shot", createdAt: 0, nextFireAt: 0 })),
    custom(createTaskEvent({ id: "pace", prompt: "pace", mode: "self-paced", createdAt: 0 })),
    custom(
      createTaskEvent({
        id: "live",
        prompt: "keep",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
      }),
    ),
  ];

  const ctx = resume(pi, branch);
  assert.deepEqual(registry.list().map((task) => task.id), ["live"]);
  assert.equal(timers.pendingCount, 1);
  const warnings = ctx.notifications.filter((note) => note.type === "warning").map((note) => note.message);
  assert.ok(warnings.some((message) => /self-paced task pace/.test(message)), "self-paced entries are reported");
});

test("a newer-version tombstone does not resurrect the v1 create it deletes", async () => {
  const { timers, pi, registry } = setup();
  const branch: FakeCtx["branch"] = [
    custom(
      createTaskEvent({
        id: "deleted-by-newer-schema",
        prompt: "should not return",
        mode: "fixed",
        createdAt: 0,
        schedule: { intervalMs: 60_000, anchor: 0 },
      }),
    ),
    // A v2 writer deleted the task with a tombstone this reader cannot parse.
    custom({ version: 2, kind: "delete", id: "deleted-by-newer-schema" }),
  ];

  const ctx = resume(pi, branch);
  assert.equal(registry.size, 0, "the branch must fail closed instead of resurrecting the task");
  assert.equal(timers.pendingCount, 0);
  const warnings = ctx.notifications.filter((note) => note.type === "warning").map((note) => note.message);
  assert.ok(warnings.some((message) => /newer schema version 2/.test(message)), "the version is reported");
});

test("a fresh session does not inherit another session's persisted tasks", async () => {
  const { timers, pi, ctx, registry } = setup();
  await pi.run("loop", "every 1min ping", ctx);
  pi.fire("session_shutdown");

  resume(pi, []);
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});
