/**
 * Resolution of the maintenance prompt used by bare and interval-only `/loop`.
 *
 * A maintenance loop has no command-line prompt. Instead, every iteration
 * resolves the prompt fresh, in this order:
 *
 * 1. `.claude/loop.md` in the project directory (project override).
 * 2. `~/.claude/loop.md` (user default).
 * 3. The built-in maintenance prompt.
 *
 * Resolution is stateless and runs on each run, so edits to a `loop.md` take
 * effect on the next iteration without restarting the loop.
 *
 * A file that exists but cannot be read is a hard error: the resolver never
 * quietly substitutes a different source, so an unreadable project override
 * surfaces instead of silently falling back to the user file or the built-in
 * prompt. A missing file (ENOENT) is the normal "not configured" case and falls
 * through to the next source.
 *
 * This module is Pi-independent and takes an injected reader, so it is fully
 * unit-testable.
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Documented maximum size of a resolved prompt, in bytes. Content beyond this
 * is truncated so a stray huge file cannot flood the model context. Matches the
 * documented Claude Code limit for `loop.md`.
 */
export const MAX_MAINTENANCE_PROMPT_BYTES = 25_000;

/**
 * The built-in maintenance prompt, used when neither `loop.md` exists. It keeps
 * a session healthy without starting unrelated work.
 */
export const BUILT_IN_MAINTENANCE_PROMPT = [
  "Run a maintenance pass for this session. Work through the following in order:",
  "1. Continue any unfinished work from the conversation.",
  "2. Tend to the current branch's pull request: address review comments, diagnose and fix failed CI runs, and resolve merge conflicts.",
  "3. If nothing else is pending, run a cleanup pass such as a bug hunt or a simplification.",
  "Do not start new initiatives outside this scope, and do not push, delete, or take other irreversible actions unless the conversation already authorizes them.",
].join("\n");

/** Which source supplied the resolved prompt. */
export type MaintenancePromptSource = "project" | "user" | "builtin";

/** A resolved maintenance prompt and where it came from. */
export interface ResolvedMaintenancePrompt {
  /** The prompt to deliver, already trimmed and size-bounded. */
  prompt: string;
  source: MaintenancePromptSource;
  /** The file that supplied the prompt; absent for the built-in prompt. */
  path?: string;
  /** True when the file content was longer than the byte cap and was cut. */
  truncated: boolean;
}

/** Thrown when a `loop.md` exists but cannot be used. */
export class MaintenancePromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenancePromptError";
  }
}

/** Injected reader so resolution is deterministic under test. */
export type MaintenanceReader = (filePath: string) => string;

/** The two `loop.md` locations, in precedence order. */
export interface MaintenancePaths {
  /** Project-level `.claude/loop.md`; takes precedence. */
  project: string;
  /** User-level `~/.claude/loop.md`. */
  user: string;
}

/** Options accepted by {@link resolveMaintenancePrompt}. */
export interface ResolveMaintenanceOptions {
  /** Directory whose `.claude/loop.md` is the project override. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Home directory whose `.claude/loop.md` is the user default. Defaults to `os.homedir()`. */
  homeDir?: string;
  /** Override the file reader (tests). Defaults to a synchronous `readFileSync`. */
  readFile?: MaintenanceReader;
  /** Override the built-in prompt (tests). */
  builtinPrompt?: string;
  /** Override the byte cap (tests). Defaults to {@link MAX_MAINTENANCE_PROMPT_BYTES}. */
  maxBytes?: number;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without leaving a broken
 * multibyte sequence at the end.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  const buffer = Buffer.from(text, "utf8").subarray(0, Math.max(0, maxBytes));
  let cut = buffer.toString("utf8");
  // `toString` replaces a split multibyte sequence with U+FFFD; drop that tail
  // so the truncated prompt does not end in a replacement character.
  if (cut.endsWith("\uFFFD")) {
    cut = cut.slice(0, -1);
  }
  return { text: cut, truncated: true };
}

/** Resolve the two `loop.md` paths for a project and home directory. */
export function maintenancePromptPaths(
  cwd: string = process.cwd(),
  homeDir: string = os.homedir(),
): MaintenancePaths {
  return {
    project: path.join(cwd, ".claude", "loop.md"),
    user: path.join(homeDir, ".claude", "loop.md"),
  };
}

/**
 * Resolve the maintenance prompt for one iteration.
 *
 * - A readable, non-empty `loop.md` is returned with its source and path, and is
 *   truncated to `maxBytes` (25,000 by default).
 * - A missing file is skipped.
 * - A file that exists but cannot be read, or is empty/whitespace-only, throws
 *   {@link MaintenancePromptError} rather than substituting another source.
 * - When neither file is present, the built-in prompt is returned.
 */
export function resolveMaintenancePrompt(options: ResolveMaintenanceOptions = {}): ResolvedMaintenancePrompt {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const readFile: MaintenanceReader = options.readFile ?? ((filePath) => readFileSync(filePath, "utf8"));
  const builtin = options.builtinPrompt ?? BUILT_IN_MAINTENANCE_PROMPT;
  const maxBytes = options.maxBytes ?? MAX_MAINTENANCE_PROMPT_BYTES;
  const paths = maintenancePromptPaths(cwd, homeDir);

  const sources: ReadonlyArray<readonly [MaintenancePromptSource, string]> = [
    ["project", paths.project],
    ["user", paths.user],
  ];

  for (const [source, filePath] of sources) {
    let contents: string;
    try {
      contents = readFile(filePath);
    } catch (error) {
      if (isMissing(error)) {
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new MaintenancePromptError(`could not read ${filePath}: ${reason}`);
    }
    const { text, truncated } = truncateUtf8(contents, maxBytes);
    const prompt = text.trim();
    if (!prompt) {
      throw new MaintenancePromptError(`${filePath} is empty`);
    }
    return { prompt, source, path: filePath, truncated };
  }

  return { prompt: builtin, source: "builtin", truncated: false };
}
