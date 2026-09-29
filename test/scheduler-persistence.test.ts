import assert from "node:assert/strict";
import test from "node:test";
import { LoopScheduler } from "../src/loop-core.ts";
import type { PersistedEvent, PersistedTask } from "../src/persistence.ts";
import { FakeTimers, testRegistry } from "./helpers.ts";

function setup(idle = true) {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const events: PersistedEvent[] = [];
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
    },
    () => idle,
    undefined,
    undefined,
    (event) => events.push(event),
  );
  return { timers, registry, scheduler, dispatched, events };
}

function restoredFixed(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: "persisted-1",
    prompt: "resume me",
    mode: "fixed",
    createdAt: 1_000,
    schedule: { intervalMs: 60_000, anchor: 0 },
    nextFireAt: 60_000,
    ...overrides,
  };
}

test("scheduleFixed persists a create event with schedule and timing metadata", () => {
  const { scheduler, events } = setup();
  const task = scheduler.scheduleFixed(5 * 60_000, "check deploy", { expiresAt: 900_000 });

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.kind, "create");
  if (event.kind === "create") {
    assert.equal(event.task.id, task.id);
    assert.equal(event.task.prompt, "check deploy");
    assert.equal(event.task.mode, "fixed");
    assert.deepEqual(event.task.schedule, { intervalMs: 300_000, anchor: 0 });
    assert.equal(event.task.nextFireAt, 300_000);
    assert.equal(event.task.expiresAt, 900_000);
  }
});

test("updateTask persists an update event", () => {
  const { scheduler, events } = setup();
  const task = scheduler.scheduleFixed(60_000, "poll");

  scheduler.updateTask(task.id, { prompt: "poll again", nextFireAt: 120_000 });
  assert.equal(events.length, 2);
  const update = events[1]!;
  assert.equal(update.kind, "update");
  if (update.kind === "update") {
    assert.equal(update.id, task.id);
    assert.equal(update.patch.prompt, "poll again");
    assert.equal(update.patch.nextFireAt, 120_000);
  }
});

test("stopping a fixed task tombstones it, but teardown does not", () => {
  const { scheduler, events } = setup();
  const task = scheduler.scheduleFixed(60_000, "poll");
  scheduler.stopTask(task.id);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );

  const another = scheduler.scheduleFixed(60_000, "second");
  scheduler.stopAll();
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete", "create"],
    "stopAll is teardown and must not append a tombstone",
  );
  assert.equal(events.some((event) => event.kind === "delete" && event.id === another.id), false);
});

test("replacing the command loop persists the old delete before the new create", () => {
  const { registry, scheduler, events } = setup();
  scheduler.start(60_000, "first");
  const firstId = registry.list()[0]!.id;
  scheduler.start(60_000, "second");
  const secondId = registry.list()[0]!.id;

  assert.deepEqual(
    events.map((event) => (event.kind === "create" ? `create:${event.task.id}` : `delete:${event.id}`)),
    [`create:${firstId}`, `delete:${firstId}`, `create:${secondId}`],
  );
});

test("self-paced tasks never persist create, wakeup, or delete events", () => {
  const { scheduler, events } = setup();
  const task = scheduler.startSelfPaced("pace me");
  scheduler.scheduleNextWakeup(60_000, "in a minute");
  scheduler.settleIteration();
  scheduler.stopTask(task.id);

  assert.deepEqual(events, []);
});

test("restore keeps the stable ID, arms one timer, and writes no events", () => {
  const { timers, registry, scheduler, events } = setup();
  const task = scheduler.restore(restoredFixed({ id: "stable-1" }));

  assert.ok(task);
  assert.equal(task.id, "stable-1");
  assert.equal(registry.get("stable-1")?.id, "stable-1");
  assert.equal(registry.get("stable-1")?.schedule?.intervalMs, 60_000);
  assert.equal(timers.pendingCount, 1, "the restored task is armed exactly once");
  assert.deepEqual(events, [], "replay must not duplicate persistence entries");
});

test("a duplicate restore of the same ID does not arm a second timer", () => {
  const { timers, registry, scheduler, events } = setup();
  scheduler.restore(restoredFixed({ id: "stable-1" }));
  const again = scheduler.restore(restoredFixed({ id: "stable-1" }));

  assert.equal(again?.id, "stable-1");
  assert.equal(registry.size, 1);
  assert.equal(timers.pendingCount, 1, "one task keeps exactly one timer");
  assert.deepEqual(events, []);
});

test("reconcile: a restored task missing its stored fire time rearms on the grid", () => {
  const { timers, scheduler, dispatched, events } = setup();
  scheduler.restore(restoredFixed({ nextFireAt: 0 })); // stale time from an old session
  assert.equal(timers.pendingCount, 1);

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["resume me"], "the next boundary is recomputed from the schedule");
  assert.deepEqual(events, [], "restore still writes nothing on the first tick");
});

test("a self-paced task is never restored", () => {
  const { scheduler } = setup();
  assert.equal(scheduler.restore({ id: "x", prompt: "pace", mode: "self-paced", createdAt: 0 }), undefined);
});

test("restoring a primary fixed task keeps it stoppable and reported", () => {
  const { timers, registry, scheduler } = setup();
  scheduler.restore(restoredFixed({ id: "primary-1", primary: true }));

  const status = scheduler.status();
  assert.equal(status.active, true);
  assert.equal(status.mode, "fixed");
  assert.equal(status.intervalMs, 60_000);
  assert.equal(status.task, "resume me");

  assert.equal(scheduler.stop(), true);
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
});

test("expiry stops a recurring task at its last boundary and tombstones it", () => {
  const { timers, registry, scheduler, dispatched, events } = setup();
  scheduler.scheduleFixed(60_000, "short lived", { expiresAt: 60_000 });

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["short lived"], "the boundary at the expiry still runs");
  assert.equal(registry.size, 0, "the task is removed once no future boundary fits");
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );

  timers.advance(10 * 60_000);
  assert.deepEqual(dispatched, ["short lived"], "an expired task never runs again");
});

test("a task created already expired is removed without firing", () => {
  const { registry, scheduler, dispatched, events } = setup();
  scheduler.scheduleFixed(60_000, "too late", { expiresAt: 0 });
  assert.equal(registry.size, 0);
  assert.deepEqual(dispatched, []);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );
});

test("a one-shot fires once, is removed, and tombstones itself", () => {
  const { timers, registry, scheduler, dispatched, events } = setup();
  scheduler.scheduleOnce(30_000, "run once");

  timers.advance(29_999);
  assert.deepEqual(dispatched, []);
  timers.advance(1);
  assert.deepEqual(dispatched, ["run once"]);
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["run once"], "a one-shot does not repeat");
});

test("a one-shot missed while busy is delivered once at the next idle point", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const events: PersistedEvent[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
    },
    () => idle,
    undefined,
    undefined,
    (event) => events.push(event),
  );
  const task = scheduler.scheduleOnce(10_000, "once");
  timers.advance(10_000);
  assert.deepEqual(dispatched, [], "a busy one-shot is queued, not dropped");
  assert.deepEqual(scheduler.dueTaskIds(), [task.id]);

  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["once"]);
  assert.equal(registry.has(task.id), false, "the one-shot is removed after its queued run");
});
