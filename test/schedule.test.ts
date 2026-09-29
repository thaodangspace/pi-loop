import assert from "node:assert/strict";
import test from "node:test";
import {
  createSchedule,
  DAY_MS,
  HOUR_MS,
  MIN_CADENCE_MS,
  MINUTE_MS,
  nextFireAt,
  normalizeCadence,
  ScheduleError,
} from "../src/schedule.ts";

test("seconds below a minute normalize up to the one-minute cadence", () => {
  for (const ms of [1_000, 30_000, 59_999, 60_000]) {
    assert.equal(normalizeCadence(ms), MINUTE_MS, `${ms}ms should become 1min`);
  }
  assert.equal(MIN_CADENCE_MS, MINUTE_MS, "the scheduler floor is one minute");
});

test("clean minute and hour cadences are preserved", () => {
  assert.equal(normalizeCadence(5 * MINUTE_MS), 5 * MINUTE_MS);
  assert.equal(normalizeCadence(30 * MINUTE_MS), 30 * MINUTE_MS);
  assert.equal(normalizeCadence(2 * HOUR_MS), 2 * HOUR_MS);
  assert.equal(normalizeCadence(12 * HOUR_MS), 12 * HOUR_MS);
});

test("awkward intervals snap to the nearest supported cron cadence", () => {
  assert.equal(normalizeCadence(7 * MINUTE_MS), 6 * MINUTE_MS, "7m rounds to 6m");
  assert.equal(normalizeCadence(13 * MINUTE_MS), 12 * MINUTE_MS, "13m rounds to 12m");
  assert.equal(normalizeCadence(90 * MINUTE_MS), 2 * HOUR_MS, "a 90m tie rounds up to 2h");
  assert.equal(normalizeCadence(45 * MINUTE_MS), HOUR_MS, "a 45m tie rounds up to 1h");
  assert.equal(normalizeCadence(5 * HOUR_MS), 6 * HOUR_MS, "a 5h tie rounds up to 6h");
  assert.equal(normalizeCadence(90_000), 2 * MINUTE_MS, "90s rounds up to 2min");
});

test("day intervals are supported", () => {
  assert.equal(normalizeCadence(DAY_MS), DAY_MS);
  assert.equal(normalizeCadence(3 * DAY_MS), 3 * DAY_MS);
  assert.equal(normalizeCadence(24 * HOUR_MS), DAY_MS, "24h and 1d are the same cadence");
  assert.equal(normalizeCadence(20 * HOUR_MS), DAY_MS, "20h snaps up to a day");
});

test("createSchedule normalizes, floors the anchor, and freezes", () => {
  const schedule = createSchedule(30_000, 1_234.9);
  assert.deepEqual(schedule, { intervalMs: MINUTE_MS, anchor: 1_234 });
  assert.equal(Object.isFrozen(schedule), true);
});

test("normalizeCadence and createSchedule reject non-finite input", () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => normalizeCadence(bad), ScheduleError);
    assert.throws(() => createSchedule(bad), ScheduleError);
  }
  assert.equal(normalizeCadence(-5), MINUTE_MS, "non-positive input floors at one minute");
  assert.throws(() => createSchedule(MINUTE_MS, Number.NaN), ScheduleError);
});

test("boundaries are absolute multiples of the cadence from the anchor", () => {
  const schedule = createSchedule(5 * MINUTE_MS);
  assert.equal(nextFireAt(schedule, 0), 5 * MINUTE_MS);
  assert.equal(nextFireAt(schedule, 5 * MINUTE_MS), 10 * MINUTE_MS, "the current boundary is skipped");
  assert.equal(nextFireAt(schedule, 5 * MINUTE_MS + 1), 10 * MINUTE_MS);
  assert.equal(nextFireAt(schedule, 90_000), 5 * MINUTE_MS, "the boundary after an unaligned start");
  assert.equal(nextFireAt(schedule, 4 * MINUTE_MS + 59_999), 5 * MINUTE_MS);
});

test("a non-zero anchor shifts every boundary", () => {
  const schedule = createSchedule(10 * MINUTE_MS, 1_000);
  assert.equal(nextFireAt(schedule, 1_000), 601_000);
  assert.equal(schedule.anchor, 1_000);
  assert.equal(nextFireAt(schedule, 601_000), 1_201_000);
});

test("missed boundaries are skipped rather than replayed", () => {
  const schedule = createSchedule(MINUTE_MS);
  // Ten minutes of sleep collapses to the single next future boundary.
  assert.equal(nextFireAt(schedule, 10 * MINUTE_MS + 30_000), 11 * MINUTE_MS);
  assert.equal(nextFireAt(schedule, 10 * MINUTE_MS), 11 * MINUTE_MS);
});

test("day-cadence boundaries are stable across a long gap", () => {
  const schedule = createSchedule(DAY_MS);
  assert.equal(nextFireAt(schedule, 0), DAY_MS);
  assert.equal(nextFireAt(schedule, 10 * DAY_MS), 11 * DAY_MS);
  assert.equal(nextFireAt(schedule, 10 * DAY_MS + 1), 11 * DAY_MS);
});
