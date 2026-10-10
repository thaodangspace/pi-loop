/**
 * Iteration-scoped runtime guidance for self-paced scheduled turns.
 *
 * A self-paced pi-loop iteration is expected to choose its own continuation:
 * call `schedule_wakeup` with the next delay, or `stop_wakeup` when the task is
 * finished. The packaged `loop-scheduler` skill explains that contract in depth
 * and the tools carry `promptGuidelines`, but a model may never open the skill,
 * and a tool description is only read once the model is already deciding.
 *
 * This module delivers one short, bounded reminder through Pi's
 * `before_agent_start` system-context hook, and only for the turn a self-paced
 * scheduled run actually produced. It is deliberately Pi-side guidance:
 *
 * - **Scheduler semantics are untouched.** No automatic wakeup, no implicit
 *   stop, and no change to the fallback, expiry, timer, or persistence rules.
 *   The reminder is advisory; the model still has to call the tools.
 * - **The scheduled prompt is never rewritten.** The dispatcher still classifies
 *   and sends the original text exactly (or expands a skill/template); guidance
 *   is a separate structured system-prompt section for the turn.
 * - **Strictly iteration-scoped.** A marker is armed with the stable ID of the
 *   task whose run was just dispatched, and consumed only when the scheduler's
 *   live executing-iteration binding reports the same task for the turn that is
 *   starting. It can never target `primaryId`, another task, or an ordinary user
 *   turn, and an independent task's guidance never retargets another.
 * - **Self-cleaning.** The marker is consumed-or-dropped on every turn boundary
 *   (and on session start/tree/shutdown), and Pi diffs system-prompt sections, so
 *   the section disappears on the next turn that is not that iteration.
 *
 * Compatibility: `before_agent_start` and mutable `systemPromptOptions.sections`
 * exist in the declared minimum Pi (`0.87.1`) and the current line. If a host
 * does not provide the hook, no guidance is delivered and scheduling is
 * unaffected — there is no fallback that would alter scheduler behavior.
 */

/** Section key injected into the turn's system prompt. Matches Pi's `^[a-z][a-z0-9_-]*$`. */
export const SELF_PACED_ITERATION_SECTION = "pi_loop_self_paced_iteration";

/**
 * The bounded reminder for one self-paced iteration. Kept to a few sentences:
 * it is injected on every self-paced turn, so it must stay cheap and specific.
 */
export function selfPacedIterationGuidance(taskId: string): string {
  return [
    `You are executing one iteration of the pi-loop self-paced scheduled task ${taskId}.`,
    "Do one bounded unit of work for the scheduled prompt, then choose this task's continuation explicitly:",
    "call schedule_wakeup with a delay (clamped to 1 minute-1 hour) and a concise reason to run again, or call stop_wakeup when the task is finished.",
    "These tools act only on this executing iteration; do not pass a task ID.",
    "The fallback wakeup is a safety net for a missing choice, not the normal continuation path: a second consecutive iteration that chooses neither ends the task.",
  ].join(" ");
}

/** What was armed for the self-paced run that was just dispatched. */
interface ArmedGuidance {
  readonly taskId: string;
  readonly prompt: string;
  /**
   * Whether `prompt` is the exact text the turn will receive. Literal dispatch
   * is byte-for-byte, so a mismatch means this is not that turn. Skill/template
   * dispatch expands the text, so identity rests on the task binding alone.
   */
  readonly exact: boolean;
}

/**
 * Tracks the self-paced iteration whose turn is about to start.
 *
 * One agent turn runs at a time, so a single slot is sufficient: each dispatch
 * arms it and the turn's `before_agent_start` consumes or drops it. Anything
 * left armed at a turn/lifecycle boundary is stale and cleared, so guidance can
 * never bleed into a later unrelated turn.
 */
export interface IterationGuidanceTracker {
  /** Arm the marker for a self-paced run that was just handed to Pi. */
  arm(taskId: string, prompt: string, exact: boolean): void;
  /**
   * Decide whether the turn that is starting is the armed self-paced iteration,
   * consuming the marker either way. `executingTaskId` is the scheduler's live
   * executing-iteration binding (or `undefined` when none is executing), and
   * `turnPrompt` is the prompt Pi is about to run.
   */
  consume(executingTaskId: string | undefined, turnPrompt: string): boolean;
  /** Drop any armed marker without delivering guidance. */
  clear(): void;
  /** Whether a dispatch is currently armed (diagnostics and tests). */
  armed(): boolean;
}

export function createIterationGuidanceTracker(): IterationGuidanceTracker {
  let pending: ArmedGuidance | undefined;
  return {
    arm(taskId: string, prompt: string, exact: boolean): void {
      pending = { taskId, prompt, exact };
    },
    consume(executingTaskId: string | undefined, turnPrompt: string): boolean {
      const armed = pending;
      pending = undefined;
      if (armed === undefined) {
        return false;
      }
      if (executingTaskId === undefined || executingTaskId !== armed.taskId) {
        return false;
      }
      // A literal prompt is delivered byte-for-byte, so a different turn prompt
      // means this is not the run that armed the marker. An expanded
      // skill/template prompt is intentionally not compared.
      if (armed.exact && turnPrompt !== armed.prompt) {
        return false;
      }
      return true;
    },
    clear(): void {
      pending = undefined;
    },
    armed(): boolean {
      return pending !== undefined;
    },
  };
}
