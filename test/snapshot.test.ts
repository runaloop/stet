import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openContext } from "../src/core/context.ts";
import { clearNowCache, takeWorktreeSnapshot } from "../src/core/snapshot.ts";
import { Fixture, sh } from "./helpers/fixture.ts";

const fixtures: Fixture[] = [];
afterAll(() => fixtures.forEach((f) => f.cleanup()));

function repo(): Fixture {
  const f = new Fixture();
  fixtures.push(f);
  f.write("tracked.txt", "one\n").write(".gitignore", "ignored.log\n").write("keep/deleted.txt", "bye\n");
  f.commit("init");
  return f;
}

function tree(f: Fixture, sha: string): string[] {
  return sh(f.root, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
}

describe("worktree snapshots", () => {
  test("captures tracked edits, untracked and deletions without touching the index or status", async () => {
    const f = repo();
    f.write("tracked.txt", "one\ntwo\n").write("new/untracked.txt", "fresh\n").write("ignored.log", "noise\n").rm("keep/deleted.txt");
    f.write("staged.txt", "staged\n");
    sh(f.root, ["add", "staged.txt"]);
    const indexPath = join(f.root, ".git", "index");
    const beforeStatus = sh(f.root, ["status", "--porcelain"]);
    const before = { bytes: readFileSync(indexPath), mtime: statSync(indexPath).mtimeMs, status: beforeStatus };
    const ctx = await openContext({ cwd: f.root });
    const snap = await takeWorktreeSnapshot(ctx, f.root, { keep: true });
    const files = tree(f, snap.sha);
    expect(files).toContain("new/untracked.txt");
    expect(files).toContain("staged.txt");
    expect(files).not.toContain("ignored.log");
    expect(files).not.toContain("keep/deleted.txt");
    expect(sh(f.root, ["show", `${snap.sha}:tracked.txt`])).toBe("one\ntwo");
    expect(readFileSync(indexPath).equals(before.bytes)).toBe(true);
    expect(statSync(indexPath).mtimeMs).toBe(before.mtime);
    expect(sh(f.root, ["-c", "core.fsmonitor=false", "status", "--porcelain"])).toBe(before.status);
    expect(sh(f.root, ["rev-parse", `refs/stet/snap/${snap.sha}`])).toBe(snap.sha);
    expect(sh(f.root, ["cat-file", "-p", snap.sha])).toContain("author stet <stet@localhost>");
  });

  test("dedupes identical trees and skips large untracked files", async () => {
    const f = repo();
    f.write("big.bin", "x".repeat(4096));
    const ctx = await openContext({ cwd: f.root });
    ctx.store.setMeta("snapshot.max_untracked_bytes", "1000");
    const a = await takeWorktreeSnapshot(ctx, f.root, { keep: false });
    const b = await takeWorktreeSnapshot(ctx, f.root, { keep: false });
    expect(b.sha).toBe(a.sha);
    expect(b.reused).toBe(true);
    expect(a.excluded).toEqual(["big.bin"]);
    expect(tree(f, a.sha)).not.toContain("big.bin");
    expect(sh(f.root, ["for-each-ref", "refs/stet/snap/"])).toBe("");
  });

  test("honours exclude globs and never embeds nested worktrees", async () => {
    const f = repo();
    const nested = join(f.root, "wt", "nested");
    sh(f.root, ["worktree", "add", "-q", "-b", "nested", nested]);
    f.write("secret/key.pem", "KEY\n").write("ok.txt", "fine\n");
    const ctx = await openContext({ cwd: f.root });
    ctx.store.setMeta("snapshot.exclude", JSON.stringify(["secret/**"]));
    const snap = await takeWorktreeSnapshot(ctx, f.root, { keep: false });
    const files = tree(f, snap.sha);
    expect(files).toContain("ok.txt");
    expect(files.some((p) => p.startsWith("secret/"))).toBe(false);
    expect(files.some((p) => p.startsWith("wt/"))).toBe(false);
    expect(snap.excluded).toContain("wt/nested");
  });

  test("works from a linked worktree and keeps symlinks", async () => {
    const f = repo();
    const wt = f.addWorktree("linked", "feature");
    f.write("linked.txt", "from linked\n", wt);
    symlinkSync("tracked.txt", join(wt, "link.txt"));
    clearNowCache();
    const ctx = await openContext({ cwd: wt });
    const snap = await takeWorktreeSnapshot(ctx, wt, { keep: true });
    expect(tree(f, snap.sha)).toContain("linked.txt");
    expect(sh(f.root, ["ls-tree", snap.sha, "link.txt"])).toStartWith("120000");
    expect(ctx.repo.commonDir).toBe(join(f.root, ".git"));
  });

  test("sees same-size edits made in the same second the index was written", async () => {
    const f = repo();
    for (let i = 0; i < 1000; i++) f.write(`many/f${i}.txt`, "aaaa\n");
    f.commit("more");
    f.git(["checkout", "-q", "-b", "edits"]);
    for (let i = 0; i < 1000; i++) f.write(`many/f${i}.txt`, "bbbb\n");
    await Bun.sleep(2100);
    const ctx = await openContext({ cwd: f.root });
    const snap = await takeWorktreeSnapshot(ctx, f.root, { keep: false });
    const changed = sh(f.root, ["diff-tree", "-r", "--name-only", "HEAD", snap.sha]).split("\n").filter(Boolean);
    expect(changed).toHaveLength(1000);
  });
});
