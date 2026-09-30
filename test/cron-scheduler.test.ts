/**
 * Scheduler integration for the cron and one-shot representations: both run on
 * the existing registry, due queue, timers, and persistence — there is no second
 * scheduler. Uses the shared deterministic fake clock.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LoopScheduler } from "../src/loop-core.ts";
import type { PersistedEvent } from "../src/persistence.ts";
import { MAX_CADENCE_MS } from "../src/schedule.ts";
import { FakeTimers, testRegistry } from "./helpers.ts";

function setup() {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const events: PersistedEvent[] = [];
  let idle = true;
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
  return {
    timers,
    registry,
    scheduler,
    dispatched,
    events,
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

const CRON = { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" } as const;

test("scheduleCron creates a fixed task on the cron representation and fires", () => {
  const { timers, registry, scheduler, dispatched, events } = setup();
  const task = scheduler.scheduleCron("*/5 * * * *", "ping", { timeZone: "UTC" });

  assert.equal(task.mode, "fixed");
  assert.deepEqual(task.schedule, { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" });
  assert.equal(task.nextFireAt, 5 * 60_000, "the first occurrence is the next 5-minute boundary");
  assert.equal(timers.pendingCount, 1);
  assert.deepEqual(dispatched, [], "a cron task waits for its first occurrence");

  timers.advance(5 * 60_000);
  assert.deepEqual(dispatched, ["ping"]);
  assert.equal(registry.get(task.id)?.nextFireAt, 10 * 60_000, "the next occurrence advances");
  assert.equal(events[0]?.kind, "create");
});

test("cron occurrences coalesce while busy and skip the missed backlog", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const task = scheduler.scheduleCron("*/5 * * * *", "poll", { timeZone: "UTC" });

  setIdle(false);
  timers.advance(15 * 60_000);
  assert.deepEqual(dispatched, [], "busy: nothing is delivered");
  assert.deepEqual(scheduler.dueTaskIds(), [task.id], "repeated misses coalesce into one queued run");
  assert.equal(registry.get(task.id)?.nextFireAt, 20 * 60_000, "the schedule advanced past the misses");

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["poll"], "one run, not one per missed occurrence");
  assert.equal(
    registry.get(task.id)?.nextFireAt,
    20 * 60_000,
    "the next occurrence is recomputed from the expression, not the missed backlog",
  );
});

test("restoring a cron task recomputes the next future occurrence, skipping missed runs", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  timers.clock = 1_000_000;
  const task = scheduler.restore({
    id: "cron-1",
    prompt: "resume",
    mode: "fixed",
    createdAt: 0,
    schedule: { ...CRON },
    nextFireAt: 300_000, // stale: passed long ago
    expiresAt: 10_000_000,
  });

  assert.ok(task);
  assert.equal(
    registry.get("cron-1")?.nextFireAt,
    1_200_000,
    "the next boundary is recomputed from the expression, never the stale time",
  );
  timers.advance(200_000);
  assert.deepEqual(dispatched, ["resume"]);
  assert.deepEqual(dispatched, ["resume"], "no missed occurrence is replayed");
});

test("a cron task expires at its last fitting occurrence and tombstones itself", () => {
  const { timers, registry, scheduler, dispatched, events } = setup();
  scheduler.scheduleCron("*/5 * * * *", "brief", { timeZone: "UTC", expiresAt: 5 * 60_000 });

  timers.advance(5 * 60_000);
  assert.deepEqual(dispatched, ["brief"], "the occurrence at the expiry still runs");
  assert.equal(registry.size, 0, "the task is removed once no future occurrence fits");
  assert.equal(timers.pendingCount, 0);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["create", "delete"],
  );

  timers.advance(60 * 60_000);
  assert.deepEqual(dispatched, ["brief"], "an expired cron task never runs again");
});

test("a far-future cron occurrence is armed without setTimeout overflow", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  timers.clock = Date.UTC(2026, 0, 2);
  const occurrence = Date.UTC(2027, 0, 1);
  scheduler.scheduleCron("0 0 1 1 *", "yearly", {
    timeZone: "UTC",
    expiresAt: Date.UTC(2030, 0, 1),
  });
  assert.equal(registry.list()[0]?.nextFireAt, occurrence);

  // Advancing one maximum timer delay fires the capped timer early; it re-arms
  // for the remainder and still delivers nothing yet.
  timers.advance(MAX_CADENCE_MS);
  assert.deepEqual(dispatched, [], "an early capped wake is not a real occurrence");
  assert.equal(timers.pendingCount, 1, "the timer is re-armed for the remainder");

  timers.advance(occurrence - timers.clock);
  assert.deepEqual(dispatched, ["yearly"], "the occurrence is reached despite the cap");
});

test("a missed one-shot is dropped on restore and never replayed", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  timers.clock = 1_000_000;
  const restored = scheduler.restore({
    id: "once-1",
    prompt: "late",
    mode: "one-shot",
    createdAt: 0,
    nextFireAt: 500_000,
  });

  assert.equal(restored, undefined, "a missed one-shot is not restored");
  assert.equal(registry.size, 0);
  timers.advance(10_000_000);
  assert.deepEqual(dispatched, [], "and it never fires later");
});

test("interval and cron tasks share one registry and scheduler", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  scheduler.scheduleFixed(60_000, "interval");
  scheduler.scheduleCron("*/2 * * * *", "cron", { timeZone: "UTC" });

  assert.equal(registry.size, 2, "both representations coexist in one registry");
  assert.deepEqual(
    registry.list().map((task) => task.mode),
    ["fixed", "fixed"],
  );

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["interval"], "the interval task fires on its boundary");
  timers.advance(60_000);
  assert.deepEqual(
    dispatched,
    ["interval", "cron", "interval"],
    "the cron task fires on its 2-minute occurrence alongside the interval task",
  );
});
