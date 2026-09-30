/**
 * Deterministic unit tests for the 5-field cron parser and next-run calculator.
 *
 * Every calculation injects a fixed IANA zone so results never depend on the
 * host's local timezone, and DST cases use the real America/New_York rules.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createCronSchedule,
  CronScheduleError,
  isCronSchedule,
  MAX_CRON_SEARCH_DAYS,
  nextCronFireAt,
  parseCronExpression,
} from "../src/cron.ts";

const MINUTE = 60_000;

test("wildcard, value, step, range, and list forms parse per field", () => {
  const fields = parseCronExpression("*/15 9-17 * * MON-FRI");
  assert.deepEqual(fields.minute, [0, 15, 30, 45]);
  assert.deepEqual(fields.hour, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(fields.dayOfMonth, Array.from({ length: 31 }, (_, i) => i + 1));
  assert.deepEqual(fields.month, Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(fields.dayOfWeek, [1, 2, 3, 4, 5]);

  const listed = parseCronExpression("0,30 1 1,15 JAN,MAR *");
  assert.deepEqual(listed.minute, [0, 30]);
  assert.deepEqual(listed.hour, [1]);
  assert.deepEqual(listed.dayOfMonth, [1, 15]);
  assert.deepEqual(listed.month, [1, 3]);
  assert.deepEqual(listed.dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
});

test("stepped ranges and open-ended steps are supported", () => {
  assert.deepEqual(parseCronExpression("5/15 * * * *").minute, [5, 20, 35, 50]);
  assert.deepEqual(parseCronExpression("10-14/2 * * * *").minute, [10, 12, 14]);
});

test("Sunday is accepted as both 0 and 7", () => {
  assert.deepEqual(parseCronExpression("0 0 * * 7").dayOfWeek, [0]);
  assert.deepEqual(parseCronExpression("0 0 * * 0").dayOfWeek, [0]);
  assert.deepEqual(parseCronExpression("0 0 * * 0-7").dayOfWeek, [0, 1, 2, 3, 4, 5, 6]);
});

test("validation errors name the invalid component", () => {
  const cases: Array<[string, string]> = [
    ["60 * * * *", "minute"],
    ["* 24 * * *", "hour"],
    ["* * 0 * *", "day-of-month"],
    ["* * 32 * *", "day-of-month"],
    ["* * * 13 *", "month"],
    ["* * * * 8", "day-of-week"],
    ["*/0 * * * *", "minute"],
    ["10-5 * * * *", "minute"],
    ["* * * *", "expression"],
    ["* * * * * *", "expression"],
    ["a * * * *", "minute"],
  ];
  for (const [expression, field] of cases) {
    assert.throws(
      () => parseCronExpression(expression),
      (error: unknown) => error instanceof CronScheduleError && error.field === field,
      `expected ${JSON.stringify(expression)} to fail on ${field}`,
    );
  }
});

test("an invalid timezone is reported as a timezone error", () => {
  assert.throws(
    () => createCronSchedule("0 9 * * *", "Not/AZone"),
    (error: unknown) => error instanceof CronScheduleError && error.field === "timezone",
  );
});

test("createCronSchedule normalizes whitespace, freezes, and validates", () => {
  const schedule = createCronSchedule("  0   9 * * 1-5 ", "UTC");
  assert.deepEqual(schedule, { kind: "cron", expression: "0 9 * * 1-5", timeZone: "UTC" });
  assert.equal(Object.isFrozen(schedule), true);
  assert.equal(isCronSchedule(schedule), true);
  assert.equal(isCronSchedule({ intervalMs: 60_000, anchor: 0 }), false);
});

test("nextCronFireAt returns the strictly next future minute in UTC", () => {
  const schedule = createCronSchedule("*/15 * * * *", "UTC");
  assert.equal(nextCronFireAt(schedule, 0), 15 * MINUTE);
  assert.equal(nextCronFireAt(schedule, 15 * MINUTE - 1), 15 * MINUTE);
  assert.equal(nextCronFireAt(schedule, 15 * MINUTE), 30 * MINUTE);
  assert.equal(nextCronFireAt(schedule, 16 * MINUTE), 30 * MINUTE);
});

test("a local wall-clock schedule is resolved in its timezone", () => {
  const schedule = createCronSchedule("0 9 * * 1-5", "America/New_York");
  // Mon 5 Jan 2026 00:00Z is still Sun evening in New York; the next weekday 9am
  // local is Mon 09:00 EST = 14:00Z.
  assert.equal(
    nextCronFireAt(schedule, Date.UTC(2026, 0, 5, 0, 0)),
    Date.UTC(2026, 0, 5, 14, 0),
  );
});

test("a DST spring-forward gap is skipped, not shifted", () => {
  const schedule = createCronSchedule("30 2 * * *", "America/New_York");
  // 2024-03-10 02:30 does not exist in New York, so that day is skipped; the
  // next run is 2024-03-11 02:30 EDT (UTC-4).
  assert.equal(
    nextCronFireAt(schedule, Date.UTC(2024, 2, 9, 12, 0)),
    Date.UTC(2024, 2, 11, 6, 30),
  );
});

test("a DST fall-back overlap fires only at the first occurrence", () => {
  const schedule = createCronSchedule("30 1 * * *", "America/New_York");
  // 2024-11-03 01:30 occurs twice: 05:30Z (EDT) then 06:30Z (EST).
  assert.equal(nextCronFireAt(schedule, Date.UTC(2024, 10, 3, 4, 0)), Date.UTC(2024, 10, 3, 5, 30));
  // Once the earlier instant has passed, the later duplicate is skipped.
  assert.equal(nextCronFireAt(schedule, Date.UTC(2024, 10, 3, 6, 0)), Date.UTC(2024, 10, 4, 6, 30));
});

test("a valid local time on a spring-forward day uses the post-transition offset", () => {
  const schedule = createCronSchedule("0 9 * * *", "America/New_York");
  // 2024-03-10 09:00 is EDT (UTC-4) after the 02:00 jump.
  assert.equal(nextCronFireAt(schedule, Date.UTC(2024, 2, 10, 0, 0)), Date.UTC(2024, 2, 10, 13, 0));
});

test("half-hour timezone offsets resolve to the correct instant", () => {
  const schedule = createCronSchedule("0 9 * * *", "Asia/Kolkata");
  // IST is UTC+5:30, so 09:00 local is 03:30Z.
  assert.equal(nextCronFireAt(schedule, Date.UTC(2026, 0, 1, 0, 0)), Date.UTC(2026, 0, 1, 3, 30));
});

test("day-of-month and day-of-week both restricted match on either (OR rule)", () => {
  const either = createCronSchedule("0 0 1 * 1", "UTC");
  // From 2024-01-02 the next match is Mon 2024-01-08 (the 1st is already past).
  assert.equal(nextCronFireAt(either, Date.UTC(2024, 0, 2)), Date.UTC(2024, 0, 8));

  const onlyDom = createCronSchedule("0 0 1 * *", "UTC");
  assert.equal(nextCronFireAt(onlyDom, Date.UTC(2024, 0, 2)), Date.UTC(2024, 1, 1));

  const onlyDow = createCronSchedule("0 0 * * 1", "UTC");
  assert.equal(nextCronFireAt(onlyDow, Date.UTC(2024, 0, 2)), Date.UTC(2024, 0, 8));
});

test("an impossible schedule reports a bounded error instead of looping", () => {
  const schedule = createCronSchedule("0 0 31 2 *", "UTC");
  assert.throws(
    () => nextCronFireAt(schedule, Date.UTC(2024, 0, 1)),
    (error: unknown) => error instanceof CronScheduleError && error.field === "expression",
  );
  assert.ok(MAX_CRON_SEARCH_DAYS >= 366 * 8);
});

test("nextCronFireAt rejects a non-finite reference time", () => {
  const schedule = createCronSchedule("* * * * *", "UTC");
  assert.throws(() => nextCronFireAt(schedule, Number.NaN), CronScheduleError);
});
