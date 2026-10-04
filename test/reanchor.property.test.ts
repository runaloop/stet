import { afterAll, expect, test } from "bun:test";
import { blobHunks } from "../src/core/diff.ts";
import { reanchor, sliceLines, specAt } from "../src/core/reanchor.ts";
import { Fixture, sh } from "./helpers/fixture.ts";

const f = new Fixture();
afterAll(() => f.cleanup());

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const VOCAB = ["foo();", "bar(x);", "}", "", "return y;", "if (a) {", "  x += 1;", "// note", "let z = 0;", "else {"];

function hashObject(text: string): string {
  return sh(f.root, ["hash-object", "-w", "--stdin"], text);
}

test("ok/moved always means identical text; edits inside never yield ok", async () => {
  const rand = rng(42);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  let checked = 0;
  for (let iter = 0; iter < 300; iter++) {
    const n = 20 + Math.floor(rand() * 40);
    const old = Array.from({ length: n }, () => (rand() < 0.5 ? pick(VOCAB) : `line ${Math.floor(rand() * 1000)}`));
    const s = 1 + Math.floor(rand() * (n - 1));
    const e = Math.min(n, s + Math.floor(rand() * 6));
    const next = [...old];
    let touchedContent = false;
    const edits = 1 + Math.floor(rand() * 4);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(rand() * next.length);
      const op = rand();
      if (op < 0.4) next.splice(at, 0, `ins ${iter}-${k}`);
      else if (op < 0.7 && next.length > 1) next.splice(at, 1);
      else next[at] = `mod ${iter}-${k}`;
    }
    const oldText = old.join("\n") + "\n";
    const newText = next.join("\n") + "\n";
    const hunks = await blobHunks(f.root, hashObject(oldText), hashObject(newText));
    const spec = specAt("f.txt", old, s, e);
    const p = reanchor(spec, { kind: "modified", newPath: "f.txt", oldLines: old, newLines: next, hunks });
    if (p.state === "ok" || p.state === "moved") {
      expect(sliceLines(next, p.start!, p.end!)).toEqual(spec.lines);
    }
    if (p.state === "ok") {
      touchedContent = !sliceLines(next, s, e).every((l, i) => l === spec.lines[i]);
      expect(touchedContent).toBe(false);
    }
    if (p.state === "changed") {
      expect(p.start!).toBeGreaterThanOrEqual(1);
      expect(p.end!).toBeLessThanOrEqual(Math.max(1, next.length));
    }
    checked++;
  }
  expect(checked).toBe(300);
}, 60_000);
