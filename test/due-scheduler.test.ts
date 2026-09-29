/**
 * Scheduler-owned per-task due queue: integration through {@link LoopScheduler}.
 *
 * These tests drive a scheduler that tracks more than one task and assert the
 * due-queue contract: busy ticks coalesce per task, distinct tasks flush in a
 * deterministic order at the idle boundary, deleted/replaced tasks and stale
 * callbacks never dispatch, and a flush stops when a dispatch starts work.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LoopScheduler, type SchedulerDeps } from "../src/loop-core.ts";
import { FakeTimers, testRegistry } from "./helpers.ts";

/** A scheduler with a mutable idle flag and a record of dispatched prompts. */
function setup(): {
  timers: FakeTimers;
  registry: ReturnType<typeof testRegistry>;
  scheduler: LoopScheduler;
  dispatched: string[];
  setIdle: (value: boolean) => void;
} {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let idle = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
    },
    () => idle,
  );
  return { timers, registry, scheduler, dispatched, setIdle: (value) => (idle = value) };
}

test("a single task's repeated busy ticks coalesce into one scheduler-owned entry", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleFixed(60_000, "solo");

  setIdle(false);
  timers.advance(3 * 60_000);

  assert.deepEqual(dispatched, [], "a busy period must not be interrupted");
  assert.deepEqual(scheduler.dueTaskIds(), [task.id], "three missed ticks collapse into one entry");
  assert.equal(registry.get(task.id)?.pending, true, "the registry mirror reflects the queue");
  assert.equal(registry.get(task.id)?.nextFireAt, 4 * 60_000, "boundaries advanced on the grid");

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["solo"], "the coalesced run is delivered exactly once");
  assert.deepEqual(scheduler.dueTaskIds(), []);
  assert.equal(registry.get(task.id)?.pending, false);
});

test("two distinct tasks due at the same deadline flush in registration order", () => {
  const { timers, scheduler, dispatched, setIdle } = setup();
  const alpha = scheduler.scheduleFixed(60_000, "alpha");
  const beta = scheduler.scheduleFixed(60_000, "beta");

  setIdle(false);
  timers.advance(60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [alpha.id, beta.id], "simultaneous deadlines keep registration order");
  assert.deepEqual(dispatched, []);

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["alpha", "beta"]);
  assert.deepEqual(scheduler.dueTaskIds(), []);
});

test("distinct tasks flush earliest-deadline-first, not registration order", () => {
  const { timers, scheduler, dispatched, setIdle } = setup();
  const slow = scheduler.scheduleFixed(5 * 60_000, "slow");
  const fast = scheduler.scheduleFixed(60_000, "fast");

  setIdle(false);
  timers.advance(5 * 60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [fast.id, slow.id], "the earlier missed deadline flushes first");

  setIdle(true);
  scheduler.flush();
  assert.deepEqual(dispatched, ["fast", "slow"]);
});

test("a long busy window never replays a backlog for any task", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const alpha = scheduler.scheduleFixed(60_000, "alpha");
  const beta = scheduler.scheduleFixed(60_000, "beta");

  setIdle(false);
  timers.advance(10 * 60_000);
  assert.equal(scheduler.dueTaskIds().length, 2, "ten missed boundaries each collapse to one entry");

  setIdle(true);
  scheduler.flush();
  assert.deepEqual(dispatched, ["alpha", "beta"], "each task runs once, not once per missed interval");
  assert.equal(registry.get(alpha.id)?.nextFireAt, 11 * 60_000, "the grid is unshifted by the long busy period");
  assert.equal(registry.get(beta.id)?.nextFireAt, 11 * 60_000);
});

test("flushing stops when a dispatch starts work and resumes at the next idle boundary", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let idle = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
      // The first dispatch synchronously starts agent work.
      idle = false;
    },
    () => idle,
  );
  const alpha = scheduler.scheduleFixed(60_000, "alpha");
  const beta = scheduler.scheduleFixed(60_000, "beta");

  idle = false;
  timers.advance(60_000);
  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["alpha"], "the flush stops as soon as the agent is busy again");
  assert.deepEqual(scheduler.dueTaskIds(), [beta.id], "the undispatched task keeps its place");
  assert.equal(registry.get(beta.id)?.pending, true);

  idle = true;
  assert.equal(scheduler.flush(), true, "the deferred task resumes at the next idle boundary");
  assert.deepEqual(dispatched, ["alpha", "beta"]);
  assert.deepEqual(scheduler.dueTaskIds(), []);
});

test("flush while busy is a no-op that keeps every due entry", () => {
  const { timers, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleFixed(60_000, "alpha");

  setIdle(false);
  timers.advance(60_000);
  assert.equal(scheduler.flush(), false);
  assert.deepEqual(scheduler.dueTaskIds(), [task.id], "deferred, not dropped");
  assert.deepEqual(dispatched, []);
});

test("the scheduler queue, not the registry pending mirror, decides dispatch", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleFixed(60_000, "alpha");

  setIdle(false);
  timers.advance(60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [task.id]);

  // Tamper with the compatibility mirror: dispatch must still be queue-driven.
  registry.update(task.id, { pending: false });

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["alpha"], "the due queue is the source of truth");
});

test("a task deleted from the registry is dropped from the queue without dispatching", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleFixed(60_000, "orphan");

  setIdle(false);
  timers.advance(60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [task.id]);

  registry.delete(task.id);
  setIdle(true);
  assert.equal(scheduler.flush(), false);
  assert.deepEqual(dispatched, [], "a deleted task must never dispatch");
  assert.deepEqual(scheduler.dueTaskIds(), []);
  assert.equal(scheduler.trackedTaskIds().includes(task.id), false, "the stale entry is forgotten");
});

test("stopTask cancels the timer, drops the queued run, and removes the task", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleFixed(60_000, "alpha");

  setIdle(false);
  timers.advance(60_000);
  assert.equal(scheduler.stopTask(task.id), true);
  assert.equal(timers.pendingCount, 0, "the armed timer is cleared");
  assert.deepEqual(scheduler.dueTaskIds(), []);
  assert.equal(registry.get(task.id), undefined);

  setIdle(true);
  assert.equal(scheduler.flush(), false);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.stopTask(task.id), false, "stopping twice reports no task");
});

test("a stale timer callback captured before stopTask cannot dispatch", () => {
  const captured: Array<() => void> = [];
  const timers: SchedulerDeps = {
    now: () => 0,
    setTimer: (fn) => {
      captured.push(fn);
      return captured.length;
    },
    clearTimer: () => {},
  };
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, testRegistry(new FakeTimers()), (task) => {
    dispatched.push(task.prompt);
  }, () => true);

  const task = scheduler.scheduleFixed(60_000, "old");
  const stale = captured[0]!;
  scheduler.stopTask(task.id);

  stale();
  assert.deepEqual(dispatched, [], "the per-entry token guard blocks the stale callback");
  assert.deepEqual(scheduler.dueTaskIds(), []);
});

test("replacing the command loop drops its queued run and ignores its stale callback", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();

  scheduler.start(60_000, "old");
  const oldId = registry.list()[0]!.id;
  setIdle(false);
  timers.advance(60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [oldId], "the replaced task's missed run is queued");

  scheduler.start(60_000, "new");
  assert.equal(registry.has(oldId), false, "replacement removes the old task");
  assert.deepEqual(scheduler.dueTaskIds(), [], "the replaced task's queued run is dropped");

  setIdle(true);
  assert.equal(scheduler.flush(), false, "the replacement is not due before its first boundary");
  assert.deepEqual(dispatched, []);

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["new"], "the replacement still fires on its own boundary");
});

test("an independent task and the command loop coexist and flush together", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();

  scheduler.start(60_000, "command");
  const commandId = registry.list()[0]!.id;
  const extra = scheduler.scheduleFixed(60_000, "extra");

  setIdle(false);
  timers.advance(60_000);
  assert.deepEqual(scheduler.dueTaskIds(), [commandId, extra.id]);
  assert.equal(scheduler.status().task, "command", "status still describes the command-owned loop");

  setIdle(true);
  scheduler.flush();
  assert.deepEqual(dispatched, ["command", "extra"]);
});

test("stopAll clears every tracked task, timer, and queued run", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  scheduler.scheduleFixed(60_000, "alpha");
  scheduler.scheduleFixed(60_000, "beta");

  setIdle(false);
  timers.advance(60_000);
  assert.equal(scheduler.dueTaskIds().length, 2);

  scheduler.stopAll();
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(scheduler.dueTaskIds(), []);
  assert.deepEqual(scheduler.trackedTaskIds(), []);

  setIdle(true);
  timers.advance(10 * 60_000);
  assert.deepEqual(dispatched, [], "no timer or callback survives stopAll");
});

test("dispose drops every tracked task and the due queue", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  scheduler.scheduleFixed(60_000, "alpha");

  setIdle(false);
  timers.advance(60_000);
  scheduler.dispose();

  assert.equal(timers.pendingCount, 0);
  assert.equal(registry.size, 0);
  assert.deepEqual(scheduler.dueTaskIds(), []);

  setIdle(true);
  assert.equal(scheduler.flush(), false, "a disposed scheduler never flushes");
  assert.deepEqual(dispatched, []);
  assert.throws(() => scheduler.scheduleFixed(60_000, "again"), /disposed/);
});

test("an async dispatch failure requeues only the task that failed", async () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const rejectors: Array<(error: unknown) => void> = [];
  let idle = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
      if (task.prompt === "flaky") {
        return new Promise<void>((_resolve, reject) => rejectors.push(reject));
      }
      return undefined;
    },
    () => idle,
  );
  const flaky = scheduler.scheduleFixed(60_000, "flaky");
  const solid = scheduler.scheduleFixed(60_000, "solid");

  idle = false;
  timers.advance(60_000);
  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["flaky", "solid"]);

  rejectors[0]!(new Error("boom"));
  await Promise.resolve();

  assert.deepEqual(scheduler.dueTaskIds(), [flaky.id], "only the failed task is requeued");
  assert.equal(registry.get(flaky.id)?.pending, true);
  assert.equal(registry.get(solid.id)?.pending, false, "the other task is unaffected");
});

