import { notFound, usage, type Ctx } from "./context.ts";
import { blobIdAt, readBlobById, splitLines } from "./git.ts";
import type { GuideDto, GuideRefDto, GuideStepDto } from "./types.ts";
import { nowIso } from "./store/db.ts";

/**
 * The agent's guide to a version (experimental): a `# title`, an optional intro, then numbered steps. A step is its
 * text (Markdown, over as many lines as it needs) and, on its last lines, one or more references, each alone on its
 * line: `path` for the file's whole change, `path:a` or `path:a-b` for lines of the file in the version.
 */
export interface ParsedGuide {
  title: string | null;
  intro: string;
  steps: Omit<GuideStepDto, "index">[];
}

const STEP = /^(\d+)[.)](?:[ \t]+(.*))?$/;
const REF = /^`?([^\s`:]+)(?::(\d+)(?:-(\d+))?)?`?$/;
const THREAD = /(?<![\w&#])#(\d+)\b/g;

/** Threads a step's text names as `#12`, outside code spans. */
export function threadsIn(text: string): number[] {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  return [...new Set([...prose.matchAll(THREAD)].map((m) => Number(m[1])))];
}

function refOf(line: string): { ref: GuideRefDto } | { error: string } | null {
  const m = REF.exec(line.trim());
  if (!m) return null;
  const path = m[1]!.replace(/^\.\//, "");
  if (path.startsWith("/") || path.split("/").includes("..")) return { error: `${line.trim()}: give the path from the repository's root` };
  if (m[2] === undefined) return { ref: { path, range: null } };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) return { error: `${line.trim()}: a range is a-b with 1 <= a <= b` };
  return { ref: { path, range: { start, end } } };
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length)));
}

const trimBlank = (lines: string[]) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
};

export function parseGuide(source: string): ParsedGuide {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && !lines[i]!.trim()) i++;
  const head = /^#[ \t]+(.+?)[ \t#]*$/.exec(lines[i] ?? "");
  const title = head ? head[1]! : null;
  if (head) i++;
  const intro: string[] = [];
  const raw: { first: string; rest: string[] }[] = [];
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const m = STEP.exec(line);
    if (m) raw.push({ first: m[2] ?? "", rest: [] });
    else if (raw.length) raw[raw.length - 1]!.rest.push(line);
    else intro.push(line);
  }
  if (raw.length === 0) throw usage("the guide has no steps: number them at the start of a line, 1. 2. 3.");
  const errors: string[] = [];
  const steps = raw.map((s, k) => {
    const rest = trimBlank(s.rest);
    const refs: GuideRefDto[] = [];
    let at = rest.length;
    while (at > 0) {
      const r = refOf(rest[at - 1]!);
      if (!r) break;
      if ("error" in r) errors.push(`step ${k + 1}: ${r.error}`);
      else refs.unshift(r.ref);
      at--;
    }
    const text = [s.first, ...dedent(rest.slice(0, at))].join("\n").trim();
    if (!text) errors.push(`step ${k + 1} has no text: write what it does before its lines`);
    if (at === rest.length) errors.push(`step ${k + 1} names no lines: end it with one or more lines of \`path\` or \`path:a-b\``);
    return { text, refs, threads: threadsIn(text) };
  });
  if (errors.length) throw usage(`the guide is not in the guide format:\n  ${errors.join("\n  ")}`);
  return { title, intro: trimBlank(intro).join("\n"), steps };
}

const refText = (r: GuideRefDto) => (r.range ? `${r.path}:${r.range.start === r.range.end ? r.range.start : `${r.range.start}-${r.range.end}`}` : r.path);

/** The guide in the format it was written in. */
export function guideMarkdown(g: Pick<GuideDto, "title" | "intro" | "steps">): string {
  const out: string[] = [];
  if (g.title) out.push(`# ${g.title}`, "");
  if (g.intro) out.push(g.intro, "");
  g.steps.forEach((s, k) => {
    const pad = " ".repeat(`${k + 1}. `.length);
    const [first, ...rest] = s.text.split("\n");
    out.push(`${k + 1}. ${first}`, ...rest.map((l) => (l ? pad + l : l)), ...s.refs.map((r) => pad + refText(r)));
  });
  return out.join("\n") + "\n";
}

/**
 * Checks every reference against the version at `sha`: the file is there, and a range is inside it. A whole-file
 * reference may name a file the version deletes: one that `before` (the base, the previous version) still has.
 */
export async function checkGuide(ctx: Ctx, guide: ParsedGuide, sha: string, label: string, before: string[]): Promise<void> {
  const cwd = ctx.repo.cwd;
  const errors: string[] = [];
  for (const [k, s] of guide.steps.entries()) {
    for (const r of s.refs) {
      const id = await blobIdAt(cwd, sha, r.path);
      const bad = (why: string) => errors.push(`step ${k + 1}: ${refText(r)}: ${why}`);
      if (!id) {
        const gone = !r.range && (await Promise.all(before.map((b) => blobIdAt(cwd, b, r.path)))).some(Boolean);
        if (!gone) bad(`no such file in ${label}`);
        continue;
      }
      if (!r.range) continue;
      const blob = await readBlobById(cwd, id);
      if (blob.binary) {
        bad("a binary file has no lines: name it without a range");
        continue;
      }
      const n = splitLines(blob.text).length;
      if (r.range.end > n) bad(`the file has ${n} line${n === 1 ? "" : "s"} in ${label}`);
    }
  }
  if (errors.length) {
    throw usage(`the guide names lines that ${label} does not have, so no version was created:\n  ${errors.join("\n  ")}`);
  }
}

export function saveGuide(ctx: Ctx, versionId: number, guide: ParsedGuide): void {
  const db = ctx.store.db;
  db.run("INSERT INTO guides(version_id, title, intro, created_at) VALUES (?, ?, ?, ?)", [versionId, guide.title, guide.intro, nowIso()]);
  guide.steps.forEach((s, k) => {
    db.run("INSERT INTO guide_steps(version_id, position, text) VALUES (?, ?, ?)", [versionId, k + 1, s.text]);
    s.refs.forEach((r, j) => {
      db.run("INSERT INTO guide_refs(version_id, step, position, path, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?)", [
        versionId,
        k + 1,
        j + 1,
        r.path,
        r.range?.start ?? null,
        r.range?.end ?? null,
      ]);
    });
  });
}

/** The guide to version `number` of the review, or null when the agent wrote none. */
export function loadGuide(ctx: Ctx, reviewId: number, number: number): GuideDto | null {
  const db = ctx.store.db;
  const head = db
    .query<{ version_id: number; title: string | null; intro: string }, [number, number]>(
      "SELECT g.version_id, g.title, g.intro FROM guides g JOIN versions v ON v.id = g.version_id WHERE v.review_id = ? AND v.number = ?",
    )
    .get(reviewId, number);
  if (!head) return null;
  const steps = db
    .query<{ position: number; text: string }, [number]>("SELECT position, text FROM guide_steps WHERE version_id = ? ORDER BY position")
    .all(head.version_id);
  const refs = db
    .query<{ step: number; path: string; start_line: number | null; end_line: number | null }, [number]>(
      "SELECT step, path, start_line, end_line FROM guide_refs WHERE version_id = ? ORDER BY step, position",
    )
    .all(head.version_id);
  return {
    version: number,
    title: head.title,
    intro: head.intro,
    steps: steps.map((s) => ({
      index: s.position,
      text: s.text,
      refs: refs
        .filter((r) => r.step === s.position)
        .map((r) => ({ path: r.path, range: r.start_line === null ? null : { start: r.start_line, end: r.end_line! } })),
      threads: threadsIn(s.text),
    })),
  };
}

export function requireGuide(ctx: Ctx, reviewId: number, number: number): GuideDto {
  const g = loadGuide(ctx, reviewId, number);
  if (!g) throw notFound(`a guide to v${number}`);
  return g;
}
