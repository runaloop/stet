import { regionText } from "../core/image.ts";
import type { BlameDto, CommentDto, CompareDto, StatusDto, ThreadDetail, ThreadSummary, VersionDto } from "../core/types.ts";

export { regionText };

const tty = process.stdout.isTTY === true;
const c = (code: string) => (s: string) => (tty && !process.env.NO_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = c("2");
export const bold = c("1");
const red = c("31");
const green = c("32");
const yellow = c("33");
const cyan = c("36");

const range = (r: { start: number; end: number }) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`);

const versionText = (v: number | "base") => (v === "base" ? "base" : `v${v}`);

function stateBadge(t: ThreadSummary): string {
  const a = t.anchor;
  if (a.state === "ok") return "";
  const where = a.range ? (t.region ? (a.path !== t.path ? ` → ${a.path}` : "") : ` → ${a.path !== t.path ? a.path + ":" : ""}${range(a.range)}`) : "";
  const text = `[${a.state}${where} @${a.againstLabel}]`;
  return a.state === "outdated" ? red(text) : a.state === "changed" ? yellow(text) : dim(text);
}

export function formatThreadLine(t: ThreadSummary): string {
  const status = t.status === "open" ? green("open") : dim(`resolved${t.resolveReason ? `:${t.resolveReason}` : ""}`);
  const flags = [
    t.draft ? yellow("draft") : "",
    t.unread ? cyan("new") : "",
    t.needsReply ? `needs ${t.needsReply}` : "",
    t.last?.restore ? yellow(`restore ${versionText(t.last.restore.version)}`) : "",
  ].filter(Boolean).join(" ");
  const where = t.region ? `${t.path} [image area ${regionText(t.region)}]` : `${t.path}:${range(t.range)}`;
  return `${bold(`#${t.id}`)} ${status} ${where} ${stateBadge(t)} ${flags} ${dim(`(${t.commentCount})`)} ${t.title}`
    .replace(/ +/g, " ");
}

export function formatThreadList(list: ThreadSummary[]): string {
  if (list.length === 0) return dim("no threads");
  const byFile = new Map<string, ThreadSummary[]>();
  for (const t of list) {
    const key = t.anchor.path ?? t.path;
    byFile.set(key, [...(byFile.get(key) ?? []), t]);
  }
  const out: string[] = [];
  for (const [file, threads] of byFile) {
    out.push(bold(file));
    for (const t of threads) out.push("  " + formatThreadLine(t));
  }
  return out.join("\n");
}

function commentTree(comments: CommentDto[]): string[] {
  const children = new Map<number | null, CommentDto[]>();
  for (const cm of comments) children.set(cm.parentId, [...(children.get(cm.parentId) ?? []), cm]);
  const out: string[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const cm of children.get(parent) ?? []) {
      const pad = "  ".repeat(depth);
      const head = `${pad}${bold(cm.author)} ${dim(`(${cm.role}${cm.intent ? `, ${cm.intent}` : ""}${cm.draft ? ", draft" : ""}) #${cm.id} · step ${cm.step}`)}`;
      out.push(head);
      if (cm.body) for (const line of cm.body.split("\n")) out.push(`${pad}  ${line}`);
      const r = cm.restore;
      if (r) {
        out.push(`${pad}  ${yellow(`restore as in ${versionText(r.version)}, ${r.path}:${range(r.range)}:`)}`);
        for (const line of r.text.split("\n")) out.push(`${pad}  ${dim("|")} ${line}`);
      }
      walk(cm.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function formatThreadDetail(d: ThreadDetail): string {
  const out: string[] = [formatThreadLine(d.thread), ""];
  out.push(bold("timeline"));
  for (const s of d.timeline) {
    const where = s.range ? (d.thread.region ? (s.path ?? "-") : `${s.path}:${range(s.range)}`) : "-";
    out.push(`  ${s.index}. ${s.label.padEnd(6)} ${s.state.padEnd(8)} ${where}${s.commentIds.length ? dim(`  comments ${s.commentIds.map((i) => "#" + i).join(" ")}`) : ""}`);
  }
  const then = d.code.then;
  if (then) {
    out.push("", bold(`code then (${d.timeline[0]!.label})`));
    then.lines.forEach((l, i) => {
      const n = then.firstLine + i;
      const inside = n >= then.start && n <= then.end;
      out.push(`${inside ? ">" : " "}${String(n).padStart(5)} ${l}`);
    });
  } else if (d.thread.region) {
    out.push("", bold(`image area (${d.timeline[0]!.label})`), `  ${d.thread.path}: ${regionText(d.thread.region)} (pixels: x,y from the top left)`);
    if (d.image) {
      out.push(`  open ${d.image.shot}  (${d.image.crop ? "the image with the area framed" : "the image as it was"})`);
      if (d.image.crop) out.push(`  open ${d.image.crop}  (the area at full size)`);
    }
  }
  if (d.code.interdiff) {
    out.push("", bold("then → now"));
    out.push(...d.code.interdiff.split("\n").filter((l) => !l.startsWith("====")));
  }
  out.push("", bold("conversation"));
  out.push(...commentTree(d.comments));
  return out.join("\n");
}

export function formatStatus(s: StatusDto, url?: string | null): string {
  const out: string[] = [];
  out.push(`${bold(s.review.branch)} ${dim(`(review ${s.review.id}, ${s.review.source === "index" ? "staged changes" : "working tree"}, base ${s.review.baseRef ?? "none"})`)}`);
  out.push(`versions: ${s.versions}${s.latest ? `, latest v${s.latest.number}${s.latest.label ? ` "${s.latest.label}"` : ""}${s.latest.guide ? dim(" (guide: stet guide)") : ""}` : ""}`);
  if (s.now) out.push(`now: ${s.now.changedSinceLatest ? yellow("changed since latest version") : "same as latest version"}${s.now.excluded.length ? dim(` (${s.now.excluded.length} files excluded from snapshots)`) : ""}`);
  const k = s.counts;
  out.push(
    `threads: ${k.open} open (${k.needsAgent} need agent, ${k.needsReviewer} need reviewer, ${k.changed} changed, ${k.outdated} outdated), ${k.resolved} resolved, ${k.drafts} drafts, ${k.unread} unread`,
  );
  const ls = s.lastSubmission;
  if (ls) {
    const what = `${ls.verdict === "approved" ? "approved" : "changes requested"}${ls.version !== null ? ` at v${ls.version}` : ""}`;
    out.push(`last review: ${ls.verdict === "approved" ? green(what) : what}${ls.changedAfter ? yellow(", changed after") : ""} ${dim(`(${ls.at.replace("T", " ").slice(0, 16)})`)}`);
  }
  out.push(`guide to the next version: ${s.guide === "requested" ? yellow("requested by the reviewer") : s.guide === "on" ? "when it changes more than the threads asked (agent.guide on)" : "none (agent.guide off)"}`);
  if (url) out.push(`ui: ${url}`);
  return out.join("\n");
}

export function formatVersions(vs: VersionDto[]): string {
  if (vs.length === 0) return dim("no versions");
  return vs
    .map((v) => `${bold(`v${v.number}`)} ${dim(v.snapshot.slice(0, 10))} ${v.createdAt.replace("T", " ").slice(0, 16)} ${v.role}/${v.author}${v.label ? ` "${v.label}"` : ""}${v.guide ? ` ${cyan("guide")}` : ""}`)
    .join("\n");
}

const BLAME_MATCH = { anchor: "", named: dim(" (named)"), file: dim(" (same file)") } as const;

export function formatBlame(d: BlameDto): string {
  if (!d.runs.length) return dim(`${d.path} is empty at ${d.at.label}`);
  const width = Math.max(...d.runs.map((r) => range(r).length));
  return d.runs
    .map((r) => {
      const o = r.origin;
      const from = o.kind === "version" ? bold(`v${o.version}`) + (r.round ? ` (round ${r.round.index})` : "") : o.kind === "now" ? yellow("now") : dim("base");
      const threads = r.threads.map((t) => ` · ${t.reply.intent} ${cyan(`#${t.id}`)} "${t.title}"${BLAME_MATCH[t.match]}`).join("");
      return `${range(r).padEnd(width)}  ${from}${threads}`;
    })
    .join("\n");
}

export function formatCompare(d: CompareDto): string {
  const out = [bold(`${d.from.label} → ${d.to.label}`)];
  for (const f of d.files) {
    const stat = f.binary ? "binary" : `+${f.additions ?? 0} -${f.deletions ?? 0}`;
    const name = f.oldPath && f.oldPath !== f.path ? `${f.oldPath} → ${f.path}` : f.path;
    const threads = d.placements.filter((p) => p.path === f.path).map((p) => `#${p.threadId}`);
    out.push(`  ${f.status} ${name} ${dim(stat)}${threads.length ? cyan("  " + threads.join(" ")) : ""}`);
  }
  if (d.outside.length) out.push(dim(`threads outside this diff: ${d.outside.map((i) => "#" + i).join(" ")}`));
  return out.join("\n");
}
