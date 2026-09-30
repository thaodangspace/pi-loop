import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_INTERVAL_MS,
  isLoopDisabled,
  loadDefaultInterval,
  LOOP_DISABLE_ENV,
  LoopConfigError,
  loopConfigPath,
} from "../src/config.ts";
import { configReader, missingFile } from "./helpers.ts";

test("a missing config file falls back to the 1min default", async () => {
  const resolved = await loadDefaultInterval({
    configPath: "/does/not/exist/loop.json",
    readFile: async () => {
      throw missingFile();
    },
  });
  assert.equal(resolved.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(resolved.fromFile, false);
});

test("a valid config supplies the default interval", async () => {
  const oneMin = await loadDefaultInterval({
    configPath: "/tmp/loop.json",
    readFile: async () => '{"defaultInterval":"1min"}',
  });
  assert.equal(oneMin.intervalMs, 60_000);
  assert.equal(oneMin.fromFile, true);

  const { readFile } = configReader('{"defaultInterval":"45s"}');
  const fortyFive = await loadDefaultInterval({ configPath: "/tmp/loop.json", readFile });
  assert.equal(fortyFive.intervalMs, 45_000);
});

test("an object without defaultInterval uses the built-in default", async () => {
  const resolved = await loadDefaultInterval({
    configPath: "/tmp/loop.json",
    readFile: async () => "{}",
  });
  assert.equal(resolved.intervalMs, DEFAULT_INTERVAL_MS);
  assert.equal(resolved.fromFile, false);
});

test("malformed, wrong-shape, and invalid configs are hard errors", async () => {
  await assert.rejects(
    () => loadDefaultInterval({ configPath: "/tmp/loop.json", readFile: async () => "{ not json" }),
    (error: unknown) => error instanceof LoopConfigError && /not valid JSON/.test(error.message),
  );
  await assert.rejects(
    () => loadDefaultInterval({ configPath: "/tmp/loop.json", readFile: async () => "[]" }),
    /must contain a JSON object/,
  );
  await assert.rejects(
    () => loadDefaultInterval({ configPath: "/tmp/loop.json", readFile: async () => '{"defaultInterval":60}' }),
    /must be a string/,
  );
  await assert.rejects(
    () => loadDefaultInterval({ configPath: "/tmp/loop.json", readFile: async () => '{"defaultInterval":"0s"}' }),
    /at least 1s|positive/,
  );
  await assert.rejects(
    () => loadDefaultInterval({ configPath: "/tmp/loop.json", readFile: async () => '{"defaultInterval":"soon"}' }),
    /invalid interval/,
  );
});

test("an unreadable config is reported rather than silently ignored", async () => {
  await assert.rejects(
    () =>
      loadDefaultInterval({
        configPath: "/tmp/loop.json",
        readFile: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      }),
    (error: unknown) => error instanceof LoopConfigError && /could not read/.test(error.message),
  );
});

test("config is read from the real filesystem path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-loop-config-"));
  try {
    const configPath = path.join(directory, "loop.json");
    await writeFile(configPath, '{"defaultInterval":"2h"}', "utf8");
    const resolved = await loadDefaultInterval({ configPath });
    assert.equal(resolved.intervalMs, 7_200_000);

    const absent = await loadDefaultInterval({ configPath: path.join(directory, "nope.json") });
    assert.equal(absent.intervalMs, DEFAULT_INTERVAL_MS);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the disable switch is opt-in and case-insensitive", () => {
  for (const value of ["1", "true", "TRUE", "yes", " on ", "On"]) {
    assert.equal(isLoopDisabled({ [LOOP_DISABLE_ENV]: value }), true, `expected "${value}" to disable`);
  }
  for (const value of ["0", "false", "no", "off", "", "   ", "enabled"]) {
    assert.equal(isLoopDisabled({ [LOOP_DISABLE_ENV]: value }), false, `expected "${value}" to stay enabled`);
  }
  assert.equal(isLoopDisabled({}), false, "an unset switch leaves scheduling enabled");
});

test("loopConfigPath honours PI_LOOP_CONFIG and PI_CODING_AGENT_DIR", () => {
  assert.equal(loopConfigPath({ PI_LOOP_CONFIG: "/custom/loop.json" }, "/home/me"), "/custom/loop.json");
  assert.equal(
    loopConfigPath({ PI_CODING_AGENT_DIR: "/agent" }, "/home/me"),
    path.join("/agent", "loop.json"),
  );
  assert.equal(loopConfigPath({}, "/home/me"), path.join("/home/me", ".pi", "agent", "loop.json"));
});
