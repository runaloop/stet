import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const withUi = process.argv.includes("--ui");

const ACCEPTED_SEMGREP: { rule: string; path: string; why: string }[] = [
  { rule: "regex_dos", path: "web/lib/filters.ts", why: "globs become anchored [^/]* / (?:.*/)? patterns, typed by the reviewer into their own browser" },
  { rule: "regex_dos", path: "web/lib/fold.ts", why: "same glob patterns, from the reviewer's own config" },
  { rule: "regex_dos", path: "web/lib/order.ts", why: "compare.order globs through the same globToRegExp as compare.tests" },
  { rule: "regex_dos", path: "web/lib/versions.ts", why: "/^\\d+$/ on a version ref: linear, no nested quantifiers" },
  { rule: "regex_dos", path: "web/lib/search.ts", why: "the reviewer's own search in their own browser; the flagged line is /[A-Z]/" },
  { rule: "node_insecure_random_generator", path: "scripts/guide/lib.ts", why: "picks a debugging port for a local headless Firefox that takes the guide screenshots; not a secret" },
  { rule: "node_timing_attack", path: "web/state.ts", why: "compares location.hash, not a secret" },
];

type Outcome = "ok" | "fail" | "skipped";
const results: [string, Outcome, string][] = [];

async function run(cmd: string[], opts: { quiet?: boolean; env?: Record<string, string> } = {}): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...opts.env } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (!opts.quiet && code !== 0) process.stderr.write(out + err);
  return { code, out };
}

async function step(name: string, fn: () => Promise<[Outcome, string]>): Promise<void> {
  const t = performance.now();
  const [outcome, note] = await fn();
  results.push([name, outcome, `${note}${note ? " · " : ""}${((performance.now() - t) / 1000).toFixed(1)}s`]);
}

await step("typecheck", async () => [(await run(["bun", "run", "typecheck"])).code === 0 ? "ok" : "fail", ""]);

await step("unit and e2e tests", async () => [(await run(["bun", "test"])).code === 0 ? "ok" : "fail", ""]);

await step("bun audit", async () => {
  const r = await run(["bun", "audit"]);
  return [r.code === 0 ? "ok" : "fail", r.out.match(/checked \d+ packages/)?.[0] ?? ""];
});

await step("exact dependency versions", async () => {
  const pkg = await Bun.file(join(ROOT, "package.json")).json();
  const loose = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, v]) => !/^\d+\.\d+\.\d+$/.test(String(v)));
  return [loose.length ? "fail" : "ok", loose.map(([k, v]) => `${k}@${v}`).join(", ")];
});

await step("semgrep (typescript, nodejsscan, secrets)", async () => {
  const cmd = Bun.which("semgrep") ? ["semgrep"] : Bun.which("uvx") ? ["uvx", "--quiet", "semgrep"] : null;
  if (!cmd) return ["skipped", "install uv (uvx runs semgrep without a global install)"];
  // semgrep-core opens io_uring rings, which fail with ENOMEM once the per-user locked-memory limit is used up
  const r = await run([...cmd, "scan", "--metrics=off", "--config", "p/typescript", "--config", "p/nodejsscan", "--config", "p/secrets", "--json", "--quiet", "src", "web", "scripts"], { quiet: true, env: { EIO_BACKEND: "posix" } });
  let found: { check_id: string; path: string; start: { line: number }; extra: { message: string } }[];
  try {
    found = JSON.parse(r.out).results;
  } catch {
    return ["fail", "semgrep did not return JSON"];
  }
  if (found.length === 0) return ["fail", "no findings at all, not even the accepted ones: the rules did not load (network?)"];
  const fresh = found.filter((f) => !ACCEPTED_SEMGREP.some((a) => f.check_id.endsWith(`.${a.rule}`) && f.path === a.path));
  for (const f of fresh) console.error(`semgrep: ${f.path}:${f.start.line} ${f.check_id}\n  ${f.extra.message.slice(0, 200)}`);
  return [fresh.length ? "fail" : "ok", `${found.length - fresh.length} accepted, ${fresh.length} new`];
});

await step("gitleaks (history)", async () => {
  if (!Bun.which("gitleaks")) return ["skipped", "gitleaks not installed"];
  return [(await run(["gitleaks", "git", "--no-banner", "--redact", "."])).code === 0 ? "ok" : "fail", ""];
});

if (withUi) await step("browser checks (ui-check)", async () => [(await run(["bun", "test/perf/ui-check.ts"])).code === 0 ? "ok" : "fail", ""]);

for (const [name, outcome, note] of results) console.log(`${outcome === "ok" ? "ok  " : outcome === "fail" ? "FAIL" : "skip"} ${name}${note ? `  (${note})` : ""}`);
process.exit(results.some(([, o]) => o === "fail") ? 1 : 0);
