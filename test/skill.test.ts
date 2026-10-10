/**
 * Packaging test for the bundled `loop-scheduler` skill.
 *
 * The issue that added the skill requires that an installed package exposes it
 * under `pi.skills` and that Pi's own loader finds it with the expected
 * metadata. We exercise the real loader from the installed
 * `@earendil-works/pi-coding-agent` package rather than re-parsing the
 * frontmatter by hand, so the assertions track Pi's discovery rules.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { loadSkillsFromDir, type Skill } from "@earendil-works/pi-coding-agent";

const repoRoot = path.join(import.meta.dirname, "..");
const skillDir = path.join(repoRoot, "skills", "loop-scheduler");

function loadLoopSchedulerSkill(): Skill {
  const { skills, diagnostics } = loadSkillsFromDir({
    dir: skillDir,
    source: "pi-loop",
  });
  assert.deepEqual(diagnostics, [], "the skill must load without diagnostics");
  assert.equal(skills.length, 1, "the skill directory holds exactly one skill");
  return skills[0]!;
}

test("package.json registers the skill directory under pi.skills", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
    keywords?: string[];
    pi?: { extensions?: string[]; skills?: string[] };
  };
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.deepEqual(manifest.pi?.skills, ["./skills/loop-scheduler"]);
  assert.ok(manifest.keywords?.includes("pi-package"));
});

test("Pi discovers loop-scheduler with valid metadata", () => {
  const skill = loadLoopSchedulerSkill();
  assert.equal(skill.name, "loop-scheduler");
  assert.equal(skill.disableModelInvocation, false);
  // The description is the routing surface, so it must say what and when.
  assert.ok(skill.description.length > 40, "description should be routing-oriented");
  assert.match(skill.description, /schedule/i);
  assert.match(skill.description, /loop/i);
  // Names use lowercase letters, numbers, and single hyphens per the spec.
  assert.match(skill.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  // The skill must resolve to the packaged SKILL.md in this directory.
  assert.equal(path.basename(skill.filePath), "SKILL.md");
  assert.equal(path.basename(skill.baseDir), "loop-scheduler");
});

test("the skill documents every model-callable scheduler tool", async () => {
  const content = await readFile(path.join(skillDir, "SKILL.md"), "utf8");
  for (const tool of [
    "schedule_task",
    "schedule_cron_task",
    "schedule_once_task",
    "schedule_self_paced_task",
    "list_scheduled_tasks",
    "delete_scheduled_task",
    "schedule_wakeup",
    "stop_wakeup",
  ]) {
    assert.ok(content.includes(tool), `skill must document ${tool}`);
  }
  // The lifecycle contract the issue calls out explicitly.
  assert.match(content, /1 minute.*1 hour|1 min.*1 h/i, "wakeup clamp must be documented");
  assert.match(content, /ephemeral|not persisted|do not survive/i, "non-persistence must be documented");
  assert.match(content, /one (bounded )?fallback|one\*\* fallback/i, "bounded fallback must be documented");
});
