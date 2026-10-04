import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSkill, SKILL_TEXT, skillTargets } from "../src/core/skill.ts";

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), "stet-home-"));
  homes.push(h);
  return h;
};
afterAll(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

const dirs = (opts: Parameters<typeof skillTargets>[0]) => skillTargets(opts).map((t) => t.dir);

test("the skill goes to ~/.agents/skills, and to ~/.claude/skills only when Claude Code is there", () => {
  const h = home();
  expect(dirs({ home: h })).toEqual([join(h, ".agents", "skills")]);
  mkdirSync(join(h, ".claude"));
  expect(dirs({ home: h })).toEqual([join(h, ".agents", "skills"), join(h, ".claude", "skills")]);
  expect(dirs({ home: h, for: "claude" })).toEqual([join(h, ".claude", "skills")]);
  expect(dirs({ home: home(), for: "all" })).toHaveLength(2);
  expect(() => skillTargets({ home: h, for: "codex" })).toThrow("--for must be");
  expect(() => skillTargets({ home: h, dir: "/x", for: "claude" })).toThrow("do not go together");
});

test("install writes the same SKILL.md into each folder", () => {
  const h = home();
  mkdirSync(join(h, ".claude"));
  const installed = installSkill({ home: h });
  expect(installed.map((s) => s.harnesses[0])).toEqual(["Codex", "Claude Code"]);
  for (const s of installed) expect(readFileSync(s.path, "utf8")).toBe(SKILL_TEXT);
});
