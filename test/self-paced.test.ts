import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWakeupDelay,
  LoopScheduler,
  MAX_WAKEUP_DELAY_MS,
  MIN_WAKEUP_DELAY_MS,
  WakeupError,
  type SchedulerDeps,
} from "../src/loop-core.ts";
import { HOUR_MS, MINUTE_MS } from "../src/schedule.ts";
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

test("clampWakeupDelay bounds delays to 1 minute–1 hour", () => {
  assert.equal(MIN_WAKEUP_DELAY_MS, MINUTE_MS);
  assert.equal(MAX_WAKEUP_DELAY_MS, HOUR_MS);
  assert.equal(clampWakeupDelay(30_000), MINUTE_MS, "below the floor clamps up");
  assert.equal(clampWakeupDelay(0), MINUTE_MS);
  assert.equal(clampWakeupDelay(-5_000), MINUTE_MS);
  assert.equal(clampWakeupDelay(5 * MINUTE_MS), 5 * MINUTE_MS, "an in-range delay is untouched");
  assert.equal(clampWakeupDelay(2 * HOUR_MS), HOUR_MS, "above the ceiling clamps down");
  assert.throws(() => clampWakeupDelay(Number.NaN), WakeupError);
  assert.throws(() => clampWakeupDelay(Number.POSITIVE_INFINITY), WakeupError);
});

test("startSelfPaced registers a self-paced task that runs immediately when idle", () => {
  const { timers, registry, scheduler, dispatched } = setup();

  const created = scheduler.startSelfPaced("check deploy");
  assert.equal(created.mode, "self-paced");
  assert.equal(created.prompt, "check deploy");
  assert.equal(created.nextFireAt, 0, "the first run is due immediately");
  assert.equal(created.pending, false);
  assert.equal(timers.pendingCount, 1, "one timer is armed for the immediate run");

  assert.deepEqual(dispatched, [], "the run waits for the timer to fire");
  timers.advance(0);
  assert.deepEqual(dispatched, ["check deploy"]);

  const status = scheduler.status();
  assert.equal(status.active, true);
  assert.equal(status.mode, "self-paced");
  assert.equal(status.awaitingDecision, true, "the delivered iteration now owes a decision");
  assert.equal(status.pending, false);
  assert.equal(status.intervalMs, 0);
  assert.equal(timers.pendingCount, 0, "no wakeup is armed until the iteration chooses one");
});

test("scheduleNextWakeup clamps and reports the effective delay", () => {
  const { timers, registry, scheduler } = setup();
  const created = scheduler.startSelfPaced("check deploy");

  const tooSoon = scheduler.scheduleNextWakeup(30_000, "back off a little");
  assert.deepEqual(tooSoon, {
    requestedMs: 30_000,
    delayMs: MINUTE_MS,
    clamped: true,
    nextFireAt: MINUTE_MS,
    reason: "back off a little",
  });
  assert.equal(registry.get(created.id)?.nextFireAt, MINUTE_MS);
  assert.equal(registry.get(created.id)?.reason, "back off a little");
  assert.equal(timers.pendingCount, 1);

  const inRange = scheduler.scheduleNextWakeup(5 * MINUTE_MS);
  assert.equal(inRange.delayMs, 5 * MINUTE_MS);
  assert.equal(inRange.clamped, false);
  assert.equal(inRange.nextFireAt, 5 * MINUTE_MS);

  const tooLate = scheduler.scheduleNextWakeup(2 * HOUR_MS, "way too long");
  assert.equal(tooLate.delayMs, HOUR_MS);
  assert.equal(tooLate.clamped, true);
  assert.equal(
    registry.get(created.id)?.reason,
    "way too long",
    "a later wakeup replaces the stored reason",
  );

  scheduler.scheduleNextWakeup(10 * MINUTE_MS);
  assert.equal(registry.get(created.id)?.reason, undefined, "a reason-less wakeup clears the old reason");

  assert.throws(() => scheduler.scheduleNextWakeup(Number.NaN), WakeupError);
});

test("wakeup scheduling is rejected without an active self-paced loop", () => {
  const { scheduler } = setup();
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);

  scheduler.start(MINUTE_MS, "fixed");
  assert.throws(
    () => scheduler.scheduleNextWakeup(MINUTE_MS),
    WakeupError,
    "a fixed loop has no wakeup operation",
  );
});

test("each iteration can choose a different next delay", () => {
  const { timers, scheduler, dispatched } = setup();
  scheduler.startSelfPaced("poll");

  timers.advance(0);
  assert.deepEqual(dispatched, ["poll"]);

  scheduler.scheduleNextWakeup(10 * MINUTE_MS, "wait for CI");
  timers.advance(9 * MINUTE_MS);
  assert.deepEqual(dispatched, ["poll"], "the chosen delay is honoured exactly");
  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["poll", "poll"]);

  scheduler.scheduleNextWakeup(MINUTE_MS, "check again soon");
  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["poll", "poll", "poll"], "the next iteration chose a shorter delay");
});

test("a missing choice gets one bounded fallback wakeup, then terminates", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  scheduler.startSelfPaced("deploy watch", { fallbackDelayMs: 5 * MINUTE_MS });

  timers.advance(0);
  assert.deepEqual(dispatched, ["deploy watch"]);

  const fallback = scheduler.settleIteration();
  assert.deepEqual(fallback, {
    action: "fallback",
    delayMs: 5 * MINUTE_MS,
    nextFireAt: 5 * MINUTE_MS,
  });
  assert.equal(scheduler.status().fallbackUsed, true);
  assert.equal(registry.get(registry.list()[0]!.id)?.nextFireAt, 5 * MINUTE_MS);
  assert.equal(dispatched.length, 1, "the fallback has not run yet");

  timers.advance(5 * MINUTE_MS);
  assert.deepEqual(dispatched, ["deploy watch", "deploy watch"]);

  const terminated = scheduler.settleIteration();
  assert.deepEqual(terminated, { action: "terminated" });
  assert.equal(registry.size, 0, "a repeated miss removes the task");
  assert.equal(timers.pendingCount, 0);
  assert.equal(scheduler.status().active, false);

  timers.advance(10 * MINUTE_MS);
  assert.deepEqual(dispatched, ["deploy watch", "deploy watch"], "a terminated loop never runs again");
});

test("the fallback delay is clamped into the supported range", () => {
  const tooShort = setup();
  tooShort.scheduler.startSelfPaced("x", { fallbackDelayMs: 10_000 });
  tooShort.timers.advance(0);
  assert.deepEqual(tooShort.scheduler.settleIteration(), {
    action: "fallback",
    delayMs: MINUTE_MS,
    nextFireAt: MINUTE_MS,
  });

  const tooLong = setup();
  tooLong.scheduler.startSelfPaced("x", { fallbackDelayMs: 5 * HOUR_MS });
  tooLong.timers.advance(0);
  assert.deepEqual(tooLong.scheduler.settleIteration(), {
    action: "fallback",
    delayMs: HOUR_MS,
    nextFireAt: HOUR_MS,
  });
});

test("an explicit reschedule clears the fallback allowance", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  scheduler.startSelfPaced("recover", { fallbackDelayMs: 5 * MINUTE_MS });

  timers.advance(0);
  assert.equal(scheduler.settleIteration().action, "fallback");
  assert.equal(scheduler.status().fallbackUsed, true);

  timers.advance(5 * MINUTE_MS);
  assert.equal(dispatched.length, 2, "the fallback iteration ran");

  scheduler.scheduleNextWakeup(10 * MINUTE_MS, "recovered");
  assert.equal(scheduler.status().fallbackUsed, false, "a real choice resets the allowance");
  assert.deepEqual(scheduler.settleIteration(), { action: "none" }, "the choice already settled the run");

  timers.advance(10 * MINUTE_MS);
  assert.equal(dispatched.length, 3);

  const afterMiss = scheduler.settleIteration();
  assert.equal(afterMiss.action, "fallback", "a later miss falls back again instead of terminating");
  assert.equal(registry.size, 1);
});

test("settleIteration is a no-op without an awaiting self-paced iteration", () => {
  const { scheduler } = setup();
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });

  scheduler.start(MINUTE_MS, "fixed");
  assert.deepEqual(scheduler.settleIteration(), { action: "none" }, "fixed loops never settle iterations");

  scheduler.stop();
  scheduler.startSelfPaced("self");
  assert.deepEqual(
    scheduler.settleIteration(),
    { action: "none" },
    "the first run has not been delivered yet",
  );
});

test("stop cancels the timer, removes the task, and blocks wakeups", () => {
  const { timers, registry, scheduler } = setup();
  scheduler.startSelfPaced("ping");

  assert.equal(scheduler.stop(), true);
  assert.equal(timers.pendingCount, 0);
  assert.equal(registry.size, 0);
  assert.equal(scheduler.stop(), false, "stopping twice reports no active loop");
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);
});

test("a due wakeup during a busy period coalesces and flushes once idle", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  scheduler.startSelfPaced("poll");

  setIdle(false);
  timers.advance(0);
  assert.deepEqual(dispatched, [], "a busy period must not be interrupted");
  assert.equal(scheduler.status().pending, true, "the due run is queued");
  assert.equal(registry.list()[0]?.pending, true);
  assert.equal(timers.pendingCount, 0, "no wakeup is armed while a run is queued");

  assert.equal(scheduler.flush(), false, "flush while busy is a no-op");

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["poll"]);
  assert.equal(scheduler.status().pending, false);
  assert.equal(scheduler.status().awaitingDecision, true);
  assert.equal(scheduler.flush(), false, "the delivered run is not queued again");
});

test("a scheduled wakeup that comes due while busy flushes at the next idle point", () => {
  const { timers, scheduler, dispatched, setIdle } = setup();
  scheduler.startSelfPaced("poll");

  timers.advance(0);
  scheduler.scheduleNextWakeup(MINUTE_MS, "next");

  setIdle(false);
  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["poll"]);
  assert.equal(scheduler.status().pending, true);

  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["poll", "poll"]);
});

test("starting a new loop replaces a self-paced task and resets fallback state", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  const old = scheduler.startSelfPaced("old");
  timers.advance(0);
  assert.equal(scheduler.settleIteration().action, "fallback");
  assert.equal(scheduler.status().fallbackUsed, true);

  scheduler.startSelfPaced("new");
  assert.equal(registry.size, 1, "the old self-paced task is removed");
  assert.equal(registry.get(old.id), undefined);
  assert.equal(scheduler.status().fallbackUsed, false, "replacement begins with a fresh fallback allowance");

  timers.advance(0);
  assert.deepEqual(dispatched, ["old", "new"]);
  assert.equal(
    scheduler.settleIteration().action,
    "fallback",
    "the replacement's first miss falls back rather than terminating",
  );
});

test("a fixed loop can replace a self-paced one and vice versa", () => {
  const { timers, registry, scheduler } = setup();

  scheduler.startSelfPaced("self");
  const selfId = registry.list()[0]!.id;
  scheduler.start(MINUTE_MS, "fixed");
  assert.equal(registry.get(selfId), undefined);
  assert.equal(scheduler.status().mode, "fixed");

  const fixedId = registry.list()[0]!.id;
  scheduler.startSelfPaced("self again");
  assert.equal(registry.get(fixedId), undefined);
  assert.equal(scheduler.status().mode, "self-paced");

  timers.advance(0);
  assert.equal(registry.size, 1);
});

test("deleting the task out from under the scheduler prevents dispatch and wakeups", () => {
  const { timers, registry, scheduler, dispatched } = setup();
  const created = scheduler.startSelfPaced("orphan");
  registry.delete(created.id);

  timers.advance(0);
  assert.deepEqual(dispatched, [], "a deleted task's timer must not dispatch");
  assert.equal(scheduler.status().active, false);
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
});

test("a stale timer callback cannot act after replacement or stop", () => {
  const captured: Array<() => void> = [];
  const timers: SchedulerDeps = {
    now: () => 0,
    setTimer: (fn) => captured.push(fn),
    clearTimer: () => {},
  };
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(
    timers,
    testRegistry(new FakeTimers()),
    (task) => {
      dispatched.push(task.prompt);
    },
    () => true,
  );

  scheduler.startSelfPaced("old");
  const stale = captured[0]!;
  scheduler.startSelfPaced("new");
  stale();
  assert.deepEqual(dispatched, [], "the generation guard blocks the replaced callback");

  captured.at(-1)!();
  assert.deepEqual(dispatched, ["new"]);

  scheduler.stop();
  captured.at(-1)!();
  assert.deepEqual(dispatched, ["new"], "a callback after stop is a no-op");

  scheduler.startSelfPaced("again");
  const again = captured.at(-1)!;
  scheduler.stop();
  again();
  assert.deepEqual(dispatched, ["new"], "a callback captured before stop stays stale");
});

test("an iteration that reschedules during dispatch is not treated as awaiting", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  let scheduler: LoopScheduler;
  let rescheduledOnce = false;
  scheduler = new LoopScheduler(
    timers,
    registry,
    () => {
      dispatched.push("run");
      if (!rescheduledOnce) {
        rescheduledOnce = true;
        // A synchronous reschedule must win over the "awaiting" flag.
        scheduler.scheduleNextWakeup(MINUTE_MS, "chosen inline");
      }
    },
    () => true,
  );

  scheduler.startSelfPaced("poll");
  timers.advance(0);
  assert.deepEqual(dispatched, ["run"]);
  assert.equal(scheduler.status().awaitingDecision, false, "the inline choice already settled the run");
  assert.deepEqual(scheduler.settleIteration(), { action: "none" }, "no fallback is applied");
  assert.equal(timers.pendingCount, 1, "the inline wakeup is armed");

  timers.advance(MINUTE_MS);
  assert.deepEqual(dispatched, ["run", "run"]);
});

test("disposal stops the loop and blocks future starts and wakeups", () => {
  const { timers, registry, scheduler } = setup();
  scheduler.startSelfPaced("ping");
  scheduler.dispose();
  scheduler.dispose();

  assert.equal(timers.pendingCount, 0);
  assert.equal(registry.size, 0);
  assert.throws(() => scheduler.startSelfPaced("again"), /disposed/);
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);
});

test("a throwing dispatch leaves the self-paced run pending for a retry", () => {
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

  scheduler.startSelfPaced("ping");
  timers.advance(0);
  assert.equal(errors.length, 1);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.status().pending, true, "the failed delivery is retained");
  assert.equal(
    scheduler.status().awaitingDecision,
    false,
    "a failed delivery must not be settled as a missed choice",
  );
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });

  fail = false;
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ok"]);
  assert.equal(scheduler.status().awaitingDecision, true);
});

test("an async dispatch failure during an awaiting iteration requeues once", async () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const rejectors: Array<(error: unknown) => void> = [];
  const scheduler = new LoopScheduler(
    timers,
    registry,
    () => new Promise<void>((_resolve, reject) => rejectors.push(reject)),
    () => true,
    () => {},
  );

  scheduler.startSelfPaced("poll");
  timers.advance(0);
  assert.equal(rejectors.length, 1);

  rejectors[0]!(new Error("boom"));
  await Promise.resolve();
  assert.equal(registry.list()[0]?.pending, true, "the failed delivery is retained");
  assert.equal(scheduler.status().awaitingDecision, false);

  assert.equal(scheduler.flush(), true, "the retained run is retried at the next idle point");
  assert.equal(rejectors.length, 2);
});

test("a stale async dispatch failure cannot requeue a rescheduled iteration", async () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const rejectors: Array<(error: unknown) => void> = [];
  const scheduler = new LoopScheduler(
    timers,
    registry,
    () => new Promise<void>((_resolve, reject) => rejectors.push(reject)),
    () => true,
    () => {},
  );

  scheduler.startSelfPaced("poll");
  timers.advance(0);
  assert.equal(rejectors.length, 1);

  // The iteration chooses its next wakeup before the send promise settles.
  scheduler.scheduleNextWakeup(10 * MINUTE_MS, "chosen");
  rejectors[0]!(new Error("late failure"));
  await Promise.resolve();

  assert.equal(registry.list()[0]?.pending, false, "a stale failure must not requeue the run");
  assert.equal(scheduler.status().awaitingDecision, false);

  timers.advance(10 * MINUTE_MS);
  assert.equal(rejectors.length, 2, "the chosen wakeup fires once, with no extra retry");
});

test("status carries the self-paced reason and fixed status stays mode-tagged", () => {
  const { timers, scheduler } = setup();
  scheduler.startSelfPaced("poll");
  timers.advance(0);
  scheduler.scheduleNextWakeup(10 * MINUTE_MS, "waiting on reviews");
  assert.equal(scheduler.status().reason, "waiting on reviews");

  scheduler.start(MINUTE_MS, "fixed");
  const fixed = scheduler.status();
  assert.equal(fixed.mode, "fixed");
  assert.equal(fixed.awaitingDecision, undefined);
  assert.equal(fixed.fallbackUsed, undefined);
  assert.equal(fixed.intervalMs, MINUTE_MS);
});
