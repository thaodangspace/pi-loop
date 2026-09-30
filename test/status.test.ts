/**
 * Pure formatting for the persistent status/widget and `/loop status`: stable
 * countdowns, one line per task with ID/mode/cadence/next/pending, and the
 * compact footer summary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  footerStatus,
  formatClockTime,
  formatCountdown,
  formatStatusLine,
  formatTaskDetail,
  formatTaskLine,
  orderStatusTasks,
  summarizePrompt,
} from "../src/status.ts";
import type { ScheduledTask } from "../src/task-registry.ts";

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    prompt: "check deploy",
    mode: "fixed",
    createdAt: 0,
    pending: false,
    ...overrides,
  } as ScheduledTask;
}

test("formatCountdown collapses to at most two units and floors past times", () => {
  assert.equal(formatCountdown(1_000, 1_000), "due now");
  assert.equal(formatCountdown(1_000, 500), "due now");
  assert.equal(formatCountdown(0, 12_000), "in 12s");
  assert.equal(formatCountdown(0, 5 * 60_000), "in 5min");
  assert.equal(formatCountdown(0, 75 * 60_000), "in 1h 15min");
  assert.equal(formatCountdown(0, 26 * 3_600_000), "in 1d 2h");
  assert.equal(formatCountdown(0, Number.NaN), "at an unknown time");
});

test("formatTaskLine renders ID, mode, cadence, next and pending", () => {
  const fixed = formatTaskLine(
    task({ id: "t1", mode: "fixed", schedule: { intervalMs: 300_000, anchor: 0 }, nextFireAt: 300_000 }),
    0,
  );
  assert.match(fixed, /^t1 · \[fixed\] · every 5min · next in 5min: check deploy$/);

  const queued = formatTaskLine(
    task({ id: "t2", mode: "fixed", schedule: { intervalMs: 60_000, anchor: 0 }, pending: true }),
    0,
  );
  assert.match(queued, /\[fixed\] · every 1min · pending/);

  const cron = formatTaskLine(
    task({
      id: "t3",
      mode: "fixed",
      schedule: { kind: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" },
      nextFireAt: 0,
    }),
    1_000,
  );
  assert.match(cron, /cron "0 9 \* \* 1-5" \(UTC\) · next due now/);

  const selfPaced = formatTaskLine(task({ id: "t4", mode: "self-paced", nextFireAt: 120_000 }), 0);
  assert.match(selfPaced, /^t4 · \[self-paced\] · next in 2min: check deploy$/);

  const oneShot = formatTaskLine(task({ id: "t5", mode: "one-shot", nextFireAt: 0 }), 0);
  assert.match(oneShot, /^t5 · \[one-shot\] · next due now: check deploy$/);
});

test("formatClockTime renders an absolute instant as local wall-clock time", () => {
  // Build from local components so the expectation is timezone-independent.
  const nine = new Date(2026, 8, 30, 9, 0, 0).getTime();
  const nineFive = new Date(2026, 8, 30, 9, 5, 0).getTime();
  const endOfDay = new Date(2026, 8, 30, 23, 59, 0).getTime();
  assert.equal(formatClockTime(nine), "09:00");
  assert.equal(formatClockTime(nineFive), "09:05");
  assert.equal(formatClockTime(endOfDay), "23:59");
  assert.equal(formatClockTime(Number.NaN), undefined);
  assert.equal(formatClockTime(Number.POSITIVE_INFINITY), undefined);
});

test("footerStatus projects total, per-mode counts, and the earliest known next fire", () => {
  const model = footerStatus([
    task({ id: "t1", mode: "fixed", nextFireAt: 600_000 }),
    task({ id: "t2", mode: "fixed" }),
    task({ id: "t3", mode: "self-paced", nextFireAt: 300_000 }),
    task({ id: "t4", mode: "one-shot", nextFireAt: Number.NaN }),
  ]);
  assert.equal(model.total, 4);
  assert.deepEqual(model.counts, { fixed: 2, selfPaced: 1, oneShot: 1 });
  assert.equal(model.nextFireAt, 300_000, "the earliest finite nextFireAt wins");

  const empty = footerStatus([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.nextFireAt, undefined, "no next fire time when there is nothing to time");
});

test("formatStatusLine renders a compact one-line footer with local next time", () => {
  const nine = new Date(2026, 8, 30, 9, 0, 0).getTime();

  assert.equal(formatStatusLine([]), "⟳ 0 loops");
  assert.equal(
    formatStatusLine([task({ nextFireAt: nine })]),
    "⟳ 1 loop · next 09:00",
  );
  assert.equal(formatStatusLine([task()]), "⟳ 1 loop", "no next time when none is known");
  assert.equal(
    formatStatusLine([task({ nextFireAt: nine, pending: true })]),
    "⟳ 1 loop · next 09:00",
    "a pending run stays one footer line and adds no marker",
  );

  assert.equal(
    formatStatusLine([
      task({ id: "t1", mode: "fixed", nextFireAt: nine }),
      task({ id: "t2", mode: "fixed", nextFireAt: nine + 60_000 }),
      task({ id: "t3", mode: "self-paced", nextFireAt: nine + 120_000 }),
    ]),
    "⟳ 3 loops · 2 fixed · 1 self-paced · next 09:00",
  );
  assert.equal(
    formatStatusLine([
      task({ id: "t1", mode: "fixed", nextFireAt: nine }),
      task({ id: "t2", mode: "one-shot", nextFireAt: nine + 30_000 }),
    ]),
    "⟳ 2 loops · 1 fixed · 1 one-shot · next 09:00",
  );
  assert.equal(
    formatStatusLine([
      task({ id: "t1", mode: "fixed", nextFireAt: nine }),
      task({ id: "t2", mode: "fixed", nextFireAt: nine + 60_000 }),
    ]),
    "⟳ 2 loops · 2 fixed · next 09:00",
  );
  assert.equal(
    formatStatusLine([
      task({ id: "t1" }),
      task({ id: "t2", nextFireAt: nine }),
    ]),
    "⟳ 2 loops · 2 fixed · next 09:00",
    "tasks without a next time still count and the earliest known one is shown",
  );
});

test("summarizePrompt collapses whitespace and elides a long prompt", () => {
  assert.equal(summarizePrompt("  a\n long\t prompt "), "a long prompt");
  const long = "x".repeat(200);
  const summary = summarizePrompt(long, 10);
  assert.equal(summary.length, 10);
  assert.ok(summary.endsWith("…"));
});

test("formatTaskLine marks the command-owned loop and maintenance tasks", () => {
  const primary = formatTaskLine(
    task({ id: "t1", mode: "self-paced", maintenance: true, nextFireAt: 60_000 }),
    0,
    { primary: true },
  );
  assert.equal(primary, "t1 · [self-paced] · primary · maintenance · next in 1min: check deploy");

  const independent = formatTaskLine(
    task({ id: "t2", mode: "fixed", schedule: { intervalMs: 300_000, anchor: 0 }, nextFireAt: 300_000 }),
    0,
  );
  assert.equal(independent, "t2 · [fixed] · every 5min · next in 5min: check deploy");
  assert.doesNotMatch(independent, /primary/);
});

test("orderStatusTasks puts the command-owned loop first, then creation order", () => {
  const a = task({ id: "a", createdAt: 0 });
  const b = task({ id: "b", createdAt: 1 });
  const c = task({ id: "c", createdAt: 2 });

  assert.deepEqual(orderStatusTasks([a, b, c], undefined).map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(orderStatusTasks([a, b, c], "c").map((item) => item.id), ["c", "a", "b"]);
  assert.deepEqual(orderStatusTasks([a, b, c], "b").map((item) => item.id), ["b", "a", "c"]);
  assert.deepEqual(
    orderStatusTasks([a, b, c], "missing").map((item) => item.id),
    ["a", "b", "c"],
    "a stale primary ID falls back to registry order",
  );
});

test("formatTaskDetail renders the full fields for one task", () => {
  const detail = formatTaskDetail(
    task({
      id: "t1",
      mode: "fixed",
      schedule: { intervalMs: 300_000, anchor: 0 },
      nextFireAt: 300_000,
      expiresAt: 600_000,
      reason: "why",
    }),
    0,
    { primary: true },
  );
  assert.match(detail, /^Task t1 \(command-owned\) · \[fixed\]/);
  assert.match(detail, /Schedule: every 5min/);
  assert.match(detail, /Next run: in 5min/);
  assert.match(detail, /Status: scheduled/);
  assert.match(detail, /Expires: in 10min/);
  assert.match(detail, /Last reason: why/);
  assert.match(detail, /Prompt: check deploy/);

  const pending = formatTaskDetail(
    task({ id: "t2", mode: "self-paced", maintenance: true, pending: true }),
    0,
  );
  assert.match(pending, /^Task t2 · \[self-paced · maintenance\]/);
  assert.match(pending, /Schedule: self-paced \(each iteration chooses its next wakeup\)/);
  assert.match(pending, /Status: one run queued for the next idle moment/);
});
