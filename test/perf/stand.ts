import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureReview, openContext } from "../../src/core/context.ts";
import { addReply, addThread, createVersion } from "../../src/core/service.ts";

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "perf", GIT_AUTHOR_EMAIL: "perf@example.com", GIT_COMMITTER_NAME: "perf", GIT_COMMITTER_EMAIL: "perf@example.com" },
  });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/**
 * The big review of the performance checks: `files` changed Kotlin files of 30 lines in folders of 100, plus Big.kt
 * with 5000 changed lines, one version and `threads` threads (half with a reply) and one deep in Big.kt.
 */
export async function stand(files: number, threads: number): Promise<string> {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "stet-perf-")));
  git(repo, "init", "-q", "-b", "main");
  const body = (d: number, i: number, v: string) => Array.from({ length: 30 }, (_, k) => `fun f${d}_${i}_${k}() = "${v}${k}"`).join("\n") + "\n";
  const dirs = Math.ceil(files / 100);
  const each = (fn: (d: number, i: number) => void) => {
    for (let n = 0; n < files; n++) fn(Math.floor(n / 100), n % 100);
  };
  for (let d = 0; d < dirs; d++) mkdirSync(join(repo, `mod${d}/src`), { recursive: true });
  each((d, i) => writeFileSync(join(repo, `mod${d}/src/F${i}.kt`), body(d, i, "a")));
  writeFileSync(join(repo, "Big.kt"), Array.from({ length: 5000 }, (_, k) => `val line${k} = ${k}`).join("\n") + "\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feat");
  each((d, i) => writeFileSync(join(repo, `mod${d}/src/F${i}.kt`), body(d, i, "b")));
  writeFileSync(join(repo, "Big.kt"), Array.from({ length: 5000 }, (_, k) => `val line${k} = ${k * 2}`).join("\n") + "\n");
  const reviewer = await openContext({ cwd: repo, role: "reviewer", author: "you" });
  const agent = await openContext({ cwd: repo, role: "agent", author: "claude" });
  const review = await ensureReview(agent);
  await createVersion(agent, review, { label: "perf" });
  for (let n = 0; n < threads; n++) {
    const t = await addThread(reviewer, review, { path: `mod${n % dirs}/src/F${n % 100}.kt`, start: 3, end: 5, at: "1", body: `thread ${n}` });
    if (n % 2 === 0) await addReply(agent, review, t.id, { body: `reply ${n}`, intent: "answered", at: "1" });
  }
  await addThread(reviewer, review, { path: "Big.kt", start: 4000, end: 4002, at: "1", body: "deep in a big file" });
  reviewer.store.close();
  agent.store.close();
  return repo;
}
