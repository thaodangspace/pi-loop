/**
 * Resolution of the optional user-level `loop.json` config that supplies the
 * default interval for `/loop <task>`.
 *
 * The file is read fresh on every implicit-interval command. A missing file is
 * the documented default (1min); an unreadable or malformed file is a hard
 * error so an implicit command never silently changes behavior.
 */
import { readFile as fsReadFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { IntervalError, parseInterval } from "./loop-core.ts";

/** Default interval used when no config file exists or it omits `defaultInterval`. */
export const DEFAULT_INTERVAL_MS = 60_000;

/** Error for a config file that exists but cannot be trusted. */
export class LoopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopConfigError";
  }
}

/** Injected file reader so config resolution is unit-testable. */
export type ConfigReader = (filePath: string) => Promise<string>;

export interface ResolveDefaultOptions {
  /** Absolute path to `loop.json`. */
  configPath: string;
  /** Override the file reader (used in tests). */
  readFile?: ConfigReader;
}

export interface ResolvedDefaultInterval {
  intervalMs: number;
  /** The path that was consulted. */
  configPath: string;
  /** True when the interval came from the file rather than the built-in default. */
  fromFile: boolean;
}

/**
 * Resolve the config path, honouring Pi's agent-dir override.
 *
 * Precedence: explicit `PI_LOOP_CONFIG`, then Pi's `PI_CODING_AGENT_DIR`, then
 * `~/.pi/agent/loop.json`.
 */
export function loopConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = os.homedir(),
): string {
  const override = env.PI_LOOP_CONFIG?.trim();
  if (override) {
    return override;
  }
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  const base = agentDir && agentDir.length > 0 ? agentDir : path.join(homeDir, ".pi", "agent");
  return path.join(base, "loop.json");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * Read and validate the default interval from `loop.json`.
 *
 * - Missing file: returns the 1min default.
 * - Read failure other than ENOENT, malformed JSON, wrong shape, or an invalid
 *   interval string: throws {@link LoopConfigError}.
 */
export async function loadDefaultInterval(options: ResolveDefaultOptions): Promise<ResolvedDefaultInterval> {
  const readFile: ConfigReader = options.readFile ?? ((filePath) => fsReadFile(filePath, "utf8"));

  let contents: string;
  try {
    contents = await readFile(options.configPath);
  } catch (error) {
    if (isMissing(error)) {
      return { intervalMs: DEFAULT_INTERVAL_MS, configPath: options.configPath, fromFile: false };
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new LoopConfigError(`could not read ${options.configPath}: ${reason}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new LoopConfigError(`${options.configPath} is not valid JSON`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LoopConfigError(`${options.configPath} must contain a JSON object`);
  }

  const value = (parsed as Record<string, unknown>).defaultInterval;
  if (value === undefined) {
    return { intervalMs: DEFAULT_INTERVAL_MS, configPath: options.configPath, fromFile: false };
  }
  if (typeof value !== "string") {
    throw new LoopConfigError(`${options.configPath}: "defaultInterval" must be a string such as "1min"`);
  }

  try {
    return { intervalMs: parseInterval(value), configPath: options.configPath, fromFile: true };
  } catch (error) {
    if (error instanceof IntervalError) {
      throw new LoopConfigError(`${options.configPath}: ${error.message}`);
    }
    throw error;
  }
}
