/**
 * Pure, Pi-independent 5-field cron: parsing, per-field validation, and
 * timezone-aware next-run calculation.
 *
 * The extension already has a fixed-interval scheduler. This module adds the
 * calendar form of the *same* engine: a `CronSchedule` is stored alongside an
 * interval `FixedSchedule` on an ordinary registry task, and the scheduler picks
 * the next boundary with {@link nextCronFireAt} exactly as it does for interval
 * schedules. Nothing here imports the Pi runtime or the scheduler, so a cron
 * schedule is fully testable with fixed clocks and injected zones.
 *
 * Supported grammar per field:
 * - `*` wildcard, a `*` step (`*` `/step`), `value`, `value/step`,
 *   `start-end`, `start-end/step`, and comma-separated lists of any of those.
 * - Ranges must be ascending (`5-10`); a reversed range is rejected.
 * - Month and day-of-week also accept 3-letter names (`JAN`, `MON`).
 * - Sunday is `0` (Vixie cron) or `7`; both are normalised to `0`.
 *
 * Day fields use the classic Vixie rule, made explicit here:
 * - If *both* day-of-month and day-of-week are restricted (each selects fewer
 *   than all of its values), a day matches when **either** field matches.
 * - Otherwise the restricted field alone decides. So `0 0 1 * 1` means "the 1st
 *   or any Monday", `0 0 1 * *` means "the 1st", and `0 0 * * 1` means "Mondays".
 *
 * Timezone semantics:
 * - Every occurrence is a local wall-clock time in the schedule's IANA
 *   `timeZone`, converted to an epoch instant with the offset in force then.
 * - A local time skipped by a DST spring-forward gap does not run that day; a
 *   time repeated by a fall-back overlap runs once, at its **first** occurrence.
 * - {@link nextCronFireAt} always returns a time strictly after the reference and
 *   searches a bounded window, reporting an error instead of looping forever for
 *   an impossible schedule such as `0 0 31 2 *`.
 */

/** One minute in milliseconds; cron's granularity. */
const MINUTE_MS = 60_000;
/** One hour in milliseconds. */
const HOUR_MS = 3_600_000;
/** One day in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * How many local days {@link nextCronFireAt} will scan before giving up. Eight
 * years covers the longest real calendar gap, a February 29 that lands just
 * after a non-leap century (for example 2096 → 2104), and any valid monthly or
 * yearly expression.
 */
export const MAX_CRON_SEARCH_DAYS = 366 * 8;

/** The five cron fields, in canonical order. */
export const CRON_FIELDS = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;

/** A cron field name, used to identify the component an error came from. */
export type CronField = (typeof CRON_FIELDS)[number];

/** The non-field components a validation error can point at. */
export type CronErrorComponent = CronField | "expression" | "timezone";

/**
 * Thrown for an unparsable expression, an out-of-range value, or a schedule with
 * no occurrence in the search window. {@link CronScheduleError.field} names the
 * offending component so callers can report it precisely.
 */
export class CronScheduleError extends Error {
  /** The schedule component the error is about. */
  readonly field: CronErrorComponent | undefined;

  constructor(message: string, field?: CronErrorComponent) {
    super(message);
    this.name = "CronScheduleError";
    this.field = field;
  }
}

/** A parsed, immutable cron expression: the matching values of each field. */
export interface ParsedCron {
  /** Whitespace-normalized source expression. */
  readonly expression: string;
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  /** 1-12. */
  readonly month: readonly number[];
  /** 0-6, Sunday = 0. */
  readonly dayOfWeek: readonly number[];
}

/** A recurring calendar schedule in one local timezone. */
export interface CronSchedule {
  readonly kind: "cron";
  /** Validated, whitespace-normalized 5-field expression. */
  readonly expression: string;
  /** IANA timezone name the expression is interpreted in. */
  readonly timeZone: string;
}

/**
 * True for a {@link CronSchedule}. Accepts the interval `FixedSchedule` shape too
 * (which has no `kind`), so callers can discriminate the two schedule kinds.
 */
export function isCronSchedule(value: unknown): value is CronSchedule {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "cron"
  );
}

interface FieldSpec {
  readonly field: CronField;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
  /** Maps a raw in-range value to its canonical form (Sunday 7 → 0). */
  readonly normalize?: (value: number) => number;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DOW_NAMES: Readonly<Record<string, number>> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MINUTE_SPEC: FieldSpec = { field: "minute", min: 0, max: 59 };
const HOUR_SPEC: FieldSpec = { field: "hour", min: 0, max: 23 };
const DAY_OF_MONTH_SPEC: FieldSpec = { field: "day-of-month", min: 1, max: 31 };
const MONTH_SPEC: FieldSpec = { field: "month", min: 1, max: 12, names: MONTH_NAMES };
const DAY_OF_WEEK_SPEC: FieldSpec = {
  field: "day-of-week",
  min: 0,
  max: 7,
  names: DOW_NAMES,
  normalize: (value) => (value === 7 ? 0 : value),
};

const FIELD_SPECS: readonly FieldSpec[] = [
  MINUTE_SPEC,
  HOUR_SPEC,
  DAY_OF_MONTH_SPEC,
  MONTH_SPEC,
  DAY_OF_WEEK_SPEC,
];

function parseValue(text: string, raw: string, spec: FieldSpec): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CronScheduleError(`invalid ${spec.field} field "${raw}": missing value`, spec.field);
  }
  if (spec.names) {
    const named = spec.names[trimmed.toUpperCase()];
    if (named !== undefined) {
      return named;
    }
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new CronScheduleError(
      `invalid ${spec.field} field "${raw}": "${trimmed}" is not a number${spec.names ? " or name" : ""}`,
      spec.field,
    );
  }
  const value = Number(trimmed);
  if (value < spec.min || value > spec.max) {
    throw new CronScheduleError(
      `invalid ${spec.field} field "${raw}": ${value} is out of range ${spec.min}-${spec.max}`,
      spec.field,
    );
  }
  return value;
}

function addTerm(term: string, raw: string, spec: FieldSpec, values: Set<number>): void {
  let body = term;
  let step = 1;
  const slash = term.indexOf("/");
  if (slash !== -1) {
    body = term.slice(0, slash);
    const stepText = term.slice(slash + 1);
    if (!/^\d+$/.test(stepText)) {
      throw new CronScheduleError(
        `invalid ${spec.field} field "${raw}": step "${stepText}" must be a positive integer`,
        spec.field,
      );
    }
    step = Number(stepText);
    if (step <= 0) {
      throw new CronScheduleError(
        `invalid ${spec.field} field "${raw}": step must be greater than zero`,
        spec.field,
      );
    }
  }

  let start: number;
  let end: number;
  if (body === "*") {
    start = spec.min;
    end = spec.max;
  } else {
    const dash = body.indexOf("-");
    if (dash === -1) {
      start = parseValue(body, raw, spec);
      // `value/step` means value through the field maximum, every step.
      end = slash === -1 ? start : spec.max;
    } else {
      start = parseValue(body.slice(0, dash), raw, spec);
      end = parseValue(body.slice(dash + 1), raw, spec);
      if (start > end) {
        throw new CronScheduleError(
          `invalid ${spec.field} field "${raw}": range ${body} is reversed`,
          spec.field,
        );
      }
    }
  }

  for (let value = start; value <= end; value += step) {
    values.add(spec.normalize ? spec.normalize(value) : value);
  }
}

function parseField(raw: string, spec: FieldSpec): readonly number[] {
  if (raw.length === 0) {
    throw new CronScheduleError(`invalid ${spec.field} field: value is empty`, spec.field);
  }
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const term = part.trim();
    if (term.length === 0) {
      throw new CronScheduleError(`invalid ${spec.field} field "${raw}": empty list item`, spec.field);
    }
    addTerm(term, raw, spec, values);
  }
  return Object.freeze([...values].sort((a, b) => a - b));
}

const parseCache = new Map<string, ParsedCron>();

function parseUncached(key: string): ParsedCron {
  const tokens = key.length === 0 ? [] : key.split(" ");
  if (tokens.length !== 5) {
    throw new CronScheduleError(
      `invalid cron expression: expected 5 fields (minute hour day-of-month month day-of-week) but found ${tokens.length}`,
      "expression",
    );
  }
  return Object.freeze({
    expression: key,
    minute: parseField(tokens[0]!, MINUTE_SPEC),
    hour: parseField(tokens[1]!, HOUR_SPEC),
    dayOfMonth: parseField(tokens[2]!, DAY_OF_MONTH_SPEC),
    month: parseField(tokens[3]!, MONTH_SPEC),
    dayOfWeek: parseField(tokens[4]!, DAY_OF_WEEK_SPEC),
  });
}

/**
 * Parse and validate a 5-field cron expression. The result is cached by its
 * whitespace-normalized form, so repeated calculation does not re-parse.
 *
 * Throws {@link CronScheduleError} naming the offending field for a wrong field
 * count, an unknown value, an out-of-range value, a reversed range, or a
 * non-positive step.
 */
export function parseCronExpression(expression: string): ParsedCron {
  if (typeof expression !== "string") {
    throw new CronScheduleError("cron expression must be a string", "expression");
  }
  const key = expression.trim().replace(/\s+/g, " ");
  const cached = parseCache.get(key);
  if (cached) {
    return cached;
  }
  const parsed = parseUncached(key);
  if (parseCache.size >= 100) {
    parseCache.clear();
  }
  parseCache.set(key, parsed);
  return parsed;
}

/** The process's IANA timezone, or `UTC` if it cannot be determined. */
export function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cronFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new CronScheduleError(`invalid time zone "${timeZone}"`, "timezone");
  }
  if (formatterCache.size >= 100) {
    formatterCache.clear();
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * Validate an expression and timezone together, throwing
 * {@link CronScheduleError} for either. Used when creating or restoring a cron
 * schedule so a persisted, unreadable schedule is rejected up front.
 */
export function validateCronSchedule(expression: string, timeZone: string): void {
  parseCronExpression(expression);
  cronFormatter(timeZone);
}

/**
 * Build a frozen {@link CronSchedule}. Throws {@link CronScheduleError} for an
 * invalid expression or timezone; `timeZone` defaults to the local zone.
 */
export function createCronSchedule(expression: string, timeZone: string = resolveTimeZone()): CronSchedule {
  const parsed = parseCronExpression(expression);
  cronFormatter(timeZone);
  return Object.freeze({ kind: "cron", expression: parsed.expression, timeZone });
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(formatter: Intl.DateTimeFormat, epochMs: number): ZonedParts {
  const parts: ZonedParts = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    switch (part.type) {
      case "year":
        parts.year = Number(part.value);
        break;
      case "month":
        parts.month = Number(part.value);
        break;
      case "day":
        parts.day = Number(part.value);
        break;
      case "hour":
        parts.hour = Number(part.value);
        break;
      case "minute":
        parts.minute = Number(part.value);
        break;
      case "second":
        parts.second = Number(part.value);
        break;
      default:
        break;
    }
  }
  return parts;
}

/** Offset, in milliseconds, between the zone's wall clock and UTC at `epochMs`. */
function timeZoneOffsetMs(formatter: Intl.DateTimeFormat, epochMs: number): number {
  const parts = getZonedParts(formatter, epochMs);
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Every epoch instant whose local wall clock in the zone is exactly
 * `y-mo-d h:mi:00`, in ascending order.
 *
 * An empty result means the local time does not exist (a DST spring-forward
 * gap). Two results occur during a fall-back overlap; callers choose the first
 * to keep behavior deterministic.
 */
function wallTimeCandidates(
  formatter: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number[] {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const targets = new Set<number>();
  // Fixed-point iteration finds the offset in force at the target local time.
  // Around a transition it can land on either side, so every intermediate
  // candidate is kept; the round-trip check below discards the wrong ones.
  let probe = wallAsUtc;
  for (let step = 0; step < 4; step += 1) {
    const candidate = wallAsUtc - timeZoneOffsetMs(formatter, probe);
    targets.add(candidate);
    probe = candidate;
  }
  // Probe a day either side as well, to observe both offsets around a
  // spring-forward gap or fall-back overlap.
  for (const delta of [-DAY_MS - 12 * HOUR_MS, DAY_MS + 12 * HOUR_MS]) {
    targets.add(wallAsUtc - timeZoneOffsetMs(formatter, wallAsUtc + delta));
  }
  const valid: number[] = [];
  for (const candidate of targets) {
    const parts = getZonedParts(formatter, candidate);
    if (
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === 0
    ) {
      valid.push(candidate);
    }
  }
  return valid.sort((a, b) => a - b);
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function addDays(date: CalendarDate, offset: number): CalendarDate {
  const base = new Date(Date.UTC(date.year, date.month - 1, date.day));
  base.setUTCDate(base.getUTCDate() + offset);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function localDayOfWeek(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function dayMatches(
  cron: ParsedCron,
  domRestricted: boolean,
  dowRestricted: boolean,
  day: number,
  dayOfWeek: number,
): boolean {
  const domMatch = cron.dayOfMonth.includes(day);
  const dowMatch = cron.dayOfWeek.includes(dayOfWeek);
  if (domRestricted && dowRestricted) {
    return domMatch || dowMatch;
  }
  if (domRestricted) {
    return domMatch;
  }
  if (dowRestricted) {
    return dowMatch;
  }
  return true;
}

/**
 * The first occurrence strictly after `after`, in epoch milliseconds.
 *
 * Occurrences are evaluated as local wall-clock times in `schedule.timeZone`. A
 * DST gap is skipped (the local time does not exist that day) and an overlap uses
 * the earlier of the two instants. The search is bounded by
 * {@link MAX_CRON_SEARCH_DAYS}; a schedule with no occurrence in that window
 * (for example `0 0 31 2 *`) throws {@link CronScheduleError}.
 */
export function nextCronFireAt(schedule: CronSchedule, after: number): number {
  if (!Number.isFinite(after)) {
    throw new CronScheduleError("reference time must be a finite epoch time");
  }
  const cron = parseCronExpression(schedule.expression);
  const formatter = cronFormatter(schedule.timeZone);

  // Both day fields restricted selects the OR rule (documented on the module).
  const domRestricted = cron.dayOfMonth.length !== 31;
  const dowRestricted = cron.dayOfWeek.length !== 7;

  const afterParts = getZonedParts(formatter, after);
  const start = addDays(afterParts, 0);
  for (let offset = 0; offset <= MAX_CRON_SEARCH_DAYS; offset += 1) {
    const date = addDays(start, offset);
    if (!cron.month.includes(date.month)) {
      continue;
    }
    if (!dayMatches(cron, domRestricted, dowRestricted, date.day, localDayOfWeek(date))) {
      continue;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const hour of cron.hour) {
      // On the reference day, an earlier local hour is always an earlier
      // instant, so skip those to keep calculation cheap.
      if (offset === 0 && hour < afterParts.hour) {
        continue;
      }
      for (const minute of cron.minute) {
        // An overlapping wall time is one scheduled occurrence, at its first
        // instant. Never consider the second instant after the first has fired.
        const first = wallTimeCandidates(formatter, date.year, date.month, date.day, hour, minute)[0];
        if (first !== undefined && first > after && first < earliest) {
          earliest = first;
        }
      }
    }
    if (earliest !== Number.POSITIVE_INFINITY) {
      return earliest;
    }
  }
  throw new CronScheduleError(
    `cron expression "${schedule.expression}" has no run time within ${MAX_CRON_SEARCH_DAYS} days`,
    "expression",
  );
}
