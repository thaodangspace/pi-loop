import assert from "node:assert/strict";
import test from "node:test";
import {
  LoopScheduler,
  WakeupError,
  type SchedulerDeps,
} from "../src/loop-core.ts";
import { HOUR_MS, MINUTE_MS } from "../src/schedule.ts";
import { FakeTimers, testRegistry } from "./helpers.ts";

/**
 * A scheduler with a mutable idle flag and a record of dispatched prompts.
 * Independent self-paced tasks never become the command-owned loop, so there is
 * no `primaryId` unless a test calls `startSelfPaced`/`start` explicitly.
 */
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

test("scheduleSelfPaced creates independent tasks without replacing the command loop", () => {
  const { timers, registry, scheduler } = setup();

  const a = scheduler.scheduleSelfPaced("task a");
  const b = scheduler.scheduleSelfPaced("task b");

  assert.equal(registry.size, 2);
  assert.equal(a.mode, "self-paced");
  assert.equal(b.mode, "self-paced");
  assert.notEqual(a.id, b.id);
  assert.equal(scheduler.status().active, false, "independent tasks never own the command loop");
  assert.equal(scheduler.activeSelfPacedTask(), undefined, "nothing is executing yet");
  assert.equal(timers.pendingCount, 2, "each task arms its own first-run timer");

  assert.throws(() => scheduler.scheduleSelfPaced("   "), /task must not be empty/);
  assert.equal(registry.size, 2, "an invalid prompt changes nothing");
});

test("two independent self-paced tasks run in due order and choose different wakeups", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const a = scheduler.scheduleSelfPaced("A");
  const b = scheduler.scheduleSelfPaced("B");

  // Both come due while busy: coalesced once each, in registration order.
  setIdle(false);
  timers.advance(0);
  assert.deepEqual(dispatched, []);
  assert.deepEqual(scheduler.dueTaskIds(), [a.id, b.id]);

  // Only the first task runs; the second keeps its place.
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A"]);
  assert.deepEqual(scheduler.dueTaskIds(), [b.id]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, a.id);

  // A reschedules itself; B is untouched.
  const rescheduledA = scheduler.scheduleNextWakeup(2 * MINUTE_MS, "A again");
  assert.equal(rescheduledA.nextFireAt, 2 * MINUTE_MS);
  assert.equal(registry.get(a.id)?.nextFireAt, 2 * MINUTE_MS);
  assert.equal(registry.get(b.id)?.nextFireAt, 0, "B's wakeup state is untouched");
  assert.equal(registry.get(b.id)?.pending, true);
  assert.deepEqual(scheduler.settleIteration(), { action: "none" }, "A already chose its wakeup");

  // B runs only after A's iteration settles.
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A", "B"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, b.id);

  const rescheduledB = scheduler.scheduleNextWakeup(10 * MINUTE_MS, "B again");
  assert.equal(rescheduledB.nextFireAt, 10 * MINUTE_MS);
  assert.equal(registry.get(a.id)?.nextFireAt, 2 * MINUTE_MS, "B's choice does not move A");
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });

  // A's shorter wakeup fires without disturbing B's longer one.
  timers.advance(2 * MINUTE_MS);
  assert.deepEqual(dispatched, ["A", "B", "A"]);
  assert.equal(registry.get(b.id)?.nextFireAt, 10 * MINUTE_MS);
});

test("a bind is per task: one task's fallback and termination do not affect another", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const a = scheduler.scheduleSelfPaced("A", { fallbackDelayMs: 2 * MINUTE_MS });
  const b = scheduler.scheduleSelfPaced("B", { fallbackDelayMs: 5 * MINUTE_MS });

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A"]);

  // A misses once: one fallback. B is untouched.
  assert.deepEqual(scheduler.settleIteration(), {
    action: "fallback",
    delayMs: 2 * MINUTE_MS,
    nextFireAt: 2 * MINUTE_MS,
  });
  assert.equal(registry.get(b.id)?.nextFireAt, 0, "B's fallback counter and timer are its own");

  // A misses its fallback too: A terminates even though B has not fallen back.
  timers.advance(2 * MINUTE_MS);
  assert.deepEqual(dispatched, ["A", "A"]);
  assert.deepEqual(scheduler.settleIteration(), { action: "terminated" });
  assert.equal(registry.get(a.id), undefined);
  assert.equal(registry.has(b.id), true, "terminating A leaves B alive");

  // B still gets its own single bounded fallback.
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A", "A", "B"]);
  assert.deepEqual(scheduler.settleIteration(), {
    action: "fallback",
    delayMs: 5 * MINUTE_MS,
    nextFireAt: 7 * MINUTE_MS,
  });
  assert.equal(registry.has(b.id), true);
});

test("stop targets only the executing independence, not the command-owned loop", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");
  assert.equal(scheduler.status().task, "cmd");

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  // The independent task was registered first, so it is the earliest tie.
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ind"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id);

  // stop() during the independent iteration stops that task, not the command loop.
  assert.equal(scheduler.stop(), true);
  assert.equal(registry.has(ind.id), false);
  assert.equal(registry.has(cmd.id), true, "the command-owned loop is untouched");
  // The turn is still active, so the removed iteration leaves a stale sentinel:
  // wakeups fail closed rather than retargeting the command loop.
  assert.equal(scheduler.activeSelfPacedTask(), undefined);
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);

  // At the turn boundary the sentinel clears and the command loop is the target.
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.equal(scheduler.activeSelfPacedTask()?.id, cmd.id);
  const backToPrimary = scheduler.scheduleNextWakeup(MINUTE_MS, "command loop");
  assert.equal(backToPrimary.nextFireAt, MINUTE_MS);

  // With no iteration executing, stop() cancels the command-owned loop.
  assert.equal(scheduler.stop(), true);
  assert.equal(registry.has(cmd.id), false);
  assert.equal(registry.size, 0);
});

test("deleting the executing iteration stays fail-closed until the turn settles", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ind"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id);
  const cmdNextFireAt = registry.get(cmd.id)?.nextFireAt;

  // Delete the executing task through the scheduler's own delete path. The
  // command-owned loop is present and unaffected.
  assert.equal(scheduler.stopTask(ind.id), true);
  assert.equal(registry.has(ind.id), false);
  assert.equal(registry.has(cmd.id), true);

  // Same agent turn: a late wakeup or stop must fail closed, never touch cmd.
  assert.equal(scheduler.activeSelfPacedTask(), undefined);
  assert.throws(() => scheduler.scheduleNextWakeup(MINUTE_MS), WakeupError);
  assert.equal(scheduler.stop(), false);
  assert.equal(registry.has(cmd.id), true, "the command loop is not stopped");
  assert.equal(registry.get(cmd.id)?.nextFireAt, cmdNextFireAt, "the command loop is not rescheduled");

  // The settle boundary releases the sentinel; only then is cmd the target.
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.equal(scheduler.activeSelfPacedTask()?.id, cmd.id);
});

test("stop before any run cancels the command loop, never an independent task", () => {
  const { registry, scheduler } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");

  assert.equal(scheduler.stop(), true);
  assert.equal(registry.has(cmd.id), false, "the command loop is replaced");
  assert.equal(registry.has(ind.id), true, "the independent task survives");
});

test("deleting one self-paced task invalidates only its timer and callbacks", () => {
  const captured: Array<() => void> = [];
  const timers: SchedulerDeps = {
    now: () => 0,
    setTimer: (fn) => {
      captured.push(fn);
      return captured.length;
    },
    clearTimer: () => {},
  };
  const registry = testRegistry(new FakeTimers());
  const dispatched: string[] = [];
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
    },
    () => true,
  );

  const a = scheduler.scheduleSelfPaced("A");
  const b = scheduler.scheduleSelfPaced("B");
  const staleA = captured[0]!;
  const liveB = captured[1]!;

  scheduler.stopTask(a.id);
  staleA();
  assert.deepEqual(dispatched, [], "the deleted task's captured callback is inert");

  liveB();
  assert.deepEqual(dispatched, ["B"], "B's callback still dispatches");
  assert.equal(scheduler.activeSelfPacedTask()?.id, b.id);

  // A second self-paced task's stale callback cannot act after its own deletion.
  scheduler.stopTask(b.id);
  liveB();
  assert.deepEqual(dispatched, ["B"], "a callback after deletion stays stale");
  assert.equal(scheduler.activeSelfPacedTask(), undefined);
});

test("a late async failure from one task cannot requeue another task", async () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const rejectors: Array<(error: unknown) => void> = [];
  const dispatched: string[] = [];
  let idle = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (task) => {
      dispatched.push(task.prompt);
      return new Promise<void>((_resolve, reject) => rejectors.push(reject));
    },
    () => idle,
    () => {},
  );
  const setIdle = (value: boolean) => (idle = value);

  const a = scheduler.scheduleSelfPaced("A");
  const b = scheduler.scheduleSelfPaced("B");
  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A"]);
  assert.deepEqual(scheduler.dueTaskIds(), [b.id], "B is queued behind A's turn");

  // A chooses its wakeup before its send promise rejects.
  scheduler.scheduleNextWakeup(3 * MINUTE_MS, "A done");
  rejectors[0]!(new Error("late A failure"));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(scheduler.dueTaskIds(), [b.id], "A's late failure adds no queued run");
  assert.equal(registry.get(a.id)?.pending, false);
  assert.equal(registry.get(b.id)?.pending, true);

  // B still runs exactly once and its own iteration settles independently.
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["A", "B"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, b.id);
  assert.equal(rejectors.length, 2);
});

test("multiple due self-paced tasks flush in earliest-deadline then registration order", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const a = scheduler.scheduleSelfPaced("A");
  const b = scheduler.scheduleSelfPaced("B");

  // Run both once so each can choose its own wakeup: A later, B sooner.
  setIdle(false);
  timers.advance(0);
  setIdle(true);
  scheduler.flush();
  scheduler.scheduleNextWakeup(5 * MINUTE_MS, "A later");
  scheduler.settleIteration();
  scheduler.flush();
  scheduler.scheduleNextWakeup(2 * MINUTE_MS, "B sooner");
  scheduler.settleIteration();
  assert.deepEqual(dispatched, ["A", "B"]);

  // A long busy window misses both; the queue orders them by deadline.
  setIdle(false);
  timers.advance(6 * MINUTE_MS);
  assert.deepEqual(scheduler.dueTaskIds(), [b.id, a.id]);
  assert.equal(registry.get(a.id)?.nextFireAt, 5 * MINUTE_MS);
  assert.equal(registry.get(b.id)?.nextFireAt, 2 * MINUTE_MS);

  setIdle(true);
  scheduler.flush();
  scheduler.settleIteration();
  scheduler.flush();
  assert.equal(dispatched.at(-2), "B", "the earliest missed deadline flushes first");
  assert.equal(dispatched.at(-1), "A");
});

test("a self-paced wakeup resolves to the executing task even with a fixed command loop", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  scheduler.start(MINUTE_MS, "fixed");
  const fixedId = registry.list().find((task) => task.mode === "fixed")!.id;
  assert.equal(scheduler.status().mode, "fixed");
  assert.equal(
    scheduler.activeSelfPacedTask(),
    undefined,
    "no iteration is bound yet, so no self-paced target exists",
  );

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ind"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id, "the executing task is now the target");

  const decision = scheduler.scheduleNextWakeup(4 * MINUTE_MS, "independent");
  assert.equal(decision.nextFireAt, 4 * MINUTE_MS);
  assert.equal(registry.get(ind.id)?.nextFireAt, 4 * MINUTE_MS);
  assert.notEqual(registry.get(fixedId)?.nextFireAt, 4 * MINUTE_MS);

  // Settling the independent iteration leaves the fixed command loop queued as before.
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.equal(scheduler.status().mode, "fixed");
});

test("starting a new command loop replaces only the command loop", () => {
  const { registry, scheduler } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");

  const cmd = scheduler.startSelfPaced("cmd");
  assert.equal(registry.has(ind.id), true);
  assert.equal(registry.has(cmd.id), true);
  assert.equal(scheduler.status().task, "cmd");

  scheduler.start(MINUTE_MS, "fixed");
  const fixedId = registry.list().find((task) => task.mode === "fixed")!.id;
  assert.equal(registry.has(cmd.id), false, "the previous command loop is replaced");
  assert.equal(registry.has(fixedId), true);
  assert.equal(registry.has(ind.id), true, "the independent task survives");

  const cmd2 = scheduler.startSelfPaced("cmd2");
  assert.equal(registry.has(fixedId), false);
  assert.equal(registry.has(cmd2.id), true);
  assert.equal(registry.has(ind.id), true);
  assert.equal(registry.get(ind.id)?.prompt, "ind");
  assert.equal(registry.size, 2);

  // An invalid replacement attempt does not disturb the running command loop.
  assert.throws(() => scheduler.startSelfPaced("  "), /task must not be empty/);
  assert.equal(registry.has(cmd2.id), true);
  assert.equal(registry.has(ind.id), true);
});

test("each self-paced task keeps its own fallback delay and clamped wakeups", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const a = scheduler.scheduleSelfPaced("A", { fallbackDelayMs: 30_000 });
  const b = scheduler.scheduleSelfPaced("B", { fallbackDelayMs: 5 * HOUR_MS });

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  scheduler.flush();
  // A asked below the floor and above the ceiling; both clamp per task.
  assert.deepEqual(scheduler.settleIteration(), {
    action: "fallback",
    delayMs: MINUTE_MS,
    nextFireAt: MINUTE_MS,
  });
  assert.equal(registry.get(a.id)?.nextFireAt, MINUTE_MS);

  scheduler.flush();
  assert.deepEqual(scheduler.settleIteration(), {
    action: "fallback",
    delayMs: HOUR_MS,
    nextFireAt: HOUR_MS,
  });
  assert.equal(registry.get(b.id)?.nextFireAt, HOUR_MS);
  assert.deepEqual(dispatched, ["A", "B"]);
});

test("a stale binding fails closed and never falls back to the command loop", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");
  assert.equal(scheduler.status().task, "cmd");

  // The independent task is registered first, so it wins the due tie and is the
  // iteration executing when the binding goes stale.
  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ind"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id);
  const cmdNextFireAt = registry.get(cmd.id)?.nextFireAt;

  // Remove the bound registry record directly (bypassing stopTask) so the
  // binding is stale while the executing turn has not settled.
  registry.delete(ind.id);

  assert.equal(scheduler.activeSelfPacedTask(), undefined, "a stale binding resolves to nothing");
  assert.throws(
    () => scheduler.scheduleNextWakeup(MINUTE_MS),
    WakeupError,
    "a stale wakeup must not reschedule the command loop",
  );
  assert.equal(scheduler.stop(), false, "an iteration stop fails closed");
  assert.equal(registry.has(cmd.id), true, "the command loop is not stopped");
  assert.equal(registry.get(cmd.id)?.nextFireAt, cmdNextFireAt, "the command loop is not rescheduled");
  assert.equal(scheduler.activeSelfPacedTask(), undefined, "the binding stays stale until the turn boundary");

  // The turn boundary (agent_settled) releases the stale binding. Only then does
  // the command-owned loop become the backward-compatible target again.
  assert.deepEqual(scheduler.settleIteration(), { action: "none" });
  assert.equal(scheduler.activeSelfPacedTask()?.id, cmd.id);
  assert.deepEqual(dispatched, ["ind"], "no stale callback ever dispatches");
});

test("command stop is separate from iteration stop", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.deepEqual(dispatched, ["ind"]);
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id, "the independent iteration is executing");

  // `/loop stop` uses the command-only stop: it cancels the command loop and
  // leaves the executing independent iteration untouched.
  assert.equal(scheduler.stopCommandLoop(), true);
  assert.equal(registry.has(cmd.id), false, "the command-owned loop is stopped");
  assert.equal(registry.has(ind.id), true, "the executing iteration survives");
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id, "its binding is unchanged");

  // The iteration-scoped stop still cancels the iteration, not the command loop.
  assert.equal(scheduler.stop(), true);
  assert.equal(registry.has(ind.id), false);
  assert.equal(scheduler.stopCommandLoop(), false, "nothing command-owned remains");
  assert.equal(scheduler.stop(), false);
});

test("executingSelfPacedTask distinguishes an executing iteration from the command-owned loop", () => {
  const { timers, registry, scheduler, dispatched, setIdle } = setup();
  const cmd = scheduler.startSelfPaced("cmd");

  // The command-owned loop exists, but no iteration has executed yet, so no
  // iteration is "executing" — the distinction the tools rely on to fail closed.
  assert.equal(scheduler.executingSelfPacedTask(), undefined);
  assert.equal(scheduler.activeSelfPacedTask()?.id, cmd.id, "the backward-compatible target is the primary");

  setIdle(false);
  timers.advance(0);
  setIdle(true);
  assert.equal(scheduler.flush(), true);
  assert.equal(scheduler.executingSelfPacedTask()?.id, cmd.id, "the executing iteration is the primary");

  // Settling releases the binding: the primary survives but is no longer executing.
  assert.deepEqual(scheduler.settleIteration(), { action: "fallback", delayMs: MINUTE_MS, nextFireAt: MINUTE_MS });
  assert.equal(scheduler.executingSelfPacedTask(), undefined);
  assert.equal(scheduler.activeSelfPacedTask()?.id, cmd.id);
  assert.deepEqual(dispatched, ["cmd"]);

  // An independent task's executing iteration is likewise reported, and a stale
  // binding (its record removed mid-turn) reports nothing.
  const ind = scheduler.scheduleSelfPaced("ind");
  timers.advance(MINUTE_MS);
  assert.equal(scheduler.executingSelfPacedTask()?.id, ind.id);
  registry.delete(ind.id);
  assert.equal(scheduler.executingSelfPacedTask(), undefined, "a stale binding reports no executing iteration");
});

test("command stop cancels the command loop whether or not an iteration is bound", () => {
  const { timers, registry, scheduler, setIdle } = setup();
  const ind = scheduler.scheduleSelfPaced("ind");
  const cmd = scheduler.startSelfPaced("cmd");

  // No iteration bound: the command stop still targets the command loop.
  assert.equal(scheduler.stopCommandLoop(), true);
  assert.equal(registry.has(cmd.id), false);
  assert.equal(registry.has(ind.id), true);

  // A later executing iteration is likewise not the command stop's target.
  const cmd2 = scheduler.startSelfPaced("cmd2");
  setIdle(false);
  timers.advance(0);
  setIdle(true);
  scheduler.flush();
  assert.equal(scheduler.activeSelfPacedTask()?.id, ind.id);
  assert.equal(scheduler.stopCommandLoop(), true);
  assert.equal(registry.has(cmd2.id), false);
  assert.equal(registry.has(ind.id), true);
});
