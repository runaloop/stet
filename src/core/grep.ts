import { usage } from "./context.ts";
import { gitRun } from "./git.ts";
import type { GrepFileDto, GrepResultDto } from "./types.ts";

export function parseGrep(out: string, rev: string, limit: number): GrepResultDto {
  const files: GrepFileDto[] = [];
  let file: GrepFileDto | null = null;
  let total = 0;
  let truncated = false;
  let heading = true;
  for (const raw of out.split("\n")) {
    if (raw === "") {
      heading = true;
      continue;
    }
    if (heading) {
      heading = false;
      if (total >= limit) {
        truncated = true;
        break;
      }
      file = { path: raw.startsWith(`${rev}:`) ? raw.slice(rev.length + 1) : raw, groups: [[]], matches: 0 };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (raw === "--") {
      file.groups.push([]);
      continue;
    }
    const m = /^(\d+)([:-])(.*)$/s.exec(raw);
    if (!m) continue;
    const match = m[2] === ":";
    file.groups[file.groups.length - 1]!.push({ line: Number(m[1]), text: m[3]!, match });
    if (match) {
      file.matches++;
      total++;
    }
  }
  for (const f of files) f.groups = f.groups.filter((g) => g.length > 0);
  return { files, total, truncated, error: null };
}

export async function grepTree(cwd: string, sha: string, query: string, opts: { regex: boolean; limit?: number }): Promise<GrepResultDto> {
  if (!/^[0-9a-f]{7,64}$/.test(sha)) throw usage("bad sha");
  if (query.length < 2) return { files: [], total: 0, truncated: false, error: null };
  const args = ["grep", "-n", "-I", "-C1", "--heading", "--break", "--full-name", "--no-color"];
  if (!/[A-Z]/.test(query)) args.push("-i");
  const run = (mode: string) => gitRun([...args, mode, "-e", query, sha, "--"], { cwd });
  let r = await run(opts.regex ? "-P" : "-F");
  // git built without PCRE (Apple's, for one) takes POSIX extended regexps only.
  if (opts.regex && r.code > 1 && /pcre|perl/i.test(r.stderr)) r = await run("-E");
  if (r.code === 1) return { files: [], total: 0, truncated: false, error: null };
  if (r.code !== 0) return { files: [], total: 0, truncated: false, error: r.stderr.replace(/^fatal: /, "").trim() };
  return parseGrep(new TextDecoder().decode(r.stdout), sha, opts.limit ?? 2000);
}
