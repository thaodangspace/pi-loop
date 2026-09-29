import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MAX_TASKS,
  RegistryDisposedError,
  TaskLimitError,
  TaskNotFoundError,
  TaskRegistry,
  TaskRegistryError,
} from "../src/task-registry.ts";

/** A registry with a controllable clock and deterministic IDs. */
function makeRegistry(options: { maxTasks?: number } = {}): {
  registry: TaskRegistry;
  setNow: (value: number) => void;
} {
  let clock = 0;
  let counter = 0;
  const registry = new TaskRegistry({
    now: () => clock,
    createId: () => `t${(counter += 1)}`,
    ...options,
  });
  return { registry, setNow: (value) => (clock = value) };
}

test("create returns a stable short ID and stamps the injected time", () => {
  const { registry, setNow } = makeRegistry();
  setNow(1_234);

  const task = registry.create({ prompt: "check deploy", mode: "fixed" });
  assert.equal(task.id, "t1");
  assert.equal(task.prompt, "check deploy");
  assert.equal(task.mode, "fixed");
  assert.equal(task.createdAt, 1_234);
  assert.equal(task.nextFireAt, undefined);
  assert.equal(task.pending, false);
  assert.equal(registry.size, 1);

  // The ID does not change on later reads or updates.
  assert.equal(registry.get("t1")?.id, "t1");
  assert.equal(registry.update("t1", { pending: true }).id, "t1");
});

test("multiple tasks coexist without replacing each other", () => {
  const { registry } = makeRegistry();

  const first = registry.create({ prompt: "one", mode: "fixed", nextFireAt: 1_000 });
  const second = registry.create({ prompt: "two", mode: "self-paced" });
  const third = registry.create({ prompt: "three", mode: "one-shot" });

  assert.deepEqual(
    registry.list().map((task) => task.id),
    [first.id, second.id, third.id],
    "list preserves creation order",
  );
  assert.equal(registry.size, 3);
  assert.deepEqual(registry.get(second.id), second);
  assert.equal(registry.has(first.id), true);
});

test("delete removes one task and reports whether it existed", () => {
  const { registry } = makeRegistry();
  const first = registry.create({ prompt: "one", mode: "fixed" });
  const second = registry.create({ prompt: "two", mode: "fixed" });

  assert.equal(registry.delete(second.id), true);
  assert.equal(registry.size, 1);
  assert.equal(registry.has(second.id), false);
  assert.equal(registry.get(second.id), undefined);
  assert.equal(registry.delete(second.id), false, "deleting twice is a no-op");
  assert.equal(registry.has(first.id), true, "other tasks are untouched");
});

test("update modifies only the requested fields and keeps identity stable", () => {
  const { registry } = makeRegistry();
  const created = registry.create({ prompt: "one", mode: "fixed" });

  const updated = registry.update(created.id, { pending: true, nextFireAt: 5_000 });
  assert.equal(updated.id, created.id);
  assert.equal(updated.prompt, "one");
  assert.equal(updated.mode, "fixed");
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.pending, true);
  assert.equal(updated.nextFireAt, 5_000);

  const cleared = registry.update(created.id, { nextFireAt: null, pending: false });
  assert.equal(cleared.nextFireAt, undefined, "null clears nextFireAt");
  assert.equal(cleared.pending, false);

  assert.throws(() => registry.update("missing", { pending: true }), TaskNotFoundError);
});

test("snapshots are frozen so callers cannot corrupt registry state", () => {
  const { registry } = makeRegistry();
  const task = registry.create({ prompt: "one", mode: "fixed" });

  assert.equal(Object.isFrozen(task), true);
  assert.throws(() => {
    (task as { prompt: string }).prompt = "tampered";
  }, TypeError);
  assert.equal(registry.get(task.id)?.prompt, "one");
});

test("the active-task limit is enforced and freed slots can be reused", () => {
  const { registry } = makeRegistry({ maxTasks: 2 });
  const first = registry.create({ prompt: "one", mode: "fixed" });
  registry.create({ prompt: "two", mode: "fixed" });

  assert.throws(() => registry.create({ prompt: "three", mode: "fixed" }), TaskLimitError);
  assert.equal(registry.size, 2);

  registry.delete(first.id);
  const replacement = registry.create({ prompt: "three", mode: "fixed" });
  assert.equal(replacement.id, "t3");
  assert.equal(registry.size, 2);
});

test("an empty prompt is rejected", () => {
  const { registry } = makeRegistry();
  for (const prompt of ["", "   ", "\n"]) {
    assert.throws(() => registry.create({ prompt, mode: "fixed" }), TaskRegistryError);
  }
  assert.equal(registry.size, 0);

  const task = registry.create({ prompt: "keep", mode: "fixed" });
  assert.throws(() => registry.update(task.id, { prompt: "  " }), TaskRegistryError);
  assert.equal(registry.get(task.id)?.prompt, "keep");
});

test("maxTasks must be a positive integer", () => {
  for (const maxTasks of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => new TaskRegistry({ maxTasks }), TaskRegistryError);
  }
  assert.equal(new TaskRegistry().size, 0);
  assert.equal(DEFAULT_MAX_TASKS > 0, true);
});

test("clear drops every task but keeps the registry usable", () => {
  const { registry } = makeRegistry();
  registry.create({ prompt: "one", mode: "fixed" });
  registry.create({ prompt: "two", mode: "fixed" });

  registry.clear();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.list(), []);

  const after = registry.create({ prompt: "three", mode: "fixed" });
  assert.equal(after.id, "t3", "IDs keep advancing after a clear");
  assert.equal(registry.isDisposed, false);
});

test("dispose is idempotent, clears state, and blocks mutation", () => {
  const { registry } = makeRegistry();
  registry.create({ prompt: "one", mode: "fixed" });

  registry.dispose();
  registry.dispose();
  assert.equal(registry.size, 0);
  assert.equal(registry.isDisposed, true);
  assert.throws(() => registry.create({ prompt: "two", mode: "fixed" }), RegistryDisposedError);
  assert.throws(() => registry.update("t1", { pending: true }), RegistryDisposedError);

  // Reads and cleanup stay safe after disposal.
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.get("t1"), undefined);
  assert.equal(registry.delete("t1"), false);
});

test("duplicate injected IDs are skipped by the allocator", () => {
  const ids = ["dup", "dup", "unique"];
  let index = 0;
  const registry = new TaskRegistry({ createId: () => ids[Math.min(index++, ids.length - 1)] ?? "unique" });
  assert.equal(registry.create({ prompt: "one", mode: "fixed" }).id, "dup");
  assert.equal(registry.create({ prompt: "two", mode: "fixed" }).id, "unique");
});

test("an invalid ID generator is reported", () => {
  const registry = new TaskRegistry({ createId: () => "" });
  assert.throws(() => registry.create({ prompt: "one", mode: "fixed" }), TaskRegistryError);
});

test("registries are independent, so sessions share no task state", () => {
  const a = makeRegistry();
  const b = makeRegistry();

  a.registry.create({ prompt: "one", mode: "fixed" });
  assert.equal(a.registry.size, 1);
  assert.equal(b.registry.size, 0, "a second registry starts empty");
  assert.equal(b.registry.get("t1"), undefined);
});
