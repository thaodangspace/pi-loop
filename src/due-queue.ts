/**
 * Scheduler-owned due queue: a pure, Pi-independent record of the tasks whose
 * deadline has passed while Pi was busy.
 *
 * The queue exists so the *scheduler* owns "what is due", independent of any
 * per-task `pending` boolean a registry might expose. A task is identified by
 * its stable registry ID, so an entry can never be duplicated: repeated missed
 * occurrences of the same task coalesce into the single entry already queued.
 *
 * Flush order is deterministic and documented:
 *
 * 1. The earliest missed deadline first.
 * 2. Ties (simultaneous deadlines) broken by the task's registration sequence,
 *    i.e. the order in which the scheduler began tracking it.
 *
 * This module holds no timers and no Pi state, so it is fully unit-testable.
 */

/** One task waiting to be delivered, with the key that orders it. */
export interface DueEntry {
  /** Stable task ID from the registry. */
  readonly id: string;
  /** The earliest deadline the task missed, in epoch milliseconds. */
  readonly deadline: number;
  /** Monotonic registration sequence used only to break deadline ties. */
  readonly seq: number;
}

/** Thrown for an entry that cannot be ordered deterministically. */
export class DueQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DueQueueError";
  }
}

/** Flush order: earliest deadline, then registration sequence. */
function compareEntries(a: DueEntry, b: DueEntry): number {
  return a.deadline - b.deadline || a.seq - b.seq;
}

/**
 * An insertion-coalescing, order-stable set of due tasks.
 *
 * Instances are plain in-memory state (one per scheduler/session); they create
 * no timers and are safe to read at any time.
 */
export class DueQueue {
  private readonly entries = new Map<string, DueEntry>();

  /** How many distinct tasks are currently due. */
  get size(): number {
    return this.entries.size;
  }

  /** Whether `id` is already queued. */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Mark a task due. A task that is already queued is left untouched, so its
   * original (earliest) deadline and position are preserved and repeated misses
   * coalesce instead of growing a backlog.
   *
   * Returns true when the task was newly queued, false when it was coalesced.
   */
  mark(id: string, deadline: number, seq: number): boolean {
    if (this.entries.has(id)) {
      return false;
    }
    if (!Number.isFinite(deadline)) {
      throw new DueQueueError("due deadline must be a finite epoch time");
    }
    if (!Number.isFinite(seq)) {
      throw new DueQueueError("due sequence must be a finite number");
    }
    this.entries.set(id, Object.freeze({ id, deadline, seq }));
    return true;
  }

  /** Remove a task from the queue. Returns whether it was queued. */
  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Drop every queued task. */
  clear(): void {
    this.entries.clear();
  }

  /** Every queued entry, in deterministic flush order. */
  list(): DueEntry[] {
    return [...this.entries.values()].sort(compareEntries);
  }

  /**
   * Remove and return every queued entry, in deterministic flush order. The
   * queue is empty afterwards; callers that stop early can re-{@link mark} the
   * unprocessed entries, which keeps their original deadline and sequence.
   */
  drain(): DueEntry[] {
    const drained = this.list();
    this.entries.clear();
    return drained;
  }
}
