import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

test("thousands of changed files are all listed, with no cap", async () => {
  for (let d = 0; d < 30; d++) {
    mkdirSync(join(f.root, `m${d}`), { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(join(f.root, `m${d}`, `f${i}.kt`), `class F${d}_${i}\n`);
  }
  f.commit("base");
  f.git(["checkout", "-q", "-b", "feat"]);
  for (let d = 0; d < 30; d++) for (let i = 0; i < 100; i++) writeFileSync(join(f.root, `m${d}`, `f${i}.kt`), `class F${d}_${i} { val x = 1 }\n`);
  mkdirSync(join(f.root, "added"));
  for (let i = 0; i < 500; i++) writeFileSync(join(f.root, "added", `n${i}.kt`), `class N${i}\n`);
  const started = Date.now();
  await ok(stet(["version", "create"], { cwd: f.root }));
  await ok(stet(["comment", "add", "--file", "m29/f99.kt", "--range", "1", "--at", "1", "--body", "last file"], { cwd: f.root, role: "reviewer" }));
  const d = await ok(stet(["versions", "diff", "base", "1"], { cwd: f.root }));
  expect(d.files).toHaveLength(3500);
  expect(d.placements.map((p: any) => p.path)).toEqual(["m29/f99.kt"]);
  expect(Date.now() - started).toBeLessThan(process.env.CI ? 45_000 : 20_000);
}, 60_000);
