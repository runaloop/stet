import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import skillText from "../../skill/SKILL.md" with { type: "text" };
import { usage } from "./context.ts";

export const SKILL_TEXT: string = skillText;

export type SkillTarget = "agents" | "claude";

/** Where harnesses look for user skills. Claude Code reads only its own folder; the rest share ~/.agents/skills. */
export const SKILL_ROOTS: Record<SkillTarget, { dir: string[]; harnesses: string[] }> = {
  agents: { dir: [".agents", "skills"], harnesses: ["Codex", "Gemini CLI", "Cursor", "OpenCode", "Copilot"] },
  claude: { dir: [".claude", "skills"], harnesses: ["Claude Code"] },
};

export interface InstalledSkill {
  path: string;
  harnesses: string[];
}

export interface InstallOptions {
  /** One folder of skills in place of the harnesses' own. */
  dir?: string;
  for?: string;
  home?: string;
}

/** `for` unset: ~/.agents/skills, and ~/.claude/skills too when Claude Code is there. */
export function skillTargets(opts: InstallOptions = {}): { dir: string; harnesses: string[] }[] {
  const home = opts.home ?? homedir();
  if (opts.dir) {
    if (opts.for) throw usage("--dir and --for do not go together");
    return [{ dir: opts.dir, harnesses: [] }];
  }
  const pick = opts.for ?? "auto";
  const targets: SkillTarget[] =
    pick === "all" ? ["agents", "claude"]
    : pick === "agents" || pick === "claude" ? [pick]
    : pick === "auto" ? ["agents", ...(existsSync(join(home, ".claude")) ? ["claude" as const] : [])]
    : [];
  if (!targets.length) throw usage("--for must be agents, claude or all");
  return targets.map((t) => ({ dir: join(home, ...SKILL_ROOTS[t].dir), harnesses: SKILL_ROOTS[t].harnesses }));
}

export function installSkill(opts: InstallOptions = {}): InstalledSkill[] {
  return skillTargets(opts).map(({ dir, harnesses }) => {
    const target = join(dir, "stet-review");
    mkdirSync(target, { recursive: true });
    const path = join(target, "SKILL.md");
    writeFileSync(path, SKILL_TEXT);
    return { path, harnesses };
  });
}
