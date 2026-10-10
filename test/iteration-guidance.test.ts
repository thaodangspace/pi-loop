/**
 * Tests for iteration-scoped runtime guidance on self-paced turns.
 *
 * Two levels are covered:
 *
 * 1. The pure tracker and guidance text (identity binding, consume-once,
 *    literal-prompt matching, section-name validity).
 * 2. Extension integration through a fake Pi: guidance is injected only for the
 *    turn a self-paced dispatch produced, never for fixed/cron/one-shot runs or
 *    ordinary user turns, and no rejected/failed/cleared boundary leaves it
 *    stale.
 *
 * A final suite cross-checks the section name and rendering against the
 * *installed* Pi package, so the mechanism stays anchored to the declared
 * minimum API rather than to assumptions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createIterationGuidanceTracker,
  SELF_PACED_ITERATION_SECTION,
  selfPacedIterationGuidance,
} from "../src/iteration-guidance.ts";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import {
  FakeCtx,
  FakePi,
  FakeTimers,
  maintenanceReader,
  missingFile,
  testRegistry,
} from "./helpers.ts";

// ---------------------------------------------------------------------------
// Pure tracker and text
// ---------------------------------------------------------------------------

test("guidance names the tools, the clamp, and the no-task-ID rule", () => {
  const text = selfPacedIterationGuidance("t7");
  assert.match(text, /self-paced scheduled task t7/);
  assert.match(text, /schedule_wakeup/);
  assert.match(text, /stop_wakeup/);
  assert.match(text, /1 minute-1 hour/);
  assert.match(text, /do not pass a task ID/);
  assert.match(text, /fallback wakeup is a safety net/);
  assert.match(text, /second consecutive iteration that chooses neither ends the task/);
});

test("the tracker binds to the dispatched task and consumes its marker once", () => {
  const tracker = createIterationGuidanceTracker();
  assert.equal(tracker.armed(), false);
  assert.equal(tracker.consume("t1", "run"), false, "nothing armed");

  tracker.arm("t1", "run", true);
  assert.equal(tracker.armed(), true);
  assert.equal(tracker.consume("t1", "run"), true);
  assert.equal(tracker.armed(), false, "consuming clears the marker");
  assert.equal(tracker.consume("t1", "run"), false, "guidance is never reused");
});

test("an independent task's marker never matches another task", () => {
  const tracker = createIterationGuidanceTracker();
  tracker.arm("t2", "run b", true);
  assert.equal(tracker.consume("t1", "run b"), false, "a different task never matches");
  assert.equal(tracker.armed(), false, "a mismatch still drops the marker");
});

test("a literal marker requires the exact turn prompt; an expanded one does not", () => {
  const literal = createIterationGuidanceTracker();
  literal.arm("t1", "check deploy", true);
  assert.equal(literal.consume("t1", "something else"), false, "literal mismatch drops");

  const expanded = createIterationGuidanceTracker();
  expanded.arm("t1", "/skill:review", false);
  assert.equal(
    expanded.consume("t1", "<skill name=\"review\">\nbody\n</skill>"),
    true,
    "an expanded prompt is matched by task identity",
  );
});

test("clear drops an armed marker without delivering", () => {
  const tracker = createIterationGuidanceTracker();
  tracker.arm("t1", "run", true);
  tracker.clear();
  assert.equal(tracker.armed(), false);
  assert.equal(tracker.consume("t1", "run"), false);
});

// ---------------------------------------------------------------------------
// Extension integration
// ---------------------------------------------------------------------------

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
  // Model Pi's synchronous "a send starts a turn" behavior so the scheduler's
  // idle check stops a flush after one dispatch, exactly as in a real session.
  pi.onSend = () => {
    ctx.idle = false;
  };
  pi.fire("session_start", ctx);
  return { timers, pi, ctx, registry };
}

/** Invoke a registered scheduler tool the way Pi would. */
function callTool(pi: FakePi, name: string, params: unknown, ctx: FakeCtx): Promise<unknown> {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool.execute("call-1", params as never, undefined, undefined, ctx as never) as Promise<unknown>;
}

interface TurnPayload {
  type: "before_agent_start";
  prompt: string;
  systemPromptOptions: { sections: Record<string, string> };
}

/** A minimal `before_agent_start` payload with a mutable section map. */
function turn(prompt: string): TurnPayload {
  return { type: "before_agent_start", prompt, systemPromptOptions: { sections: {} } };
}

function guidanceOf(payload: TurnPayload): string | undefined {
  return payload.systemPromptOptions.sections[SELF_PACED_ITERATION_SECTION];
}

test("a self-paced loop's dispatched iteration receives guidance exactly once", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "watch deploy", ctx);
  const [task] = registry.list();
  assert.ok(task);
  assert.equal(guidanceOf(turn("watch deploy")), undefined, "no guidance before a dispatch");

  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"], "the scheduled prompt is unchanged");

  const first = turn("watch deploy");
  pi.fire("before_agent_start", ctx, first);
  const guidance = guidanceOf(first);
  assert.ok(guidance, "the dispatched self-paced turn receives guidance");
  assert.match(guidance, new RegExp(`self-paced scheduled task ${task.id}`));

  // A second event for the same turn (or a later unrelated event) must not
  // repeat or persist the guidance.
  const second = turn("watch deploy");
  pi.fire("before_agent_start", ctx, second);
  assert.equal(guidanceOf(second), undefined, "guidance is consumed once");
});

test("an independent self-paced task's guidance is bound to that task", async () => {
  const { timers, pi, ctx, registry } = setup();

  await callTool(pi, "schedule_self_paced_task", { prompt: "monitor the queue" }, ctx);
  await callTool(pi, "schedule_self_paced_task", { prompt: "monitor the backlog" }, ctx);
  const [a, b] = registry.list();
  assert.ok(a && b);

  timers.advance(0);
  assert.deepEqual(pi.sent, ["monitor the queue"], "only the first due task runs");

  const payload = turn("monitor the queue");
  pi.fire("before_agent_start", ctx, payload);
  assert.match(guidanceOf(payload) ?? "", new RegExp(`self-paced scheduled task ${a.id}`));

  // The iteration-scoped wakeup tool targets the executing task only; the
  // other independent task is untouched.
  await callTool(pi, "schedule_wakeup", { delayMs: 300_000, reason: "keep watching" }, ctx);
  assert.equal(registry.get(a.id)?.reason, "keep watching");
  assert.equal(registry.get(a.id)?.nextFireAt, 300_000);
  assert.equal(registry.get(b.id)?.reason, undefined, "task B was never retargeted");
});

test("several self-paced tasks due while busy each get guidance on their own turn", async () => {
  const { timers, pi, ctx } = setup();

  await callTool(pi, "schedule_self_paced_task", { prompt: "task A" }, ctx);
  await callTool(pi, "schedule_self_paced_task", { prompt: "task B" }, ctx);

  // Both first runs are due while Pi is busy: they queue (coalesced) instead of
  // delivering, and neither turn has started yet.
  ctx.idle = false;
  timers.advance(0);
  assert.deepEqual(pi.sent, []);
  const a = turn("task A");
  pi.fire("before_agent_start", ctx, a);
  assert.equal(guidanceOf(a), undefined, "a queued run has no guidance yet");

  // First idle boundary: only task A runs, and its turn gets A-bound guidance.
  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["task A"]);
  const aTurn = turn("task A");
  pi.fire("before_agent_start", ctx, aTurn);
  assert.match(guidanceOf(aTurn) ?? "", /self-paced scheduled task t1/);

  // Second idle boundary: task B runs, and only B's turn gets B-bound guidance.
  ctx.idle = true;
  pi.fire("agent_settled", ctx);
  assert.deepEqual(pi.sent, ["task A", "task B"]);
  const bTurn = turn("task B");
  pi.fire("before_agent_start", ctx, bTurn);
  assert.match(guidanceOf(bTurn) ?? "", /self-paced scheduled task t2/);
  assert.notEqual(guidanceOf(aTurn), guidanceOf(bTurn), "each turn carries its own task id");
});

test("fixed, one-shot, and ordinary user turns receive no self-paced guidance", async () => {
  // Fixed cadence.
  const fixed = setup();
  await callTool(fixed.pi, "schedule_task", { interval: "1min", prompt: "fixed run" }, fixed.ctx);
  fixed.timers.advance(60_000);
  assert.ok(fixed.pi.sent.includes("fixed run"));
  const fixedTurn = turn("fixed run");
  fixed.pi.fire("before_agent_start", fixed.ctx, fixedTurn);
  assert.equal(guidanceOf(fixedTurn), undefined, "a fixed run never gets guidance");

  // One-shot.
  const once = setup();
  await callTool(once.pi, "schedule_once_task", { delay: "1min", prompt: "once run" }, once.ctx);
  once.timers.advance(60_000);
  assert.ok(once.pi.sent.includes("once run"));
  const onceTurn = turn("once run");
  once.pi.fire("before_agent_start", once.ctx, onceTurn);
  assert.equal(guidanceOf(onceTurn), undefined, "a one-shot never gets guidance");

  // Cron.
  const cron = setup();
  await callTool(cron.pi, "schedule_cron_task", { cron: "* * * * *", prompt: "cron run" }, cron.ctx);
  cron.timers.advance(120_000);
  assert.ok(cron.pi.sent.includes("cron run"));
  const cronTurn = turn("cron run");
  cron.pi.fire("before_agent_start", cron.ctx, cronTurn);
  assert.equal(guidanceOf(cronTurn), undefined, "a cron run never gets guidance");

  // An ordinary user turn.
  const user = setup();
  const userTurn = turn("hello there");
  user.pi.fire("before_agent_start", user.ctx, userTurn);
  assert.equal(guidanceOf(userTurn), undefined);
});

test("a rejected maintenance dispatch leaves no guidance for a later turn", async () => {
  // A maintenance loop resolves its prompt at each run; a loop.md naming a
  // control command is rejected at dispatch time, before Pi sees a turn.
  const { readFile } = maintenanceReader({
    "/tmp/pi-loop-project/.claude/loop.md": "/loop stop",
  });
  const { timers, pi, ctx } = setup({ maintenance: { readFile } });

  await pi.run("loop", "", ctx);
  timers.advance(0);
  assert.deepEqual(pi.sent, [], "a rejected prompt is never delivered");

  const later = turn("anything");
  pi.fire("before_agent_start", ctx, later);
  assert.equal(guidanceOf(later), undefined, "no stale guidance after a rejection");
});

test("deleting the task mid-flight drops the armed guidance", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "watch deploy", ctx);
  const [task] = registry.list();
  assert.ok(task);
  timers.advance(0);
  assert.deepEqual(pi.sent, ["watch deploy"]);

  const tool = pi.tools.get("delete_scheduled_task");
  assert.ok(tool);
  await tool.execute("call-1", { id: task.id } as never, undefined, undefined, ctx as never);

  const deletedTurn = turn("watch deploy");
  pi.fire("before_agent_start", ctx, deletedTurn);
  assert.equal(guidanceOf(deletedTurn), undefined, "a deleted iteration carries no guidance");
  assert.equal(registry.size, 0);
});

test("session boundaries clear armed guidance", async () => {
  for (const boundary of ["session_tree", "session_shutdown", "agent_settled"] as const) {
    const { timers, pi, ctx } = setup();
    await pi.run("loop", "watch deploy", ctx);
    timers.advance(0);
    assert.deepEqual(pi.sent, ["watch deploy"]);

    if (boundary === "agent_settled") {
      // Settling the iteration grants the one fallback wakeup; the marker must
      // still be dropped rather than delivered to whatever turn comes next.
      ctx.idle = true;
    }
    pi.fire(boundary, ctx);

    const later = turn("watch deploy");
    pi.fire("before_agent_start", ctx, later);
    assert.equal(guidanceOf(later), undefined, `${boundary} must clear guidance`);
  }
});

test("skill and literal dispatch remain unchanged while guidance is added", async () => {
  const { timers, pi, ctx } = setup();
  pi.slashCommands.push({ name: "skill:review", source: "skill" });
  pi.skills.set("review", "Review carefully.");

  await callTool(pi, "schedule_self_paced_task", { prompt: "/skill:review src" }, ctx);
  timers.advance(0);
  const expanded = "<skill name=\"review\">\nReview carefully.\n</skill>\n\nsrc";
  assert.deepEqual(pi.sent, [expanded], "skill expansion is byte-for-byte unchanged");

  const payload = turn(expanded);
  pi.fire("before_agent_start", ctx, payload);
  assert.match(guidanceOf(payload) ?? "", /self-paced scheduled task t1/);

  // A literal self-paced prompt is delivered exactly and still guided.
  const literal = setup();
  await callTool(literal.pi, "schedule_self_paced_task", { prompt: "plain check" }, literal.ctx);
  literal.timers.advance(0);
  assert.deepEqual(literal.pi.sent, ["plain check"]);
  const literalTurn = turn("plain check");
  literal.pi.fire("before_agent_start", literal.ctx, literalTurn);
  assert.match(guidanceOf(literalTurn) ?? "", /self-paced scheduled task t1/);
});

// ---------------------------------------------------------------------------
// Cross-check against the actual installed Pi package
// ---------------------------------------------------------------------------

const PI_DIST = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);

test("the section name and rendering match the installed Pi system-prompt builder", async () => {
  const { buildSystemPromptSections } = (await import(
    new URL("core/system-prompt.js", PI_DIST).href
  )) as {
    buildSystemPromptSections: (input: { cwd: string; sections: Record<string, string> }) => Record<
      string,
      string
    >;
  };

  const sections = buildSystemPromptSections({
    cwd: "/tmp",
    sections: { [SELF_PACED_ITERATION_SECTION]: selfPacedIterationGuidance("t1") },
  });
  const rendered = sections[SELF_PACED_ITERATION_SECTION];
  assert.ok(rendered, "the installed Pi accepts the section name and renders it");
  assert.match(rendered, new RegExp(`^<${SELF_PACED_ITERATION_SECTION}>`));
  assert.match(rendered, /schedule_wakeup/);

  // The documented section-name grammar (the installed builder accepts ours).
  assert.match(SELF_PACED_ITERATION_SECTION, /^[a-z][a-z0-9_-]*$/);
});
