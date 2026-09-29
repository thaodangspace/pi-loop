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
import { FakeTimers } from "./helpers.ts";

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
});

test("invalid intervals are rejected", () => {
  for (const bad of ["", "0s", "0min", "-5min", "1.5h", "5x", "min", "5", "1h30min"]) {
    assert.throws(() => parseInterval(bad), IntervalError, `expected ${JSON.stringify(bad)} to fail`);
  }
  assert.throws(() => parseInterval("99999999999999999999h"), /too large|positive/);
  assert.throws(() => parseInterval("2147484s"), /too large/);
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
});

test("the first tick fires one full interval after start", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
    }, () => true);

  scheduler.start(1_000, "ping");
  timers.advance(999);
  assert.deepEqual(dispatched, []);
  timers.advance(1);
  assert.deepEqual(dispatched, ["ping"]);
});

test("the loop repeats on each interval until stopped", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
    }, () => true);

  scheduler.start(1_000, "tick");
  timers.advance(3_000);
  assert.deepEqual(dispatched, ["tick", "tick", "tick"]);
  assert.equal(timers.pendingCount, 1, "exactly one timer stays armed");
});

test("busy ticks coalesce into a single pending run flushed once idle", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
    }, () => idle);

  scheduler.start(1_000, "ping");
  timers.advance(1_000);
  timers.advance(1_000);
  timers.advance(1_000);
  assert.deepEqual(dispatched, [], "busy ticks must not dispatch");
  assert.equal(scheduler.status().pending, true);

  assert.equal(scheduler.flush(), false, "flush while busy is a no-op");
  idle = true;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ping"]);
  assert.equal(scheduler.flush(), false, "pending is cleared after one dispatch");
  assert.equal(timers.pendingCount, 1, "the periodic timer is still armed");
});

test("replacing a loop cancels the old timer and stale callbacks", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
    }, () => true);

  scheduler.start(1_000, "old");
  timers.advance(500);
  scheduler.start(1_000, "new");
  timers.advance(500);
  assert.deepEqual(dispatched, [], "the replaced loop's first tick must not fire");
  timers.advance(500);
  assert.deepEqual(dispatched, ["new"]);
});

test("a stale timer callback cannot dispatch after replacement", () => {
  const captured: Array<() => void> = [];
  const timers: SchedulerDeps = {
    setTimer: (fn) => captured.push(fn),
    clearTimer: () => {},
  };
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
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
  const dispatched: string[] = [];
  let idle = false;
  const scheduler = new LoopScheduler(timers, (task) => {
      dispatched.push(task);
    }, () => idle);

  scheduler.start(1_000, "ping");
  timers.advance(1_000);
  assert.equal(scheduler.stop(), true);
  assert.equal(timers.pendingCount, 0);
  assert.equal(scheduler.stop(), false, "stopping twice reports no active loop");
  idle = true;
  assert.equal(scheduler.flush(), false);
  timers.advance(5_000);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.status().active, false);
});

test("disposal is idempotent and blocks future starts", () => {
  const timers = new FakeTimers();
  const scheduler = new LoopScheduler(timers, () => {}, () => true);

  scheduler.start(1_000, "ping");
  scheduler.dispose();
  scheduler.dispose();
  assert.equal(timers.pendingCount, 0);
  assert.throws(() => scheduler.start(1_000, "again"), /disposed/);
});

test("a throwing dispatch is reported, retained as one pending run, and retried once", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const scheduler = new LoopScheduler(
    timers,
    () => {
      if (fail) throw new Error("boom");
      dispatched.push("ok");
    },
    () => true,
    (error) => errors.push(error),
  );

  scheduler.start(1_000, "ping");
  timers.advance(1_000);
  assert.equal(errors.length, 1);
  assert.deepEqual(dispatched, [], "a failed dispatch must not also deliver");
  assert.equal(scheduler.status().pending, true, "the run stays pending for a bounded retry");

  timers.advance(1_000);
  fail = false;
  timers.advance(1_000);
  assert.deepEqual(dispatched, ["ok"]);
  assert.equal(scheduler.status().pending, false);
});

test("start rejects an empty task", () => {
  const scheduler = new LoopScheduler(new FakeTimers(), () => {}, () => true);
  assert.throws(() => scheduler.start(1_000, "   "), /empty/);
});
