// Writes the import lists of the modules a build has: src/modules.gen.ts (core parts) and web/modules.gen.ts (web
// parts). The committed lists have every module in modules/; `--without <id,...>` leaves some out.
//   bun scripts/modules.ts [--without <id,...>]   write the lists
//   bun scripts/modules.ts --check                fail unless the lists on disk are the default ones
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleSpec } from "../src/core/module.ts";

const ROOT = join(import.meta.dir, "..");
const CORE_LIST = join(ROOT, "src/modules.gen.ts");
const WEB_LIST = join(ROOT, "web/modules.gen.ts");
const HEAD = "// Written by scripts/modules.ts: the modules of this build. `bun run build -- --without <id>` builds without one.\n";

/** The modules in modules/: a folder with a core part, and a web part when it has one. */
export function available(): { id: string; web: boolean }[] {
  const dir = join(ROOT, "modules");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "core.ts")))
    .map((e) => ({ id: e.name, web: existsSync(join(dir, e.name, "web.tsx")) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const name = (id: string) => id.replace(/[^a-zA-Z0-9]+(.)/g, (_, c: string) => c.toUpperCase());

function list(type: string, from: string, parts: { id: string; file: string }[], exported: string): string {
  const imports = parts.map((p) => `import ${name(p.id)} from "${p.file}";\n`).join("");
  return `${HEAD}import type { ${type} } from "${from}";\n${imports}\nexport const ${exported}: ${type}[] = [${parts.map((p) => name(p.id)).join(", ")}];\n`;
}

/** The two lists for a build of every module but `without`; refuses an unknown id or a module another one needs. */
export async function lists(without: string[]): Promise<{ core: string; web: string }> {
  const all = available();
  const ids = new Set(all.map((m) => m.id));
  for (const id of without) if (!ids.has(id)) throw new Error(`no module '${id}' in modules/; there are: ${[...ids].join(", ") || "none"}`);
  const kept = all.filter((m) => !without.includes(m.id));
  for (const m of all) {
    const spec = ((await import(join(ROOT, "modules", m.id, "core.ts"))) as { default: ModuleSpec }).default;
    if (spec.id !== m.id) throw new Error(`modules/${m.id}/core.ts declares the id '${spec.id}'`);
    for (const other of [...(spec.needs ?? []), ...(spec.uses ?? [])]) {
      if (!ids.has(other)) throw new Error(`${m.id} names a module '${other}' that is not in modules/`);
    }
    const missing = without.find((id) => spec.needs?.includes(id));
    if (missing && kept.includes(m)) throw new Error(`${m.id} needs ${missing}: leave both out, or neither`);
  }
  return {
    core: list("ModuleSpec", "./core/module.ts", kept.map((m) => ({ id: m.id, file: `../modules/${m.id}/core.ts` })), "MODULES"),
    web: list("WebModule", "./modules.tsx", kept.filter((m) => m.web).map((m) => ({ id: m.id, file: `../modules/${m.id}/web.tsx` })), "WEB_MODULES"),
  };
}

export async function writeLists(without: string[]): Promise<void> {
  const l = await lists(without);
  writeFileSync(CORE_LIST, l.core);
  writeFileSync(WEB_LIST, l.web);
}

/** `--without a,b --without=c` → [a, b, c]. */
export function withoutArg(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--without") out.push(...(argv[++i] ?? "").split(","));
    else if (a.startsWith("--without=")) out.push(...a.slice("--without=".length).split(","));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  try {
    if (argv.includes("--check")) {
      const l = await lists([]);
      const stale = [[CORE_LIST, l.core], [WEB_LIST, l.web]].filter(([file, text]) => !existsSync(file!) || readFileSync(file!, "utf8") !== text);
      if (stale.length) {
        console.error(`not the lists of a build with every module: ${stale.map(([f]) => f!.slice(ROOT.length + 1)).join(", ")}; run bun scripts/modules.ts`);
        process.exit(1);
      }
    } else {
      await writeLists(withoutArg(argv));
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
