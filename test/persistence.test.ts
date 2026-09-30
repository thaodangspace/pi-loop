import assert from "node:assert/strict";
import test from "node:test";
import {
  collectEntries,
  createTaskEvent,
  deleteTaskEvent,
  parseEvent,
  PERSISTENCE_CUSTOM_TYPE,
  PERSISTENCE_VERSION,
  planRestore,
  replayEvents,
  updateTaskEvent,
  type PersistedEntryLike,
  type PersistedEvent,
  type PersistedTask,
} from "../src/persistence.ts";

function fixedTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: "t1",
    prompt: "check deploy",
    mode: "fixed",
    createdAt: 1_000,
    schedule: { intervalMs: 300_000, anchor: 0 },
    nextFireAt: 300_000,
    ...overrides,
  };
}

/** Round-trip through JSON, as a session entry would be serialized. */
function roundTrip(event: PersistedEvent): unknown {
  return JSON.parse(JSON.stringify(event)) as unknown;
}

/** Wrap an event as a session custom entry of this extension. */
function entry(event: PersistedEvent): PersistedEntryLike {
  return { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data: event };
}

test("create, update, and delete events round-trip through the codec", () => {
  const create = createTaskEvent(fixedTask());
  const parsedCreate = parseEvent(roundTrip(create));
  assert.equal(parsedCreate.ok, true);
  if (parsedCreate.ok) {
    assert.deepEqual(parsedCreate.event, create);
    assert.equal(parsedCreate.event.version, PERSISTENCE_VERSION);
  }

  const update = updateTaskEvent("t1", { prompt: "renamed", nextFireAt: 600_000 });
  const parsedUpdate = parseEvent(roundTrip(update));
  assert.deepEqual(parsedUpdate, { ok: true, event: update });

  const del = deleteTaskEvent("t1");
  assert.deepEqual(parseEvent(roundTrip(del)), { ok: true, event: del });
});

test("optional schedule and expiry metadata survive the codec", () => {
  const create = createTaskEvent({
    id: "one",
    prompt: "ship it",
    mode: "one-shot",
    maintenance: true,
    createdAt: 5,
    nextFireAt: 9_000,
    expiresAt: 10_000,
  });
  const parsed = parseEvent(roundTrip(create));
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.event.kind === "create") {
    assert.equal(parsed.event.task.maintenance, true);
    assert.equal(parsed.event.task.expiresAt, 10_000);
    assert.equal(parsed.event.task.schedule, undefined);
  }
});

test("a cron schedule round-trips and an unparsable one is rejected", () => {
  const cron = { kind: "cron", expression: "0 9 * * 1-5", timeZone: "America/New_York" } as const;
  const create = createTaskEvent({
    id: "cron",
    prompt: "weekday",
    mode: "fixed",
    createdAt: 0,
    schedule: cron,
    nextFireAt: 1_000,
  });
  const parsed = parseEvent(roundTrip(create));
  assert.equal(parsed.ok, true);
  if (parsed.ok && parsed.event.kind === "create") {
    assert.deepEqual(parsed.event.task.schedule, cron);
  }

  const badExpression = parseEvent({
    version: 1,
    kind: "create",
    task: {
      id: "x",
      prompt: "p",
      mode: "fixed",
      createdAt: 0,
      schedule: { kind: "cron", expression: "99 * * * *", timeZone: "UTC" },
    },
  });
  assert.equal(badExpression.ok, false, "an out-of-range cron field is rejected");
  if (!badExpression.ok) {
    assert.match(badExpression.reason, /invalid schedule/);
  }

  const badZone = parseEvent({
    version: 1,
    kind: "create",
    task: {
      id: "x",
      prompt: "p",
      mode: "fixed",
      createdAt: 0,
      schedule: { kind: "cron", expression: "* * * * *", timeZone: "Nope/Zone" },
    },
  });
  assert.equal(badZone.ok, false, "an unknown timezone is rejected");
});

test("planRestore restores live cron tasks and drops expired ones", () => {
  const now = 1_000_000;
  const cron = { kind: "cron", expression: "*/5 * * * *", timeZone: "UTC" } as const;
  const plan = replayEvents(
    [
      createTaskEvent({
        id: "live",
        prompt: "a",
        mode: "fixed",
        createdAt: 0,
        schedule: cron,
        nextFireAt: 300_000,
        expiresAt: now + 100_000,
      }),
      createTaskEvent({
        id: "dead",
        prompt: "b",
        mode: "fixed",
        createdAt: 0,
        schedule: cron,
        nextFireAt: 300_000,
        expiresAt: now,
      }),
    ],
    now,
  );

  assert.deepEqual(plan.tasks.map((task) => task.id), ["live"]);
  assert.deepEqual(plan.tasks[0]!.schedule, cron);
});

test("malformed entries are rejected with a reportable reason", () => {
  const cases: unknown[] = [
    "not an object",
    {},
    { version: 1 },
    { version: 1, kind: "create" },
    { version: 1, kind: "create", task: { mode: "fixed", createdAt: 0 } },
    { version: 1, kind: "create", task: { id: "x", prompt: "p", mode: "nope", createdAt: 0 } },
    {
      version: 1,
      kind: "create",
      task: { id: "x", prompt: "p", mode: "fixed", createdAt: 0, schedule: { intervalMs: -1, anchor: 0 } },
    },
    { version: 1, kind: "update", patch: {} },
    { version: 1, kind: "update", id: "x" },
    { version: 1, kind: "delete" },
    { version: 1, kind: "unknown" },
  ];
  for (const data of cases) {
    const parsed = parseEvent(data);
    assert.equal(parsed.ok, false, `expected rejection for ${JSON.stringify(data)}`);
    if (!parsed.ok) {
      assert.match(parsed.reason, /ignored/);
    }
  }
});

test("a newer schema version is reported as unsupported rather than malformed", () => {
  const parsed = parseEvent({ version: PERSISTENCE_VERSION + 1, kind: "delete", id: "t1" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.match(parsed.reason, /newer schema version 2/);
  }
});

test("collectEntries picks only this extension's custom entries, in branch order", () => {
  const first = createTaskEvent(fixedTask({ id: "a" }));
  const second = createTaskEvent(fixedTask({ id: "b" }));
  const branch: PersistedEntryLike[] = [
    { type: "message" },
    { type: "custom", customType: "someone-else", data: { anything: true } },
    entry(first),
    { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data: { version: 99, kind: "delete", id: "z" } },
    entry(second),
  ];
  const results = collectEntries(branch);
  assert.equal(results.length, 3, "only our custom entries are collected");
  assert.deepEqual(
    results.map((result) => (result.ok ? (result.event.kind === "create" ? result.event.task.id : result.event.id) : "?")),
    ["a", "?", "b"],
  );
  const failed = results[1]!;
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.match(failed.reason, /newer schema version 99/);
  }
});

test("replay applies create, update, and delete in order", () => {
  const events: PersistedEvent[] = [
    createTaskEvent(fixedTask({ id: "a", prompt: "first" })),
    updateTaskEvent("a", { prompt: "renamed" }),
    createTaskEvent(fixedTask({ id: "b" })),
    deleteTaskEvent("a"),
  ];
  const plan = replayEvents(events, 1_000);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["b"],
    "the delete tombstone removes the earlier create",
  );
  assert.deepEqual(plan.issues, []);
});

test("a later create resurrects a deleted id", () => {
  const events: PersistedEvent[] = [
    createTaskEvent(fixedTask({ id: "a", prompt: "old" })),
    deleteTaskEvent("a"),
    createTaskEvent(fixedTask({ id: "a", prompt: "new" })),
  ];
  const plan = replayEvents(events, 0);
  assert.deepEqual(plan.tasks.map((task) => task.prompt), ["new"]);
});

test("an update for an unknown task is ignored with a report", () => {
  const plan = replayEvents([updateTaskEvent("ghost", { prompt: "x" })], 0);
  assert.deepEqual(plan.tasks, []);
  assert.match(plan.issues[0]!, /update for unknown task ghost/);
});

test("expired recurring tasks are not restored", () => {
  const now = 10_000;
  const events: PersistedEvent[] = [
    createTaskEvent(fixedTask({ id: "expired", expiresAt: now })),
    createTaskEvent(fixedTask({ id: "live", expiresAt: now + 1 })),
    createTaskEvent(fixedTask({ id: "evergreen" })),
  ];
  const plan = replayEvents(events, now);
  assert.deepEqual(
    plan.tasks.map((task) => task.id),
    ["live", "evergreen"],
  );
  assert.deepEqual(plan.issues, [], "expiry is a normal drop, not a reported error");
});

test("missed one-shots are skipped while future ones are restored", () => {
  const now = 5_000;
  const events: PersistedEvent[] = [
    createTaskEvent({ id: "missed", prompt: "late", mode: "one-shot", createdAt: 0, nextFireAt: now }),
    createTaskEvent({ id: "future", prompt: "soon", mode: "one-shot", createdAt: 0, nextFireAt: now + 1_000 }),
  ];
  const plan = replayEvents(events, now);
  assert.deepEqual(plan.tasks.map((task) => task.id), ["future"]);
  assert.deepEqual(plan.issues, []);
});

test("self-paced tasks are never restored and are reported", () => {
  const plan = replayEvents(
    [createTaskEvent({ id: "loop", prompt: "pace", mode: "self-paced", createdAt: 0, nextFireAt: 0 })],
    0,
  );
  assert.deepEqual(plan.tasks, []);
  assert.match(plan.issues[0]!, /self-paced task loop/);
});

test("fixed tasks without a schedule and one-shots without a time are reported", () => {
  const plan = replayEvents(
    [
      createTaskEvent({ id: "broken-fixed", prompt: "x", mode: "fixed", createdAt: 0 }),
      createTaskEvent({ id: "broken-one", prompt: "x", mode: "one-shot", createdAt: 0 }),
    ],
    0,
  );
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.issues.length, 2);
});

test("only the entries of the supplied active branch are replayed", () => {
  // Simulate two divergent branches: a shared create, then one branch updates
  // the task while the abandoned branch deletes it. Replaying the active branch
  // must see only that branch's suffix.
  const shared = createTaskEvent(fixedTask({ id: "a", prompt: "shared" }));
  const activeBranch = [entry(shared), entry(updateTaskEvent("a", { prompt: "active" }))];
  const abandonedBranch = [entry(shared), entry(deleteTaskEvent("a"))];

  assert.deepEqual(planRestore(collectEntries(activeBranch), 0).tasks.map((task) => task.prompt), ["active"]);
  assert.deepEqual(planRestore(collectEntries(abandonedBranch), 0).tasks, []);
});

test("a newer-version tombstone fails the whole branch closed, not just itself", () => {
  // A v1 create is followed by a v2 delete we cannot read. Restoring the create
  // would resurrect a task the newer schema deleted, so nothing may restore.
  const branch: PersistedEntryLike[] = [
    entry(createTaskEvent(fixedTask({ id: "a", prompt: "keep" }))),
    { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data: { version: 2, kind: "delete", id: "a" } },
  ];
  const plan = planRestore(collectEntries(branch), 0);
  assert.deepEqual(plan.tasks, [], "the unreadable tombstone must not be bypassed");
  assert.equal(plan.issues.length, 1);
  assert.match(plan.issues[0]!, /newer schema version 2/);
});

test("a newer-version entry anywhere on the branch fails the branch closed", () => {
  const branch: PersistedEntryLike[] = [
    entry(createTaskEvent(fixedTask({ id: "before" }))),
    { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data: { version: 1, kind: "create", task: { nope: true } } },
    entry(createTaskEvent(fixedTask({ id: "after" }))),
  ];
  const plan = planRestore(collectEntries(branch), 0);
  assert.deepEqual(plan.tasks, [], "a later create cannot override the fail-closed decision");
  assert.equal(plan.issues.length, 1);
});

test("a malformed later mutation fails the branch closed instead of resurrecting a create", () => {
  // The malformed delete cannot be interpreted, so the create before it might
  // have been deleted; restoring it would be a resurrection.
  const branch: PersistedEntryLike[] = [
    entry(createTaskEvent(fixedTask({ id: "a", prompt: "maybe gone" }))),
    { type: "custom", customType: PERSISTENCE_CUSTOM_TYPE, data: { version: 1, kind: "delete" } },
  ];
  const plan = planRestore(collectEntries(branch), 0);
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.issues.length, 1);
});

test("an unreadable entry of another customType does not affect this branch", () => {
  const branch: PersistedEntryLike[] = [
    entry(createTaskEvent(fixedTask({ id: "a" }))),
    { type: "custom", customType: "someone-else", data: { version: 999, kind: "whatever" } },
  ];
  const plan = planRestore(collectEntries(branch), 0);
  assert.deepEqual(plan.tasks.map((task) => task.id), ["a"]);
  assert.deepEqual(plan.issues, []);
});
