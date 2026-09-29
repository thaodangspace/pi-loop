/**
 * Recurring-task expiry (seven-day default) and deterministic, ID-based phase
 * jitter.
 *
 * The jitter suites opt back into the real ID hash (the shared `FakeTimers`
 * disables jitter so the boundary/grid suites can assert the underlying grid).
 * Every test drives time explicitly through the virtual clock, so expiry
 * boundaries, busy periods, and restores are fully deterministic.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createLoopExtension } from "../src/index.ts";
import { LoopScheduler } from "../src/loop-core.ts";
import {
  createTaskEvent,
  replayEvents,
  type PersistedEvent,
} from "../src/persistence.ts";
import {
  createSchedule,
  DAY_MS,
  DEFAULT_TASK_TTL_MS,
  defaultExpiresAt,
  hashTaskId,
  HOUR_MS,
  jitterOffsetMs,
  jitterWindowMs,
  MINUTE_MS,
  nextFireAtJittered,
} from "../src/schedule.ts";
import { FakeCtx, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

/** A scheduler with the real ID-based jitter enabled. */
function jitteredSetup(idle = true): {
  timers: FakeTimers;
  registry: ReturnType<typeof testRegistry>;
  scheduler: LoopScheduler;
  dispatched: string[];
  events: PersistedEvent[];
  setIdle: (value: boolean) => void;
} {
  const timers = new FakeTimers();
  timers.jitterOffset = jitterOffsetMs;
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const events: PersistedEvent[] = [];
  let currentIdle = idle;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
    },
    () => currentIdle,
    undefined,
    undefined,
    (event) => events.push(event),
  );
  return { timers, registry, scheduler, dispatched, events, setIdle: (value) => (currentIdle = value) };
}

// ---------------------------------------------------------------------------
// Hashing and offset bounds
// ---------------------------------------------------------------------------

test("hashTaskId is a stable 32-bit FNV-1a of the ID", () => {
  // Golden values pin the algorithm so a refactor cannot silently change every
  // task's phase, which would break restored tasks.
  assert.equal(hashTaskId(""), 0x811c9dc5);
  assert.equal(hashTaskId("t1"), 138_734_806);
  assert.equal(hashTaskId("t2"), 121_957_187);
  assert.equal(hashTaskId("alpha"), 1_569_418_667);
  for (const id of ["t1", "persisted-1", "worker-a"]) {
    assert.equal(hashTaskId(id), hashTaskId(id), "the hash is deterministic");
    const value = hashTaskId(id);
    assert.ok(value >= 0 && value <= 0xffffffff, "the hash is an unsigned 32-bit value");
  }
});

test("jitter offsets are deterministic and bounded by a fraction of the cadence", () => {
  assert.equal(jitterWindowMs(MINUTE_MS), 15_000, "a 1-minute cadence spreads over a quarter minute");
  assert.equal(jitterWindowMs(5 * MINUTE_MS), 75_000);
  assert.equal(jitterWindowMs(HOUR_MS), 900_000);
  assert.equal(jitterWindowMs(DAY_MS), HOUR_MS, "a long cadence is capped at one hour");
  assert.equal(jitterWindowMs(30 * DAY_MS), HOUR_MS, "the cap holds for the longest cadences");
  assert.equal(jitterWindowMs(0), 0);

  for (const id of ["t1", "t2", "t3", "persisted-1", "worker-a", "worker-b"]) {
    for (const cadence of [MINUTE_MS, 5 * MINUTE_MS, HOUR_MS, DAY_MS, 30 * DAY_MS]) {
      const offset = jitterOffsetMs(id, cadence);
      assert.equal(offset, jitterOffsetMs(id, cadence), "the offset is a pure function");
      assert.ok(offset >= 0, `${offset} is not negative`);
      assert.ok(offset < jitterWindowMs(cadence), `${offset} is inside the window for ${cadence}ms`);
      assert.ok(offset < cadence, "the offset never reaches the next boundary");
    }
  }

  const offsets = new Set(["t1", "t2", "t3", "a", "b", "c"].map((id) => jitterOffsetMs(id, MINUTE_MS)));
  assert.ok(offsets.size > 1, "distinct IDs land on distinct phases");
});

test("jittered boundaries keep a fixed phase and never drift", () => {
  const schedule = createSchedule(MINUTE_MS);
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  assert.equal(nextFireAtJittered(schedule, "t1", 0), phase, "the first boundary carries the phase");
  assert.equal(
    nextFireAtJittered(schedule, "t1", phase),
    phase + MINUTE_MS,
    "a boundary exactly at the phase is skipped",
  );

  let previous = phase;
  for (let step = 0; step < 100; step += 1) {
    const next = nextFireAtJittered(schedule, "t1", previous);
    assert.equal(next - previous, MINUTE_MS, "every step is exactly one cadence");
    previous = next;
  }

  assert.notEqual(
    nextFireAtJittered(schedule, "t1", 0),
    nextFireAtJittered(schedule, "t2", 0),
    "distinct IDs get distinct phases",
  );
});

test("nextFireAtJittered sanitizes an injected offset", () => {
  const schedule = createSchedule(MINUTE_MS);
  assert.equal(nextFireAtJittered(schedule, "x", 0, () => -5), MINUTE_MS, "negative offsets clamp to zero");
  assert.equal(nextFireAtJittered(schedule, "x", 0, () => Number.NaN), MINUTE_MS, "non-finite offsets clamp to zero");
  assert.equal(
    nextFireAtJittered(schedule, "x", 0, () => MINUTE_MS * 3),
    MINUTE_MS - 1,
    "an over-large offset clamps below one cadence",
  );
});

// ---------------------------------------------------------------------------
// Scheduler-level jitter
// ---------------------------------------------------------------------------

test("a recurring fixed task fires on its ID-derived phase without drift", () => {
  const { timers, registry, scheduler, dispatched } = jitteredSetup();
  const task = scheduler.scheduleFixed(MINUTE_MS, "t1");
  const phase = jitterOffsetMs(task.id, MINUTE_MS);
  assert.equal(registry.get(task.id)?.nextFireAt, phase, "the first fire is the jittered boundary");
  assert.notEqual(phase, 0, "the sample ID does not sit on the un-jittered grid");

  timers.advance(phase - 1);
  assert.deepEqual(dispatched, [], "nothing fires before the phase");
  timers.advance(1);
  assert.deepEqual(dispatched, ["t1"]);

  assert.equal(registry.get(task.id)?.nextFireAt, phase + MINUTE_MS, "the phase is preserved across runs");
  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["t1", "t1"]);
  assert.equal(registry.get(task.id)?.nextFireAt, phase + 2 * MINUTE_MS);
});

test("distinct task IDs get distinct phases and flush earliest-deadline-first", () => {
  const { timers, scheduler, dispatched, setIdle } = jitteredSetup(true);
  setIdle(false);
  const a = scheduler.scheduleFixed(MINUTE_MS, "a");
  const b = scheduler.scheduleFixed(MINUTE_MS, "b");
  const phaseA = jitterOffsetMs(a.id, MINUTE_MS);
  const phaseB = jitterOffsetMs(b.id, MINUTE_MS);
  assert.notEqual(phaseA, phaseB, "the two tasks are deliberately spread apart");

  timers.advance(Math.max(phaseA, phaseB));
  assert.deepEqual(
    scheduler.dueTaskIds(),
    phaseA < phaseB ? [a.id, b.id] : [b.id, a.id],
    "the earlier jittered deadline is queued first",
  );

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, phaseA < phaseB ? ["a", "b"] : ["b", "a"]);
});

test("a jittered task keeps its phase across a long busy gap", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = jitteredSetup(true);
  const task = scheduler.scheduleFixed(MINUTE_MS, "t1");
  const phase = jitterOffsetMs(task.id, MINUTE_MS);
  setIdle(false);

  // Manually drive the virtual clock past ten boundaries without firing timers,
  // then fire the overdue one. The next boundary is recomputed on the same
  // jittered grid instead of drifting with the gap.
  timers.sleep(10 * MINUTE_MS);
  timers.advance(0);

  const expected = nextFireAtJittered(createSchedule(MINUTE_MS), task.id, 10 * MINUTE_MS);
  assert.equal(registry.get(task.id)?.nextFireAt, expected, "the phase survives the gap");
  assert.equal((expected - phase) % MINUTE_MS, 0, "still on the jittered grid");
  assert.equal(scheduler.dueTaskIds().length, 1, "the missed run coalesces into one entry");
  assert.deepEqual(dispatched, [], "a busy gap dispatches nothing");
});

test("restore reproduces the same phase from the stable ID and schedule", () => {
  const { timers, scheduler, registry } = jitteredSetup();
  const phase = jitterOffsetMs("t1", MINUTE_MS);

  // A stale fire time from an older session is reconciled onto the ID's phase.
  const restored = scheduler.restore({
    id: "t1",
    prompt: "resume",
    mode: "fixed",
    createdAt: 0,
    schedule: { intervalMs: MINUTE_MS, anchor: 0 },
    nextFireAt: 0,
  });
  assert.ok(restored);
  assert.equal(registry.get("t1")?.nextFireAt, phase, "restore recomputes the ID phase");
  assert.equal(timers.pendingCount, 1);

  // A stored time that is still in the future is honoured as-is, so a reload
  // does not move an already-scheduled boundary.
  const future = phase + 5 * MINUTE_MS;
  const other = jitteredSetup();
  const kept = other.scheduler.restore({
    id: "t1",
    prompt: "resume",
    mode: "fixed",
    createdAt: 0,
    schedule: { intervalMs: MINUTE_MS, anchor: 0 },
    nextFireAt: future,
  });
  assert.equal(kept?.nextFireAt, future);
  assert.equal(other.registry.get("t1")?.nextFireAt, future);
});

test("one-shot and self-paced tasks are never jittered", () => {
  const { timers, registry, scheduler, dispatched } = jitteredSetup();

  const once = scheduler.scheduleOnce(12_345, "once");
  assert.equal(once.nextFireAt, 12_345, "a one-shot fires exactly at its requested time");
  timers.advance(12_344);
  assert.deepEqual(dispatched, []);
  timers.advance(1);
  assert.deepEqual(dispatched, ["once"]);

  const paced = scheduler.startSelfPaced("pace");
  assert.equal(paced.nextFireAt, 12_345, "a self-paced task is due immediately, not on a grid");
  timers.advance(0);
  assert.deepEqual(dispatched, ["once", "pace"]);

  const decision = scheduler.scheduleNextWakeup(MINUTE_MS, "again");
  assert.equal(decision.nextFireAt, 12_345 + MINUTE_MS, "the wakeup delay is measured from now");
  assert.equal(registry.get(paced.id)?.nextFireAt, 12_345 + MINUTE_MS);
});

// ---------------------------------------------------------------------------
// Expiry: default lifetime and explicit override
// ---------------------------------------------------------------------------

test("a recurring fixed task defaults to a seven-day lifetime from creation", () => {
  const { timers, scheduler, events } = jitteredSetup();
  timers.clock = 1_000;
  const task = scheduler.scheduleFixed(MINUTE_MS, "poll");

  assert.equal(DEFAULT_TASK_TTL_MS, 7 * DAY_MS);
  assert.equal(task.expiresAt, 1_000 + DEFAULT_TASK_TTL_MS);
  assert.equal(task.expiresAt, defaultExpiresAt(1_000));
  const create = events[0];
  assert.equal(create?.kind, "create");
  if (create?.kind === "create") {
    assert.equal(create.task.expiresAt, 1_000 + DEFAULT_TASK_TTL_MS, "the default expiry is persisted");
  }
});

test("an explicit expiry overrides the default and may shorten it", () => {
  const { scheduler } = jitteredSetup();
  const task = scheduler.scheduleFixed(MINUTE_MS, "poll", { expiresAt: 500 });
  assert.equal(task.expiresAt, 500);
});

test("one-shot and self-paced tasks get no default expiry", () => {
  const { scheduler } = jitteredSetup();
  assert.equal(scheduler.scheduleOnce(10_000, "once").expiresAt, undefined);
  assert.equal(scheduler.startSelfPaced("pace").expiresAt, undefined);
});

// ---------------------------------------------------------------------------
// Expiry boundary and run ordering
// ---------------------------------------------------------------------------

test("a run exactly at the expiry still fires, then the task is removed", () => {
  const { timers, registry, scheduler, dispatched, events } = jitteredSetup();
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  // The second boundary coincides exactly with the expiry.
  const task = scheduler.scheduleFixed(MINUTE_MS, "last", { expiresAt: phase + MINUTE_MS });

  timers.advance(phase);
  assert.deepEqual(dispatched, ["last"], "the first boundary runs");
  assert.equal(registry.has(task.id), true);

  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["last", "last"], "the boundary exactly at expiry runs");
  assert.equal(registry.has(task.id), false, "and the task is removed immediately after");
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
    "the runtime expiry is tombstoned",
  );

  timers.advance(10 * MINUTE_MS);
  assert.deepEqual(dispatched, ["last", "last"], "an expired task never runs again");
});

test("a delayed tick strictly after the expiry drops the run and removes the task", () => {
  const { timers, registry, scheduler, dispatched, events } = jitteredSetup();
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  const task = scheduler.scheduleFixed(MINUTE_MS, "late", { expiresAt: phase + 1 });

  // Simulate a process sleep: the armed timer becomes overdue without the clock
  // stopping at the boundary, so the tick arrives after expiry.
  timers.sleep(phase + 5_000);
  timers.advance(0);

  assert.deepEqual(dispatched, [], "a run after expiry is never delivered");
  assert.equal(registry.has(task.id), false);
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );
});

test("expiry while busy removes the task from the registry, timer, queue, and persistence", () => {
  const { timers, registry, scheduler, dispatched, events, setIdle } = jitteredSetup(true);
  setIdle(false);
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  const task = scheduler.scheduleFixed(MINUTE_MS, "busy", { expiresAt: phase });

  timers.advance(phase); // the boundary exactly at expiry arrives while busy

  assert.deepEqual(dispatched, [], "a busy expiry never dispatches");
  assert.deepEqual(scheduler.dueTaskIds(), [], "the queued run is dropped with the task");
  assert.equal(registry.has(task.id), false, "the task leaves the registry");
  assert.equal(timers.pendingCount, 0, "its timer is cleared");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
    "the expiry is persisted as a tombstone",
  );

  setIdle(true);
  assert.equal(scheduler.flush(), false);
  assert.deepEqual(dispatched, [], "the expired run cannot be resurrected at the next idle point");
});

test("a queued run that outlives its expiry is dropped at flush time", () => {
  const { timers, registry, scheduler, dispatched, events, setIdle } = jitteredSetup(true);
  setIdle(false);
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  const task = scheduler.scheduleFixed(MINUTE_MS, "jump", { expiresAt: phase + 90_000 });

  timers.advance(phase);
  assert.deepEqual(scheduler.dueTaskIds(), [task.id], "the run is queued while busy");
  assert.equal(registry.has(task.id), true, "a future boundary still fits inside the expiry");

  // The clock jumps past the expiry without the queued boundary firing.
  timers.sleep(120_000);
  setIdle(true);
  assert.equal(scheduler.flush(), false);

  assert.deepEqual(dispatched, [], "the queued run is dropped, not delivered after expiry");
  assert.equal(registry.has(task.id), false);
  assert.deepEqual(scheduler.dueTaskIds(), []);
  assert.equal(timers.pendingCount, 0);
  assert.equal(events.filter((event) => event.kind === "delete").length, 1);
});

test("a default-lifetime task keeps running until seven days, then expires", () => {
  const { timers, registry, scheduler, dispatched, events } = jitteredSetup();
  const phase = jitterOffsetMs("t1", HOUR_MS);
  scheduler.scheduleFixed(HOUR_MS, "hourly");

  timers.advance(DEFAULT_TASK_TTL_MS);

  // Boundaries are phase + k hours; 168 of them fall inside seven days.
  assert.equal(dispatched.length, 168, "each hourly boundary inside the lifetime runs once");
  assert.equal(dispatched[0], "hourly");
  assert.equal(registry.size, 0, "the task is gone once no boundary fits the lifetime");
  assert.equal(timers.pendingCount, 0);
  assert.ok(phase < HOUR_MS);
  assert.equal(events.filter((event) => event.kind === "delete").length, 1);
});

// ---------------------------------------------------------------------------
// Restore near and after expiry
// ---------------------------------------------------------------------------

test("a restored task whose last boundary is at its expiry fires once, then is removed", () => {
  const { timers, registry, scheduler, dispatched, events } = jitteredSetup();
  const phase = jitterOffsetMs("t1", MINUTE_MS);
  const task = scheduler.restore({
    id: "t1",
    prompt: "resume",
    mode: "fixed",
    createdAt: 0,
    schedule: { intervalMs: MINUTE_MS, anchor: 0 },
    nextFireAt: phase,
    expiresAt: phase,
  });

  assert.ok(task);
  assert.equal(registry.get("t1")?.nextFireAt, phase, "the last in-lifetime boundary is kept");
  timers.advance(phase);
  assert.deepEqual(dispatched, ["resume"]);
  assert.equal(registry.has("t1"), false);
  assert.equal(timers.pendingCount, 0);
  assert.equal(events.filter((event) => event.kind === "delete").length, 1);
});

test("a restored task whose expiry already passed is not armed or tracked", () => {
  const { timers, registry, scheduler, dispatched } = jitteredSetup();
  timers.clock = 1_000;
  const task = scheduler.restore({
    id: "t1",
    prompt: "gone",
    mode: "fixed",
    createdAt: 0,
    schedule: { intervalMs: MINUTE_MS, anchor: 0 },
    nextFireAt: 60_000,
    expiresAt: 500,
  });

  assert.equal(task, undefined, "restore reports an already-expired task as not restored");
  assert.equal(registry.size, 0);
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(scheduler.trackedTaskIds(), []);
  timers.advance(10 * MINUTE_MS);
  assert.deepEqual(dispatched, []);
});

test("replay drops fixed tasks past the default seven-day lifetime", () => {
  const persisted = createTaskEvent({
    id: "old",
    prompt: "old",
    mode: "fixed",
    createdAt: 0,
    schedule: { intervalMs: MINUTE_MS, anchor: 0 },
  });
  assert.deepEqual(replayEvents([persisted], DEFAULT_TASK_TTL_MS).tasks, [], "past the default lifetime");
  assert.equal(replayEvents([persisted], DEFAULT_TASK_TTL_MS - 1).tasks.length, 1, "inside the lifetime");
});

test("the /loop command persists the seven-day default expiry for a fixed loop", async () => {
  const timers = new FakeTimers();
  const pi = new FakePi();
  const ctx = new FakeCtx();
  createLoopExtension(pi.asExtensionApi(), {
    configPath: "/tmp/loop.json",
    timers,
    readFile: async () => {
      throw missingFile();
    },
    registry: testRegistry(timers),
  });

  timers.clock = 5_000;
  await pi.run("loop", "every 1min ping", ctx);

  const event = pi.appended[0]!.data as { kind: string; task: { expiresAt?: number; nextFireAt?: number } };
  assert.equal(event.kind, "create");
  assert.equal(event.task.expiresAt, 5_000 + DEFAULT_TASK_TTL_MS, "the default bound reaches persistence");
  assert.equal(event.task.nextFireAt, MINUTE_MS, "the command loop stays on the boundary grid (jitter disabled here)");
});

