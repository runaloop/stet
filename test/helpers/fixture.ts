import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

for (const [k, v] of Object.entries(GIT_ENV)) process.env[k] = v;

export function sh(cwd: string, args: string[], input?: string): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

export class Fixture {
  readonly root: string;
  private readonly extra: string[] = [];

  constructor(prefix = "stet-fixture-") {
    this.root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    sh(this.root, ["init", "-q", "-b", "main"]);
  }

  path(rel: string): string {
    return join(this.root, rel);
  }

  write(rel: string, content: string, cwd = this.root): this {
    const p = join(cwd, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return this;
  }

  rm(rel: string, cwd = this.root): this {
    rmSync(join(cwd, rel), { force: true, recursive: true });
    return this;
  }

  git(args: string[], cwd = this.root): string {
    return sh(cwd, args);
  }

  commit(message: string, cwd = this.root): string {
    sh(cwd, ["add", "-A"]);
    sh(cwd, ["commit", "-q", "--allow-empty", "-m", message]);
    return sh(cwd, ["rev-parse", "HEAD"]);
  }

  addWorktree(rel: string, branch: string): string {
    const p = join(this.root, "..", `${this.root.split("/").pop()}-${rel}`);
    sh(this.root, ["worktree", "add", "-q", "-b", branch, p]);
    this.extra.push(p);
    return realpathSync(p);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
    for (const p of this.extra) rmSync(p, { recursive: true, force: true });
  }
}

export function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

export function edit(text: string, fn: (lines: string[]) => void): string {
  const ls = text.split("\n");
  const trailing = ls[ls.length - 1] === "";
  if (trailing) ls.pop();
  fn(ls);
  return ls.join("\n") + (trailing ? "\n" : "");
}
