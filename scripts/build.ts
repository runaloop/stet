// `bun run build [-- --without <id,...>] [bun build options]`: the binary in dist/stet, with every module or without
// some. A build without some puts the default lists back afterwards, so the tree stays as committed.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { withoutArg, writeLists } from "./modules.ts";

const ROOT = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const without = withoutArg(argv);
const rest = argv.filter((a, i) => !a.startsWith("--without") && argv[i - 1] !== "--without");

rmSync(join(ROOT, "dist"), { recursive: true, force: true });
let code = 1;
try {
  await writeLists(without);
  const build = Bun.spawn(["bun", "build", "--compile", "--minify", "--splitting", "src/cli.ts", "--outfile", "dist/stet", ...rest], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
  code = await build.exited;
  if (code === 0 && without.length) console.log(`built without ${without.join(", ")}`);
} catch (e) {
  console.error((e as Error).message);
} finally {
  if (without.length) await writeLists([]);
}
process.exit(code);
