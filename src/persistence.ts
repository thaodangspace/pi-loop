/**
 * Versioned persistence schema for fixed scheduled tasks.
 *
 * Fixed and one-shot tasks survive Pi session reloads and branch navigation by
 * recording their create/update/delete mutations as custom session entries
 * (`customType` {@link PERSISTENCE_CUSTOM_TYPE}). Custom entries do not
 * participate in LLM context; Pi replays them only for extension state.
 *
 * This module is Pi-independent and has no side effects: it validates entries,
 * emits typed mutation events, and replays existing events in order into the set
 * of tasks that should be restored on the active branch. Self-paced wakeups are
 * never persisted; their timing state is intentionally ephemeral. A branch that
 * contains an entry the reader cannot interpret fails closed, so an unknown
 * tombstone can never be bypassed by restoring the readable entries around it.
 */
import { cloneSchedule, defaultExpiresAt, isValidSchedule, type TaskSchedule } from "./schedule.ts";
import type { TaskMode } from "./task-registry.ts";

/**
 * Current schema version. A reader accepts exactly this version. An entry from a
 * newer, unknown version is not guessed at; it makes the branch fail closed.
 */
export const PERSISTENCE_VERSION = 1 as const;

/** `customType` used for every pi-loop persistence entry. */
export const PERSISTENCE_CUSTOM_TYPE = "pi-loop-tasks";

/** A task as written to and read from the session. */
export interface PersistedTask {
  id: string;
  prompt: string;
  mode: TaskMode;
  /** True for a maintenance loop whose prompt is re-resolved on every run. */
  maintenance?: boolean;
  /**
   * True when this task was the command-owned loop (`/loop`). Restore marks it
   * primary again so status and `/loop stop` keep working after a resume.
   */
  primary?: boolean;
  createdAt: number;
  /** Fixed tasks only: the normalized cadence/anchor or a local-time cron expression. */
  schedule?: TaskSchedule;
  /**
   * Next fire time. Authoritative for one-shot tasks; for recurring tasks the
   * scheduler recomputes the next boundary from the schedule on restore.
   */
  nextFireAt?: number;
  /**
   * Absolute time after which the task must not be restored or run. Recurring
   * fixed tasks created by the scheduler default to `createdAt + 7 days`;
   * replay also applies that default when an older entry omitted it.
   */
  expiresAt?: number;
}

/** A task was created (or replaced) with the given metadata. */
export interface PersistedCreateEvent {
  version: typeof PERSISTENCE_VERSION;
  kind: "create";
  task: PersistedTask;
}

/** A tracked task's metadata changed. */
export interface PersistedUpdateEvent {
  version: typeof PERSISTENCE_VERSION;
  kind: "update";
  id: string;
  patch: {
    prompt?: string;
    schedule?: TaskSchedule;
    nextFireAt?: number;
    expiresAt?: number;
  };
}

/** A tracked task was stopped, expired, or otherwise removed (tombstone). */
export interface PersistedDeleteEvent {
  version: typeof PERSISTENCE_VERSION;
  kind: "delete";
  id: string;
}

export type PersistedEvent = PersistedCreateEvent | PersistedUpdateEvent | PersistedDeleteEvent;

/** Build a create event for a task snapshot. */
export function createTaskEvent(task: PersistedTask): PersistedCreateEvent {
  return { version: PERSISTENCE_VERSION, kind: "create", task };
}

/** Build an update event for one task. */
export function updateTaskEvent(id: string, patch: PersistedUpdateEvent["patch"]): PersistedUpdateEvent {
  return { version: PERSISTENCE_VERSION, kind: "update", id, patch };
}

/** Build a delete (tombstone) event for one task. */
export function deleteTaskEvent(id: string): PersistedDeleteEvent {
  return { version: PERSISTENCE_VERSION, kind: "delete", id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSchedule(value: unknown): value is TaskSchedule {
  return isValidSchedule(value);
}

function isTaskMode(value: unknown): value is TaskMode {
  return value === "fixed" || value === "self-paced" || value === "one-shot";
}

/** Result of validating one raw custom-entry payload. */
export type ParseEventResult = { ok: true; event: PersistedEvent } | { ok: false; reason: string };

function invalid(reason: string): ParseEventResult {
  return { ok: false, reason: `ignored malformed persistence entry: ${reason}` };
}

/**
 * Validate one raw custom-entry `data` value.
 *
 * A newer `version` is rejected with a distinct reason (rather than treated as
 * malformed) so callers can report it without discarding the rest of a branch.
 */
export function parseEvent(data: unknown): ParseEventResult {
  if (!isRecord(data)) {
    return invalid("entry is not an object");
  }
  if (!isFiniteNumber(data.version)) {
    return invalid("missing or invalid version");
  }
  if (data.version > PERSISTENCE_VERSION) {
    return { ok: false, reason: `ignored persistence entry from newer schema version ${data.version}` };
  }
  if (data.version !== PERSISTENCE_VERSION) {
    return invalid(`unsupported schema version ${data.version}`);
  }
  if (data.kind === "create") {
    return parseCreate(data);
  }
  if (data.kind === "update") {
    return parseUpdate(data);
  }
  if (data.kind === "delete") {
    if (!isNonEmptyString(data.id)) {
      return invalid("delete event has no task id");
    }
    return { ok: true, event: { version: PERSISTENCE_VERSION, kind: "delete", id: data.id } };
  }
  return invalid(`unknown event kind ${String(data.kind)}`);
}

function parseCreate(data: Record<string, unknown>): ParseEventResult {
  const raw = data.task;
  if (!isRecord(raw)) {
    return invalid("create event has no task");
  }
  if (!isNonEmptyString(raw.id)) {
    return invalid("create event task has no id");
  }
  if (!isNonEmptyString(raw.prompt)) {
    return invalid(`create event for task ${raw.id} has no prompt`);
  }
  if (!isTaskMode(raw.mode)) {
    return invalid(`create event for task ${raw.id} has an unknown mode`);
  }
  if (!isFiniteNumber(raw.createdAt)) {
    return invalid(`create event for task ${raw.id} has no created time`);
  }
  if (raw.maintenance !== undefined && typeof raw.maintenance !== "boolean") {
    return invalid(`create event for task ${raw.id} has an invalid maintenance flag`);
  }
  if (raw.primary !== undefined && typeof raw.primary !== "boolean") {
    return invalid(`create event for task ${raw.id} has an invalid primary flag`);
  }
  if (raw.schedule !== undefined && !isSchedule(raw.schedule)) {
    return invalid(`create event for task ${raw.id} has an invalid schedule`);
  }
  if (raw.nextFireAt !== undefined && !isFiniteNumber(raw.nextFireAt)) {
    return invalid(`create event for task ${raw.id} has an invalid next fire time`);
  }
  if (raw.expiresAt !== undefined && !isFiniteNumber(raw.expiresAt)) {
    return invalid(`create event for task ${raw.id} has an invalid expiry`);
  }
  const task: PersistedTask = {
    id: raw.id,
    prompt: raw.prompt,
    mode: raw.mode,
    createdAt: raw.createdAt,
    ...(raw.maintenance === true ? { maintenance: true } : {}),
    ...(raw.primary === true ? { primary: true } : {}),
    ...(raw.schedule === undefined ? {} : { schedule: cloneSchedule(raw.schedule) }),
    ...(raw.nextFireAt === undefined ? {} : { nextFireAt: raw.nextFireAt }),
    ...(raw.expiresAt === undefined ? {} : { expiresAt: raw.expiresAt }),
  };
  return { ok: true, event: createTaskEvent(task) };
}

function parseUpdate(data: Record<string, unknown>): ParseEventResult {
  if (!isNonEmptyString(data.id)) {
    return invalid("update event has no task id");
  }
  if (!isRecord(data.patch)) {
    return invalid(`update event for task ${data.id} has no patch`);
  }
  const patch = data.patch;
  if (patch.prompt !== undefined && !isNonEmptyString(patch.prompt)) {
    return invalid(`update event for task ${data.id} has an invalid prompt`);
  }
  if (patch.schedule !== undefined && !isSchedule(patch.schedule)) {
    return invalid(`update event for task ${data.id} has an invalid schedule`);
  }
  if (patch.nextFireAt !== undefined && !isFiniteNumber(patch.nextFireAt)) {
    return invalid(`update event for task ${data.id} has an invalid next fire time`);
  }
  if (patch.expiresAt !== undefined && !isFiniteNumber(patch.expiresAt)) {
    return invalid(`update event for task ${data.id} has an invalid expiry`);
  }
  return {
    ok: true,
    event: updateTaskEvent(data.id, {
      ...(patch.prompt === undefined ? {} : { prompt: patch.prompt }),
      ...(patch.schedule === undefined ? {} : { schedule: cloneSchedule(patch.schedule) }),
      ...(patch.nextFireAt === undefined ? {} : { nextFireAt: patch.nextFireAt }),
      ...(patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt }),
    }),
  };
}

/** Minimal structural view of a session entry needed to find persisted events. */
export interface PersistedEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** One readable entry, or a report explaining why it could not be interpreted. */
export type PersistedEntryResult = { ok: true; event: PersistedEvent } | { ok: false; reason: string };

/**
 * Collect this extension's custom entries from one branch, in branch order.
 *
 * Only entries with the matching `customType` are considered; every other entry
 * type belongs to another system and is ignored. Entries that cannot be
 * interpreted (malformed, or written by a newer schema version) are returned as
 * failures rather than silently dropped, so replay can fail closed instead of
 * resurrecting state they might have deleted.
 */
export function collectEntries(branch: readonly PersistedEntryLike[]): PersistedEntryResult[] {
  const entries: PersistedEntryResult[] = [];
  for (const entry of branch) {
    if (!entry || entry.type !== "custom" || entry.customType !== PERSISTENCE_CUSTOM_TYPE) {
      continue;
    }
    entries.push(parseEvent(entry.data));
  }
  return entries;
}

function applyPatch(task: PersistedTask, patch: PersistedUpdateEvent["patch"]): PersistedTask {
  const schedule = patch.schedule ?? task.schedule;
  return {
    id: task.id,
    prompt: patch.prompt ?? task.prompt,
    mode: task.mode,
    ...(task.maintenance ? { maintenance: true } : {}),
    ...(task.primary ? { primary: true } : {}),
    createdAt: task.createdAt,
    ...(schedule === undefined ? {} : { schedule: cloneSchedule(schedule) }),
    ...((patch.nextFireAt ?? task.nextFireAt) === undefined ? {} : { nextFireAt: patch.nextFireAt ?? task.nextFireAt }),
    ...((patch.expiresAt ?? task.expiresAt) === undefined ? {} : { expiresAt: patch.expiresAt ?? task.expiresAt }),
  };
}

interface Restoration {
  restore: boolean;
  issue?: string;
}

/** Decide whether one replayed task should be restored at `now`. */
function decideRestoration(task: PersistedTask, now: number): Restoration {
  if (task.mode === "self-paced") {
    return { restore: false, issue: `ignored persisted self-paced task ${task.id}; self-paced loops are ephemeral` };
  }
  if (task.mode === "fixed" && task.schedule === undefined) {
    return { restore: false, issue: `ignored persisted fixed task ${task.id} with no schedule` };
  }
  if (task.mode === "one-shot" && task.nextFireAt === undefined) {
    return { restore: false, issue: `ignored persisted one-shot task ${task.id} with no next fire time` };
  }
  // Recurring fixed tasks default to a seven-day lifetime from their original
  // creation time, including tasks persisted before the default existed.
  const expiresAt = task.expiresAt ?? (task.mode === "fixed" ? defaultExpiresAt(task.createdAt) : undefined);
  if (expiresAt !== undefined && expiresAt <= now) {
    // Expired: intentionally dropped without an error notification.
    return { restore: false };
  }
  if (task.mode === "one-shot" && task.nextFireAt !== undefined && task.nextFireAt <= now) {
    // A missed one-shot is not replayed; one-shot tasks do not repeat.
    return { restore: false };
  }
  return { restore: true };
}

/** Result of replaying persisted events into the set of tasks to restore. */
export interface RestorePlan {
  /** Tasks to restore, in first-create order. */
  tasks: PersistedTask[];
  /** Human-readable reasons for entries/tasks that were skipped. */
  issues: string[];
}

/**
 * Replay a branch's persisted entries into the tasks to restore.
 *
 * The branch fails closed on any entry that cannot be interpreted (a malformed
 * event or one from a newer schema version). Such an entry may be a tombstone or
 * a rewrite whose meaning is unknown, so restoring the readable entries around
 * it could resurrect a task that the unreadable entry deleted. When any entry is
 * unreadable, no task from the branch is restored and every failure is reported.
 *
 * Otherwise, later events for the same id override earlier ones, so a delete
 * tombstone removes a create and a later create resurrects the id. Updates for
 * unknown ids are ignored. Expired tasks, missed one-shots, and self-paced tasks
 * are dropped (self-paced with a reported issue).
 */
export function planRestore(entries: readonly PersistedEntryResult[], now: number): RestorePlan {
  const issues: string[] = [];
  const events: PersistedEvent[] = [];
  let unreadable = false;
  for (const entry of entries) {
    if (entry.ok) {
      events.push(entry.event);
    } else {
      unreadable = true;
      issues.push(entry.reason);
    }
  }
  if (unreadable) {
    // Fail closed for the whole branch: an unreadable entry cannot be proven
    // incapable of deleting or rewriting any task, so nothing is safe to restore.
    return { tasks: [], issues };
  }

  const tasks = new Map<string, PersistedTask>();
  for (const event of events) {
    if (event.kind === "create") {
      tasks.delete(event.task.id);
      tasks.set(event.task.id, {
        id: event.task.id,
        prompt: event.task.prompt,
        mode: event.task.mode,
        ...(event.task.maintenance ? { maintenance: true } : {}),
        ...(event.task.primary ? { primary: true } : {}),
        createdAt: event.task.createdAt,
        ...(event.task.schedule === undefined ? {} : { schedule: cloneSchedule(event.task.schedule) }),
        ...(event.task.nextFireAt === undefined ? {} : { nextFireAt: event.task.nextFireAt }),
        ...(event.task.expiresAt === undefined ? {} : { expiresAt: event.task.expiresAt }),
      });
    } else if (event.kind === "update") {
      const current = tasks.get(event.id);
      if (!current) {
        issues.push(`ignored update for unknown task ${event.id}`);
        continue;
      }
      const patched = applyPatch(current, event.patch);
      tasks.delete(event.id);
      tasks.set(event.id, patched);
    } else {
      tasks.delete(event.id);
    }
  }

  const restored: PersistedTask[] = [];
  for (const task of tasks.values()) {
    const decision = decideRestoration(task, now);
    if (decision.restore) {
      restored.push(task);
    } else if (decision.issue !== undefined) {
      issues.push(decision.issue);
    }
  }
  return { tasks: restored, issues };
}

/** Replay already-validated events (no unreadable entries to fail closed on). */
export function replayEvents(events: readonly PersistedEvent[], now: number): RestorePlan {
  return planRestore(
    events.map((event) => ({ ok: true, event })),
    now,
  );
}
