import assert from "node:assert/strict";
import test from "node:test";
import {
  formatInterval,
  IntervalError,
  LoopScheduler,
  parseInterval,
  parseLoopCommand,
  type SchedulerDeps,
} from "../src/loop-core.ts";
import type { ScheduledTask } from "../src/task-registry.ts";
import { FakeTimers, testRegistry } from "./helpers.ts";

test("implicit tasks keep literal text and request the default interval", () => {
  assert.deepEqual(parseLoopCommand("check all tmux sessions and handle results"), {
    type: "start",
    task: "check all tmux sessions and handle results",
  });
  assert.deepEqual(parseLoopCommand("  check Things and report changes  "), {
    type: "start",
    task: "check Things and report changes",
  });
});

test("Claude-style leading interval keeps the schedule out of the task", () => {
  assert.deepEqual(parseLoopCommand("5m check deploy"), {
    type: "start",
    intervalMs: 300_000,
    task: "check deploy",
  });
  assert.deepEqual(parseLoopCommand("5 min check deploy"), {
    type: "start",
    intervalMs: 300_000,
    task: "check deploy",
  });
  assert.deepEqual(parseLoopCommand("1h reset the queue"), {
    type: "start",
    intervalMs: 3_600_000,
    task: "reset the queue",
  });
});

test("Claude-style trailing interval parses after the prompt", () => {
  assert.deepEqual(parseLoopCommand("check deploy every 5m"), {
    type: "start",
    intervalMs: 300_000,
    task: "check deploy",
  });
  assert.deepEqual(parseLoopCommand("check Things every 30 min"), {
    type: "start",
    intervalMs: 1_800_000,
    task: "check Things",
  });
});

test("bare and interval-only forms are recognized as maintenance loops", () => {
  assert.deepEqual(parseLoopCommand(""), { type: "maintenance" });
  assert.deepEqual(parseLoopCommand("   "), { type: "maintenance" });
  assert.deepEqual(parseLoopCommand("5m"), { type: "maintenance", intervalMs: 300_000 });
  assert.deepEqual(parseLoopCommand("5 min"), { type: "maintenance", intervalMs: 300_000 });
  assert.deepEqual(parseLoopCommand("every 5m"), { type: "maintenance", intervalMs: 300_000 });
});

test("explicit intervals parse glued and spaced forms", () => {
  assert.deepEqual(parseLoopCommand("every 30min check Things and report changes"), {
    type: "start",
    intervalMs: 1_800_000,
    task: "check Things and report changes",
  });
  assert.deepEqual(parseLoopCommand("every 30 min check Things"), {
    type: "start",
    intervalMs: 1_800_000,
    task: "check Things",
  });
  assert.deepEqual(parseLoopCommand("every 1h reset the queue"), {
    type: "start",
    intervalMs: 3_600_000,
    task: "reset the queue",
  });
});

test("interval units accept singular, plural, and abbreviated spellings", () => {
  assert.equal(parseInterval("1s"), 1_000);
  assert.equal(parseInterval("90sec"), 90_000);
  assert.equal(parseInterval("2minutes"), 120_000);
  assert.equal(parseInterval("5min"), 300_000);
  assert.equal(parseInterval("1hour"), 3_600_000);
  assert.equal(parseInterval("3hours"), 10_800_000);
  assert.equal(parseInterval("1d"), 86_400_000);
  assert.equal(parseInterval("2days"), 172_800_000);
});

test("invalid intervals are rejected", () => {
  for (const bad of ["", "0s", "0min", "-5min", "1.5h", "5x", "min", "5", "1h30min", "1w"]) {
    assert.throws(() => parseInterval(bad), IntervalError, `expected ${JSON.stringify(bad)} to fail`);
  }
  assert.throws(() => parseInterval("99999999999999999999h"), /too large|positive/);
  assert.throws(() => parseInterval("2147484s"), /too large/);
  assert.throws(() => parseInterval("25d"), /too large/);
});

test("malformed /loop commands return usage without a task", () => {
  const noEvery = parseLoopCommand("every");
  assert.deepEqual(noEvery, { type: "usage", reason: "missing interval after every" });
  assert.equal(parseLoopCommand("every 0s ping").type, "usage");
  assert.equal(parseLoopCommand("every abc ping").type, "usage");
});

test("interval-looking malformed input fails closed instead of becoming a task", () => {
  for (const bad of ["5x ping", "5 ping", "0s ping", "-5m ping", "1h30min ping", "1.5h ping", ".5h ping", "-.5h ping"]) {
    assert.equal(parseLoopCommand(bad).type, "usage", `expected ${JSON.stringify(bad)} to fail closed`);
  }
  assert.equal(parseLoopCommand("5").type, "usage");
  assert.equal(parseLoopCommand("every 5x ping").type, "usage");
  assert.equal(parseLoopCommand("check deploy every 5x").type, "usage");
  assert.equal(parseLoopCommand("check deploy every .5h").type, "usage");
  assert.equal(parseLoopCommand("check deploy every -.5h").type, "usage");
  assert.equal(parseLoopCommand("check deploy every").type, "usage");
  assert.equal(parseLoopCommand("check deploy every 5").type, "usage");
});

test("a non-numeric every clause stays a literal task", () => {
  assert.deepEqual(parseLoopCommand("review every file in src"), {
    type: "start",
    task: "review every file in src",
  });
});

test("stop and status are exact commands; otherwise text stays a task", () => {
  assert.deepEqual(parseLoopCommand("stop"), { type: "stop" });
  assert.deepEqual(parseLoopCommand("  STOP  "), { type: "stop" });
  assert.deepEqual(parseLoopCommand("status"), { type: "status" });
  assert.deepEqual(parseLoopCommand("stop the build server and restart it"), {
    type: "start",
    task: "stop the build server and restart it",
  });
  assert.deepEqual(parseLoopCommand("status report for the team"), {
    type: "start",
    task: "status report for the team",
  });
});

test("formatInterval uses the largest exact unit", () => {
  assert.equal(formatInterval(1_000), "1s");
  assert.equal(formatInterval(60_000), "1min");
  assert.equal(formatInterval(90_000), "90s");
  assert.equal(formatInterval(3_600_000), "1h");
  assert.equal(formatInterval(86_400_000), "1d");
  assert.equal(formatInterval(2 * 86_400_000), "2d");
});

test("the first tick fires at the next cadence boundary, never immediately", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, testRegistry(timers), (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(60_000, "ping");
  timers.advance(59_999);
  assert.deepEqual(dispatched, []);
  timers.advance(1);
  assert.deepEqual(dispatched, ["ping"]);
});

test("the loop repeats on each boundary until stopped", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, testRegistry(timers), (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(60_000, "tick");
  timers.advance(3 * 60_000);
  assert.deepEqual(dispatched, ["tick", "tick", "tick"]);
  assert.equal(timers.pendingCount, 1, "exactly one timer stays armed");
});

test("the scheduler reports the normalized cadence for a sub-minute interval", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const scheduler = new LoopScheduler(timers, registry, () => {}, () => true);

  scheduler.start(5_000, "fast");
  assert.equal(scheduler.status().intervalMs, 60_000, "5s normalizes to the 1min cadence");
  assert.equal(registry.list()[0]?.schedule?.intervalMs, 60_000);
  assert.equal(registry.list()[0]?.nextFireAt, 60_000, "the first boundary is one cadence step out");

  scheduler.start(7 * 60_000, "awkward");
  assert.equal(scheduler.status().intervalMs, 6 * 60_000, "7m normalizes to 6m");
  scheduler.start(86_400_000, "daily");
  assert.equal(scheduler.status().intervalMs, 86_400_000, "day intervals are supported");
});

test("daily boundaries stay aligned across days", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const registry = testRegistry(timers);
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(86_400_000, "daily");
  assert.equal(registry.list()[0]?.nextFireAt, 86_400_000);
  timers.advance(86_400_000);
  assert.deepEqual(dispatched, ["daily"]);
  assert.equal(registry.list()[0]?.nextFireAt, 2 * 86_400_000);
});

test("boundaries are absolute, so restarting does not reset the grid", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const registry = testRegistry(timers);
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  timers.clock = 90_000;
  scheduler.start(5 * 60_000, "aligned");
  assert.equal(registry.list()[0]?.nextFireAt, 5 * 60_000, "the next 5-minute boundary, not start + 5m");

  timers.advance(209_999);
  assert.deepEqual(dispatched, [], "the first run is not immediate");
  timers.advance(1);
  assert.deepEqual(dispatched, ["aligned"]);
  assert.equal(registry.list()[0]?.nextFireAt, 10 * 60_000);
});

test("busy ticks coalesce into a single pending run flushed once idle", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => idle);

  scheduler.start(60_000, "ping");
  timers.advance(60_000);
  timers.advance(60_000);
  timers.advance(60_000);
  assert.deepEqual(dispatched, [], "busy ticks must not dispatch");
  assert.equal(scheduler.status().pending, true);
  assert.equal(registry.list()[0]?.pending, true, "the registry records the queued run");

  assert.equal(scheduler.flush(), false, "flush while busy is a no-op");
  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ping"]);
  assert.equal(scheduler.flush(), false, "pending is cleared after one dispatch");
  assert.equal(registry.list()[0]?.pending, false);
  assert.equal(timers.pendingCount, 1, "the periodic timer is still armed");
});

test("a long busy period does not drift boundaries or accumulate a backlog", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => idle);

  scheduler.start(60_000, "poll");
  idle = false;
  timers.advance(5 * 60_000);
  assert.deepEqual(dispatched, [], "no run while busy");
  assert.equal(registry.list()[0]?.nextFireAt, 6 * 60_000, "boundaries advanced with the grid, not the completion time");

  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["poll"], "five missed boundaries collapse into one run");

  // The next boundary is unchanged by how long the flush took.
  timers.advance(60_000);
  assert.deepEqual(dispatched, ["poll", "poll"]);
  assert.equal(registry.list()[0]?.nextFireAt, 7 * 60_000);
});

test("a clock jump delivers one coalesced run and resumes on the grid", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(60_000, "jump");
  assert.equal(registry.list()[0]?.nextFireAt, 60_000);

  // Simulate the process sleeping through ten minutes.
  timers.sleep(10 * 60_000);
  timers.advance(0);

  assert.deepEqual(dispatched, ["jump"], "ten missed boundaries collapse into one run");
  assert.equal(registry.list()[0]?.nextFireAt, 11 * 60_000, "the next boundary is the first future grid point");

  timers.advance(60_000);
  assert.deepEqual(dispatched, ["jump", "jump"]);
});

test("replacing a loop cancels the old timer and stale callbacks", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(60_000, "old");
  const oldId = registry.list()[0]!.id;
  timers.advance(30_000);
  scheduler.start(60_000, "new");
  assert.equal(registry.size, 1, "replacement leaves exactly one task");
  const newId = registry.list()[0]!.id;
  assert.notEqual(newId, oldId, "the replacement gets a fresh stable ID");
  assert.equal(registry.has(oldId), false, "the replaced task is removed");
  timers.advance(29_999);
  assert.deepEqual(dispatched, [], "the replaced loop's first tick must not fire");
  timers.advance(1);
  assert.deepEqual(dispatched, ["new"]);
});

test("a stale timer callback cannot dispatch after replacement", () => {
  const captured: Array<() => void> = [];
  const timers: SchedulerDeps = {
    now: () => 0,
    setTimer: (fn) => captured.push(fn),
    clearTimer: () => {},
  };
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, testRegistry(new FakeTimers()), (task) => {
      dispatched.push(task.prompt);
    }, () => true);

  scheduler.start(1_000, "old");
  const stale = captured[0]!;
  scheduler.start(1_000, "new");
  stale();
  assert.deepEqual(dispatched, [], "the generation guard blocks the stale callback");
  captured.at(-1)!();
  assert.deepEqual(dispatched, ["new"]);
});

test("stop is idempotent, cancels the timer, and drops pending work", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      dispatched.push(task.prompt);
    }, () => idle);

  scheduler.start(60_000, "ping");
  timers.advance(60_000);
  assert.equal(scheduler.stop(), true);
  assert.equal(timers.pendingCount, 0);
  assert.equal(registry.size, 0, "stopping removes the task from the registry");
  assert.equal(scheduler.stop(), false, "stopping twice reports no active loop");
  idle = true;
  assert.equal(scheduler.flush(), false);
  timers.advance(5 * 60_000);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.status().active, false);
});

test("disposal is idempotent and blocks future starts", () => {
  const timers = new FakeTimers();
  const scheduler = new LoopScheduler(timers, testRegistry(timers), () => {}, () => true);

  scheduler.start(60_000, "ping");
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(timers.pendingCount, 0);
  assert.throws(() => scheduler.start(60_000, "again"), /disposed/);
});

test("a throwing dispatch is reported, retained as one pending run, and retried once", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    () => {
      if (fail) throw new Error("boom");
      dispatched.push("ok");
    },
    () => true,
    (error) => errors.push(error),
  );

  scheduler.start(60_000, "ping");
  timers.advance(60_000);
  assert.equal(errors.length, 1);
  assert.deepEqual(dispatched, [], "a failed dispatch must not also deliver");
  assert.equal(scheduler.status().pending, true, "the run stays pending for a bounded retry");
  assert.equal(registry.list()[0]?.pending, true, "the registry records the retry");

  timers.advance(60_000);
  fail = false;
  timers.advance(60_000);
  assert.deepEqual(dispatched, ["ok"]);
  assert.equal(scheduler.status().pending, false);
});

test("start rejects an empty task", () => {
  const timers = new FakeTimers();
  const scheduler = new LoopScheduler(timers, testRegistry(timers), () => {}, () => true);
  assert.throws(() => scheduler.start(60_000, "   "), /empty/);
});

test("the active loop is represented as a fixed registry task with injected time", () => {
  const timers = new FakeTimers();
  timers.clock = 10_000;
  const registry = testRegistry(timers);
  const scheduler = new LoopScheduler(timers, registry, () => {}, () => true);

  scheduler.start(5 * 60_000, "check deploy");
  const [task] = registry.list();
  assert.ok(task, "start registers a task");
  assert.equal(task.id, "t1");
  assert.equal(task.prompt, "check deploy");
  assert.equal(task.mode, "fixed");
  assert.equal(task.createdAt, 10_000, "createdAt comes from the injected clock");
  assert.deepEqual(task.schedule, { intervalMs: 5 * 60_000, anchor: 0 }, "the schedule is stored on the task");
  assert.equal(task.nextFireAt, 5 * 60_000, "the next boundary is on the cadence grid");
  assert.equal(task.pending, false);

  timers.advance(5 * 60_000 - 10_000);
  const [afterTick] = registry.list();
  assert.equal(afterTick!.id, task.id, "the ID is stable across ticks");
  assert.equal(afterTick!.nextFireAt, 10 * 60_000, "the next boundary advances one cadence step");

  scheduler.stop();
  assert.equal(registry.size, 0);
});

test("a registry-backed dispatch receives the full task record", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const received: ScheduledTask[] = [];
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      received.push(task);
    }, () => true);

  scheduler.start(60_000, "ping");
  timers.advance(60_000);
  assert.equal(received.length, 1);
  assert.equal(received[0]!.id, "t1");
  assert.equal(received[0]!.prompt, "ping");
  assert.equal(received[0]!.mode, "fixed");
  assert.equal(received[0]!.schedule?.intervalMs, 60_000, "the snapshot carries the schedule");
  assert.equal(received[0]!.pending, false, "the snapshot matches the authoritative registry");
});

test("flush dispatches the snapshot with pending already cleared", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const received: ScheduledTask[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, registry, (task) => {
      received.push(task);
    }, () => idle);

  scheduler.start(60_000, "ping");
  timers.advance(60_000);
  assert.equal(registry.list()[0]!.pending, true, "a busy tick is queued");

  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.equal(received[0]!.pending, false, "the dispatched snapshot is not the stale pre-update one");
  assert.equal(registry.list()[0]!.pending, false);
});

test("a rejected dispatch from a replaced task cannot requeue the new task", async () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const rejectors: Array<(error: unknown) => void> = [];
  const scheduler = new LoopScheduler(
    timers,
    registry,
    () => new Promise<void>((_resolve, reject) => rejectors.push(reject)),
    () => true,
  );

  scheduler.start(60_000, "old");
  timers.advance(60_000);
  assert.equal(rejectors.length, 1, "the old task dispatched an async run");

  // Replace the loop before the old dispatch promise settles.
  scheduler.start(60_000, "new");
  const newId = registry.list()[0]!.id;
  assert.equal(registry.get(newId)?.pending, false);

  rejectors[0]!(new Error("boom"));
  await Promise.resolve();

  assert.equal(
    registry.get(newId)?.pending,
    false,
    "a stale rejection must not mark the replacement task pending",
  );
  assert.equal(scheduler.flush(), false, "the replacement must not run before its first boundary");

  // The replacement's own first run still happens on the cadence grid.
  timers.advance(60_000);
  assert.equal(rejectors.length, 2, "the replacement fires on schedule, never early");
});


