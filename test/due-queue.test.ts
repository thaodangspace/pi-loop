import assert from "node:assert/strict";
import test from "node:test";
import { DueQueue, DueQueueError } from "../src/due-queue.ts";

test("a new queue is empty and reports membership", () => {
  const queue = new DueQueue();
  assert.equal(queue.size, 0);
  assert.equal(queue.has("t1"), false);
  assert.deepEqual(queue.list(), []);
});

test("repeated marks for the same task coalesce into one entry", () => {
  const queue = new DueQueue();
  assert.equal(queue.mark("t1", 60_000, 0), true, "the first mark queues the task");
  assert.equal(queue.mark("t1", 120_000, 0), false, "a later miss is coalesced");
  assert.equal(queue.size, 1);
  assert.deepEqual(
    queue.list(),
    [{ id: "t1", deadline: 60_000, seq: 0 }],
    "coalescing keeps the earliest deadline and position",
  );
});

test("distinct tasks queue independently and remove individually", () => {
  const queue = new DueQueue();
  queue.mark("t1", 60_000, 0);
  queue.mark("t2", 60_000, 1);
  assert.equal(queue.size, 2);

  assert.equal(queue.remove("t1"), true);
  assert.equal(queue.remove("t1"), false, "removing twice is a no-op");
  assert.deepEqual(
    queue.list().map((entry) => entry.id),
    ["t2"],
  );

  queue.clear();
  assert.equal(queue.size, 0);
});

test("flush order is earliest deadline first, ties by registration sequence", () => {
  const queue = new DueQueue();
  queue.mark("late", 300_000, 0);
  queue.mark("early", 60_000, 1);
  queue.mark("tieA", 300_000, 2);
  queue.mark("tieB", 300_000, 3);

  assert.deepEqual(
    queue.list().map((entry) => entry.id),
    ["early", "late", "tieA", "tieB"],
    "earliest missed deadline wins; simultaneous deadlines keep registration order",
  );
});

test("drain returns every entry in order and empties the queue", () => {
  const queue = new DueQueue();
  queue.mark("b", 200_000, 1);
  queue.mark("a", 100_000, 0);

  assert.deepEqual(queue.drain(), [
    { id: "a", deadline: 100_000, seq: 0 },
    { id: "b", deadline: 200_000, seq: 1 },
  ]);
  assert.equal(queue.size, 0);
  assert.deepEqual(queue.drain(), [], "draining an empty queue yields nothing");
});

test("re-marking after a drain restores the original ordering keys", () => {
  const queue = new DueQueue();
  queue.mark("a", 100_000, 0);
  queue.mark("b", 100_000, 1);

  const [first, second] = queue.drain();
  queue.mark(second!.id, second!.deadline, second!.seq);
  queue.mark(first!.id, first!.deadline, first!.seq);

  assert.deepEqual(
    queue.list().map((entry) => entry.id),
    ["a", "b"],
    "the sequence tie-break survives a re-mark regardless of insertion order",
  );
});

test("non-finite ordering keys are rejected", () => {
  const queue = new DueQueue();
  assert.throws(() => queue.mark("t1", Number.NaN, 0), DueQueueError);
  assert.throws(() => queue.mark("t1", Number.POSITIVE_INFINITY, 0), DueQueueError);
  assert.throws(() => queue.mark("t1", 1_000, Number.NaN), DueQueueError);
  assert.equal(queue.size, 0, "a rejected mark leaves the queue untouched");
});
