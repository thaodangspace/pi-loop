import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { LoopScheduler } from "../src/loop-core.ts";
import {
  BUILT_IN_MAINTENANCE_PROMPT,
  MaintenancePromptError,
  MAX_MAINTENANCE_PROMPT_BYTES,
  maintenancePromptPaths,
  resolveMaintenancePrompt,
  truncateUtf8,
} from "../src/maintenance.ts";
import { FakeTimers, maintenanceReader, missingFile, testRegistry } from "./helpers.ts";

test("the two loop.md paths follow the project-then-user precedence", () => {
  assert.deepEqual(maintenancePromptPaths("/work/proj", "/home/me"), {
    project: path.join("/work/proj", ".claude", "loop.md"),
    user: path.join("/home/me", ".claude", "loop.md"),
  });
});

test("a missing file in both locations falls back to the built-in prompt", () => {
  const files = maintenanceReader({});
  const resolved = resolveMaintenancePrompt({
    cwd: "/proj",
    homeDir: "/home/me",
    readFile: files.readFile,
  });
  assert.equal(resolved.prompt, BUILT_IN_MAINTENANCE_PROMPT);
  assert.equal(resolved.source, "builtin");
  assert.equal(resolved.path, undefined);
  assert.equal(resolved.truncated, false);
  assert.deepEqual(files.reads, ["/proj/.claude/loop.md", "/home/me/.claude/loop.md"]);
});

test("the project file wins and stops resolution before the user file is read", () => {
  const files = maintenanceReader({
    "/proj/.claude/loop.md": "project instructions",
    "/home/me/.claude/loop.md": "user instructions",
  });
  const resolved = resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile: files.readFile });
  assert.equal(resolved.prompt, "project instructions");
  assert.equal(resolved.source, "project");
  assert.equal(resolved.path, "/proj/.claude/loop.md");
  assert.deepEqual(files.reads, ["/proj/.claude/loop.md"]);
});

test("the user file applies when the project has none", () => {
  const files = maintenanceReader({ "/home/me/.claude/loop.md": "user instructions" });
  const resolved = resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile: files.readFile });
  assert.equal(resolved.prompt, "user instructions");
  assert.equal(resolved.source, "user");
  assert.equal(resolved.path, "/home/me/.claude/loop.md");
});

test("an unreadable file is a hard error, not a quiet substitution", () => {
  const readFile = (filePath: string): string => {
    if (filePath === "/proj/.claude/loop.md") {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
    return "user instructions";
  };
  assert.throws(
    () => resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile }),
    (error: unknown) =>
      error instanceof MaintenancePromptError &&
      /could not read \/proj\/\.claude\/loop\.md: permission denied/.test(error.message),
  );
});

test("an unreadable user file surfaces when no project file exists", () => {
  const readFile = (filePath: string): string => {
    if (filePath === "/home/me/.claude/loop.md") {
      throw Object.assign(new Error("is a directory"), { code: "EISDIR" });
    }
    throw missingFile();
  };
  assert.throws(
    () => resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile }),
    (error: unknown) =>
      error instanceof MaintenancePromptError && /could not read \/home\/me\/\.claude\/loop\.md/.test(error.message),
  );
});

test("an empty or whitespace-only file is reported rather than ignored", () => {
  for (const contents of ["", "   \n\t"]) {
    const files = maintenanceReader({ "/proj/.claude/loop.md": contents });
    assert.throws(
      () => resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile: files.readFile }),
      (error: unknown) =>
        error instanceof MaintenancePromptError && /\/proj\/\.claude\/loop\.md is empty/.test(error.message),
    );
  }
});

test("content longer than the byte cap is truncated", () => {
  const oversized = "a".repeat(MAX_MAINTENANCE_PROMPT_BYTES + 500);
  const files = maintenanceReader({ "/proj/.claude/loop.md": oversized });
  const resolved = resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile: files.readFile });
  assert.equal(resolved.truncated, true);
  assert.equal(resolved.prompt.length, MAX_MAINTENANCE_PROMPT_BYTES);
  assert.equal(Buffer.byteLength(resolved.prompt, "utf8"), MAX_MAINTENANCE_PROMPT_BYTES);
});

test("content within the cap is untouched", () => {
  const exact = "b".repeat(MAX_MAINTENANCE_PROMPT_BYTES);
  const files = maintenanceReader({ "/proj/.claude/loop.md": exact });
  const resolved = resolveMaintenancePrompt({ cwd: "/proj", homeDir: "/home/me", readFile: files.readFile });
  assert.equal(resolved.truncated, false);
  assert.equal(resolved.prompt, exact);
});

test("truncation is measured in bytes and never splits a multibyte character", () => {
  // Each "é" is two bytes, so a 3-byte cap can hold exactly one of them.
  assert.deepEqual(truncateUtf8("ééé", 3), { text: "é", truncated: true });
  assert.deepEqual(truncateUtf8("abc", 3), { text: "abc", truncated: false });
  assert.equal(truncateUtf8("é", 1).text, "", "an incomplete sequence is dropped, not replaced");
});

test("a custom built-in prompt and byte cap can be injected", () => {
  const files = maintenanceReader({});
  const resolved = resolveMaintenancePrompt({
    cwd: "/proj",
    homeDir: "/home/me",
    readFile: files.readFile,
    builtinPrompt: "custom builtin",
    maxBytes: 4,
  });
  assert.equal(resolved.prompt, "custom builtin");

  const project = maintenanceReader({ "/proj/.claude/loop.md": "abcdef" });
  const capped = resolveMaintenancePrompt({
    cwd: "/proj",
    homeDir: "/home/me",
    readFile: project.readFile,
    maxBytes: 4,
  });
  assert.deepEqual(capped, {
    prompt: "abcd",
    source: "project",
    path: "/proj/.claude/loop.md",
    truncated: true,
  });
});

test("the scheduler resolves the prompt afresh on every fixed run", () => {
  const timers = new FakeTimers();
  const dispatched: string[] = [];
  let runs = 0;
  const scheduler = new LoopScheduler(
    timers,
    testRegistry(timers),
    (_task, prompt) => {
      dispatched.push(prompt);
    },
    () => true,
    undefined,
    () => `resolved-${(runs += 1)}`,
  );

  scheduler.start(60_000, "stored prompt", { maintenance: true });
  timers.advance(60_000);
  timers.advance(60_000);
  assert.deepEqual(dispatched, ["resolved-1", "resolved-2"]);
});

test("a fixed run with a failing resolver is skipped, reported, and retried next boundary", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (_task, prompt) => {
      dispatched.push(prompt);
    },
    () => true,
    (error) => errors.push(error),
    () => {
      if (fail) throw new Error("no prompt");
      return "ok";
    },
  );

  scheduler.start(60_000, "stored prompt", { maintenance: true });
  timers.advance(60_000);
  assert.equal(errors.length, 1);
  assert.deepEqual(dispatched, []);
  assert.equal(registry.list()[0]?.pending, false, "a skipped run is not retained as pending");
  assert.equal(timers.pendingCount, 1, "the schedule stays armed");

  fail = false;
  timers.advance(60_000);
  assert.deepEqual(dispatched, ["ok"], "the next boundary retries with the resolved prompt");
});

test("a self-paced run with a failing resolver falls back instead of stalling", () => {
  const timers = new FakeTimers();
  const registry = testRegistry(timers);
  const dispatched: string[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const scheduler = new LoopScheduler(
    timers,
    registry,
    (_task, prompt) => {
      dispatched.push(prompt);
    },
    () => true,
    (error) => errors.push(error),
    () => {
      if (fail) throw new Error("no prompt");
      return "ok";
    },
  );

  scheduler.startSelfPaced("stored prompt", { maintenance: true, fallbackDelayMs: 60_000 });
  timers.advance(0);
  assert.equal(errors.length, 1);
  assert.deepEqual(dispatched, []);
  assert.equal(scheduler.status().fallbackUsed, true, "the bounded fallback was applied");
  assert.equal(registry.list()[0]?.pending, false);
  assert.equal(timers.pendingCount, 1, "a fallback wakeup is armed");

  fail = false;
  timers.advance(60_000);
  assert.deepEqual(dispatched, ["ok"]);
});
