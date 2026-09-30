/**
 * Pure formatting for the persistent status/widget and `/loop status`: stable
 * countdowns, one line per task with ID/mode/cadence/next/pending, and the
 * compact footer summary.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCountdown,
  formatStatusLine,
  formatTaskLine,
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

test("formatStatusLine reports count, soonest next, and pending total", () => {
  assert.equal(formatStatusLine([], 0), "loop: 0 tasks");
  assert.equal(
    formatStatusLine([task({ nextFireAt: 300_000 })], 0),
    "loop: 1 task · next in 5min",
  );
  assert.equal(
    formatStatusLine(
      [
        task({ id: "t1", nextFireAt: 600_000, pending: true }),
        task({ id: "t2", nextFireAt: 300_000 }),
      ],
      0,
    ),
    "loop: 2 tasks · next in 5min · 1 pending",
  );
});

test("summarizePrompt collapses whitespace and elides a long prompt", () => {
  assert.equal(summarizePrompt("  a\n long\t prompt "), "a long prompt");
  const long = "x".repeat(200);
  const summary = summarizePrompt(long, 10);
  assert.equal(summary.length, 10);
  assert.ok(summary.endsWith("…"));
});
