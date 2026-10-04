import { join } from "node:path";
import { GIT_ENV } from "./fixture.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

export function stet(
  args: string[],
  opts: { cwd: string; role?: "reviewer" | "agent"; author?: string; input?: string; env?: Record<string, string> },
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", CLI, ...args, "--json"], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...GIT_ENV,
      STET_ROLE: opts.role ?? "agent",
      STET_AUTHOR: opts.author ?? (opts.role === "reviewer" ? "alice" : "claude"),
      ...opts.env,
    },
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return (async () => {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
    return { code, stdout, stderr, json };
  })();
}

export async function ok(p: Promise<CliResult>): Promise<any> {
  const r = await p;
  if (r.code !== 0) throw new Error(`stet failed (${r.code}): ${r.stderr || r.stdout}`);
  return r.json;
}
