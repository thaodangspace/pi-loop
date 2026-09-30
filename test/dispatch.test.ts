/**
 * Tests for the unified scheduled-prompt dispatch layer.
 *
 * Two levels are covered:
 *
 * 1. Classification and dispatcher behavior, with realistic command lists.
 * 2. Integration through the loop extension, driven by a test double whose
 *    `sendUserMessage` reproduces the installed Pi dispatch semantics.
 *
 * A final suite cross-checks the policy against the *actual* installed Pi
 * package: the real `BUILTIN_SLASH_COMMANDS` list and the real
 * `expandPromptTemplate`, loaded from `node_modules`. That keeps the deny list
 * and the "expand vs literal" decision anchored to Pi rather than to our own
 * assumptions.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyScheduledPrompt,
  createScheduledPromptDispatcher,
  INTERACTIVE_SLASH_COMMANDS,
  ScheduledPromptRejectedError,
  type SlashCommandLike,
} from "../src/dispatch.ts";
import { createLoopExtension, type LoopExtensionDeps } from "../src/index.ts";
import { FakeCtx, FakePi, FakeTimers, missingFile, testRegistry } from "./helpers.ts";

const CMD = {
  loop: { name: "loop", source: "extension" } as SlashCommandLike,
  reviewTemplate: { name: "review", source: "prompt" } as SlashCommandLike,
  reviewSkill: { name: "skill:review", source: "skill" } as SlashCommandLike,
};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("plain text is literal and never expands", () => {
  const decision = classifyScheduledPrompt("check all tmux sessions", [CMD.reviewTemplate]);
  assert.deepEqual(decision, { action: "literal", text: "check all tmux sessions" });
});

test("an unknown slash command is literal text, not a rejection", () => {
  const decision = classifyScheduledPrompt("/etc/hosts is stale", [CMD.reviewTemplate]);
  assert.deepEqual(decision, { action: "literal", text: "/etc/hosts is stale" });
});

test("a known prompt template expands", () => {
  const decision = classifyScheduledPrompt("/review concurrency", [CMD.reviewTemplate, CMD.loop]);
  assert.equal(decision.action, "expand");
  if (decision.action === "expand") {
    assert.equal(decision.command.name, "review");
    assert.equal(decision.text, "/review concurrency", "the original text is preserved");
  }
});

test("a known skill expands", () => {
  const decision = classifyScheduledPrompt("/skill:review src", [CMD.reviewSkill, CMD.loop]);
  assert.equal(decision.action, "expand");
  if (decision.action === "expand") {
    assert.equal(decision.command.source, "skill");
  }
});

test("an extension command is rejected so Pi can never execute it", () => {
  for (const text of ["/loop stop", "/loop", "/loop every 5min ping"]) {
    const decision = classifyScheduledPrompt(text, [CMD.loop, CMD.reviewTemplate]);
    assert.equal(decision.action, "reject", text);
    if (decision.action === "reject") {
      assert.equal(decision.kind, "extension-command");
      assert.equal(decision.name, "loop");
      assert.match(decision.reason, /extension command/);
    }
  }
});

test("a built-in interactive command is rejected", () => {
  for (const text of ["/reload", "/quit", "/model opus", "/compact now"]) {
    const decision = classifyScheduledPrompt(text, [CMD.loop]);
    assert.equal(decision.action, "reject", text);
    if (decision.action === "reject") {
      assert.equal(decision.kind, "interactive-command");
      assert.match(decision.reason, /interactive Pi command/);
    }
  }
});

test("a control name wins over a same-named template or skill", () => {
  const shadowing: SlashCommandLike[] = [
    { name: "reload", source: "prompt" },
    { name: "skill:reload", source: "skill" },
  ];
  assert.equal(classifyScheduledPrompt("/reload", shadowing).action, "reject");
});

test("an unknown skill is rejected as unsupported", () => {
  const decision = classifyScheduledPrompt("/skill:missing do it", [CMD.reviewSkill]);
  assert.equal(decision.action, "reject");
  if (decision.action === "reject") {
    assert.equal(decision.kind, "unknown-skill");
    assert.equal(decision.name, "missing");
    assert.match(decision.reason, /does not name a loaded skill/);
  }
});

test("a single slash and a spaced slash are literal", () => {
  assert.equal(classifyScheduledPrompt("/", []).action, "literal");
  assert.equal(classifyScheduledPrompt("/ not a command", []).action, "literal");
  assert.equal(classifyScheduledPrompt("//comment", []).action, "literal");
});

test("the dispatcher sends literal text with expansion off and expands skills", () => {
  const sends: Array<{ text: string; expand: boolean }> = [];
  const dispatcher = createScheduledPromptDispatcher({
    commands: () => [CMD.reviewSkill, CMD.reviewTemplate],
    send: (text, options) => sends.push({ text, expand: options.expandPromptTemplates }),
  });

  dispatcher.dispatch("check things");
  dispatcher.dispatch("/etc/hosts is stale");
  dispatcher.dispatch("/review now");
  dispatcher.dispatch("/skill:review src");

  assert.deepEqual(sends, [
    { text: "check things", expand: false },
    { text: "/etc/hosts is stale", expand: false },
    { text: "/review now", expand: true },
    { text: "/skill:review src", expand: true },
  ]);
});

test("the dispatcher refuses to send a rejected form", () => {
  let sent = 0;
  const dispatcher = createScheduledPromptDispatcher({
    commands: () => [CMD.loop],
    send: () => {
      sent += 1;
    },
  });
  assert.throws(
    () => dispatcher.dispatch("/loop stop"),
    (error: unknown) => error instanceof ScheduledPromptRejectedError,
  );
  assert.equal(sent, 0, "a rejected prompt never reaches Pi");
});

// ---------------------------------------------------------------------------
// Extension integration (fixed, self-paced, and maintenance all route through)
// ---------------------------------------------------------------------------

function setup(overrides: Partial<LoopExtensionDeps> = {}) {
  const { maintenance, ...rest } = overrides;
  const timers = new FakeTimers();
  const pi = new FakePi();
  const ctx = new FakeCtx();
  const registry = overrides.registry ?? testRegistry(timers);
  createLoopExtension(pi.asExtensionApi(), {
    configPath: "/tmp/loop.json",
    timers,
    // Isolate tests from an ambient PI_LOOP_DISABLE; switch tests opt in.
    disabled: false,
    readFile: async () => {
      throw missingFile();
    },
    ...rest,
    maintenance: {
      cwd: "/tmp/pi-loop-project",
      homeDir: "/tmp/pi-loop-home",
      readFile: () => {
        throw missingFile();
      },
      ...maintenance,
    },
    registry,
  });
  return { timers, pi, ctx, registry };
}

test("a fixed loop expands a scheduled skill through Pi", async () => {
  const { timers, pi, ctx } = setup();
  pi.slashCommands.push(CMD.reviewSkill);
  pi.skills.set("review", "Review the diff carefully.");

  await pi.run("loop", "every 1min /skill:review src", ctx);
  assert.match(ctx.lastNotification()?.message ?? "", /every 1min: \/skill:review src/);

  timers.advance(60_000);
  assert.deepEqual(pi.executedCommands, [], "a skill must never execute a command");
  assert.deepEqual(pi.sent, ["<skill name=\"review\">\nReview the diff carefully.\n</skill>\n\nsrc"]);
  assert.deepEqual(pi.calls, [
    { text: "<skill name=\"review\">\nReview the diff carefully.\n</skill>\n\nsrc", expandPromptTemplates: true },
  ]);
});

test("a self-paced loop expands a scheduled prompt template through Pi", async () => {
  const { timers, pi, ctx } = setup();
  pi.slashCommands.push(CMD.reviewTemplate);
  pi.templates.set("review", "Review the staged changes.");

  await pi.run("loop", "/review", ctx);
  timers.advance(0);

  assert.deepEqual(pi.executedCommands, []);
  assert.deepEqual(pi.sent, ["Review the staged changes."]);
  assert.equal(pi.calls[0]?.expandPromptTemplates, true);
});

test("a scheduled control command is rejected at start and starts no loop", async () => {
  const { timers, pi, ctx, registry } = setup();

  await pi.run("loop", "every 1min /reload", ctx);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /Scheduled prompt rejected/);
  assert.match(ctx.lastNotification()?.message ?? "", /interactive Pi command/);
  assert.equal(registry.size, 0, "the rejected command must not create a loop");

  timers.advance(10 * 60_000);
  assert.deepEqual(pi.sent, []);
  assert.deepEqual(pi.executedCommands, []);
});

test("scheduling the loop's own command is rejected, not run", async () => {
  const { pi, ctx, registry } = setup();

  await pi.run("loop", "/loop stop", ctx);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /extension command/);
  assert.equal(registry.size, 0);
  assert.deepEqual(pi.executedCommands, []);
});

test("an unknown skill is reported and starts no loop", async () => {
  const { pi, ctx, registry } = setup();

  await pi.run("loop", "/skill:nope do it", ctx);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /does not name a loaded skill/);
  assert.equal(registry.size, 0);
});

test("literal slash text is delivered exactly with expansion off", async () => {
  const { timers, pi, ctx } = setup();

  await pi.run("loop", "every 1min /etc/hosts is stale", ctx);
  timers.advance(60_000);

  assert.deepEqual(pi.sent, ["/etc/hosts is stale"]);
  assert.deepEqual(pi.calls, [{ text: "/etc/hosts is stale", expandPromptTemplates: false }]);
});

test("plain text is delivered exactly, including internal whitespace", async () => {
  const { timers, pi } = setup();

  await pi.run("loop", "check   hosts\nand report", new FakeCtx());
  timers.advance(0);

  assert.deepEqual(pi.sent, ["check   hosts\nand report"]);
  assert.equal(pi.calls[0]?.expandPromptTemplates, false, "ordinary text is never expanded");
});

test("a maintenance prompt is classified on every run and a control form is rejected", async () => {
  let contents = "/reload";
  const readFile = (filePath: string): string => {
    if (filePath === "/proj/.claude/loop.md") {
      return contents;
    }
    throw missingFile();
  };
  const { timers, pi, ctx, registry } = setup({
    maintenance: { cwd: "/proj", homeDir: "/home/me", readFile },
  });

  await pi.run("loop", "1min", ctx);
  timers.advance(60_000);
  assert.equal(ctx.lastNotification()?.type, "error");
  assert.match(ctx.lastNotification()?.message ?? "", /Scheduled prompt rejected/);
  assert.deepEqual(pi.sent, [], "a rejected maintenance prompt is not delivered");
  assert.equal(registry.size, 1, "the fixed loop survives and retries at the next boundary");

  contents = "plain maintenance pass";
  timers.advance(60_000);
  assert.deepEqual(pi.sent, ["plain maintenance pass"]);
  assert.equal(pi.calls.at(-1)?.expandPromptTemplates, false);
});

test("a maintenance prompt naming a skill expands on the run", async () => {
  const readFile = (filePath: string): string => {
    if (filePath === "/proj/.claude/loop.md") {
      return "/skill:review src";
    }
    throw missingFile();
  };
  const { timers, pi } = setup({ maintenance: { cwd: "/proj", homeDir: "/home/me", readFile } });
  pi.slashCommands.push(CMD.reviewSkill);
  pi.skills.set("review", "Review carefully.");

  await pi.run("loop", "1min", new FakeCtx());
  timers.advance(60_000);

  assert.deepEqual(pi.sent, ["<skill name=\"review\">\nReview carefully.\n</skill>\n\nsrc"]);
  assert.equal(pi.executedCommands.length, 0);
});

// ---------------------------------------------------------------------------
// Cross-check against the actual installed Pi package
// ---------------------------------------------------------------------------

const PI_DIST = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/", import.meta.url);

async function loadInstalledPi(): Promise<{
  expandPromptTemplate: (text: string, templates: Array<{ name: string; content: string }>) => string;
  builtinNames: string[];
}> {
  const templates = (await import(new URL("core/prompt-templates.js", PI_DIST).href)) as {
    expandPromptTemplate: (text: string, templates: Array<{ name: string; content: string }>) => string;
  };
  const slash = (await import(new URL("core/slash-commands.js", PI_DIST).href)) as {
    BUILTIN_SLASH_COMMANDS: ReadonlyArray<{ name: string }>;
  };
  return {
    expandPromptTemplate: templates.expandPromptTemplate,
    builtinNames: slash.BUILTIN_SLASH_COMMANDS.map((command) => command.name),
  };
}

test("the interactive deny list matches Pi's real built-in commands", async () => {
  const { builtinNames } = await loadInstalledPi();
  assert.deepEqual(
    [...INTERACTIVE_SLASH_COMMANDS].sort(),
    [...builtinNames].sort(),
    "update INTERACTIVE_SLASH_COMMANDS when Pi adds or removes a built-in command",
  );
});

test("expansion decisions agree with Pi's real expandPromptTemplate", async () => {
  const { expandPromptTemplate } = await loadInstalledPi();
  const templates = [{ name: "review", content: "Review ${1:-files}" }];
  const commands: SlashCommandLike[] = [{ name: "review", source: "prompt" }];

  const expandDecision = classifyScheduledPrompt("/review src", commands);
  assert.equal(expandDecision.action, "expand");
  assert.equal(expandPromptTemplate("/review src", templates), "Review src");

  // Forms we send literally must be untouched by Pi's expander, so sending with
  // expansion off is byte-for-byte identical to Pi's own literal path.
  for (const text of ["/etc/hosts is stale", "check things", "/unknown thing"]) {
    assert.equal(classifyScheduledPrompt(text, commands).action, "literal", text);
    assert.equal(expandPromptTemplate(text, templates), text, text);
  }
});
