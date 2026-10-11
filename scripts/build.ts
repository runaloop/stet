// `bun run build [-- --without <id,...>] [bun build options]`: the binary in dist/stet, with every module or without
// some. A build without some puts the default lists back afterwards, so the tree stays as committed.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withoutArg, writeLists } from "./modules.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const without = withoutArg(argv);
const rest = argv.filter((a, i) => !a.startsWith("--without") && argv[i - 1] !== "--without");

const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "ignore" }).stdout.toString().trim();
const { version } = await Bun.file(join(ROOT, "package.json")).json();
const commit = git(["rev-parse", "--short=12", "HEAD"]) || "nogit";
// Two builds of different uncommitted code share the commit, so a dirty build is told apart by when it was made.
// Read before the module lists are rewritten, or every build without a module would look dirty.
const dirty = git(["status", "--porcelain"]) ? `.dirty.${Date.now().toString(36)}` : "";
const build = `${version}+${commit}${without.map((id) => `.without-${id}`).join("")}${dirty}`;

rmSync(join(ROOT, "dist"), { recursive: true, force: true });
let code = 1;
try {
  await writeLists(without);
  const proc = Bun.spawn(
    ["bun", "build", "--compile", "--minify", "--splitting", "--define", `STET_BUILD=${JSON.stringify(build)}`, "src/cli.ts", "src/tui/diff/hl-worker.ts", "--outfile", "dist/stet", ...rest],
    { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] },
  );
  code = await proc.exited;
  if (code === 0) console.log(`build ${build}`);
} catch (e) {
  console.error((e as Error).message);
} finally {
  if (without.length) await writeLists([]);
}
process.exit(code);
