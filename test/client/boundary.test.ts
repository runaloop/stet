import { describe, expect, test } from "bun:test";
import { dirname, join, relative, resolve } from "node:path";

// src/client runs in Bun under a terminal UI: it may not reach for the web's files or a package, and it loads the
// server module, which brings the page with it, only when it starts or stops a server.
const ROOT = join(import.meta.dir, "../..");
const CLIENT = join(ROOT, "src/client");
const files = [...new Bun.Glob("**/*.ts").scanSync(CLIENT)].map((f) => join(CLIENT, f));

describe("src/client", () => {
  test("imports only src/client, src/core and src/server", async () => {
    expect(files.length).toBeGreaterThan(2);
    const wrong: string[] = [];
    for (const file of files) {
      const source = await Bun.file(file).text();
      for (const m of source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g)) {
        const target = relative(ROOT, resolve(dirname(file), (m[1] ?? m[2])!));
        const ok = ["src/client/", "src/core/", "src/server/"].some((dir) => target.startsWith(dir));
        if (!ok || (m[1] !== undefined && target === "src/server/server.ts")) wrong.push(`${relative(ROOT, file)}: ${m[0]}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
