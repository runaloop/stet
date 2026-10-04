import { expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function listedInNotice(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    if (!/^[@a-z]/.test(line)) continue;
    for (const name of line.split(/\s{2,}/)[0]!.split(",")) {
      if (/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name.trim())) names.add(name.trim());
    }
  }
  return names;
}

test("NOTICE lists every package bundled into the binary", async () => {
  const build = await Bun.build({
    entrypoints: [join(ROOT, "src/cli.ts")],
    target: "bun",
    minify: true,
    splitting: true,
    metafile: true,
  });
  expect(build.success).toBe(true);
  const bundled = new Set<string>();
  for (const output of Object.values(build.metafile!.outputs)) {
    for (const [path, input] of Object.entries(output.inputs)) {
      const name = path.match(/.*node_modules\/((?:@[^/]+\/)?[^/]+)\//)?.[1];
      if (name && input.bytesInOutput > 0) bundled.add(name);
    }
  }
  expect(bundled.size).toBeGreaterThan(10);
  const listed = listedInNotice(await Bun.file(join(ROOT, "NOTICE")).text());
  expect([...bundled].filter((name) => !listed.has(name)).sort()).toEqual([]);
}, 60_000);
