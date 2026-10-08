import { isAbsolute, join } from "node:path";
import { routeHash, type Route } from "../ui/route.ts";
import { StetError, notFound, nowSource, usage, type Ctx } from "./context.ts";
import type { ActionDef, ActionTarget, Launch } from "./module.ts";
import { fileChange } from "./placement.ts";
import { mapLine } from "./reanchor.ts";
import { resolveRef, threadSummaries } from "./service.ts";
import type { ReviewRow } from "./store/db.ts";

/** A command to run, as an argv without a shell and as the line a person would paste into one. */
export interface LaunchCommand {
  argv: string[];
  cwd: string;
  shell: string;
}

export interface EditorCommand extends LaunchCommand {
  file: string;
  line: number;
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const shellOf = (argv: string[]) => argv.map(quote).join(" ");

export function editorTemplate(): string | null {
  return process.env.STET_EDITOR?.trim() || null;
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string[] {
  return template
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")));
}

/** `STET_EDITOR` filled in, else `$VISUAL` or `$EDITOR` with the way each editor takes a line. */
export function editorCommand(l: Extract<Launch, { kind: "file" }>): EditorCommand {
  const { root, path, file, line } = l;
  const template = editorTemplate();
  let argv: string[];
  if (template) {
    argv = renderTemplate(template, { file, line, root, path });
  } else {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const parts = editor.split(/\s+/);
    const name = parts[0]!.split("/").pop()!;
    if (["code", "codium", "cursor", "windsurf"].includes(name)) argv = [...parts, "-g", `${file}:${line}`];
    else if (["hx", "helix", "zed", "subl", "idea", "studio"].includes(name)) argv = [...parts, `${file}:${line}`];
    else argv = [...parts, `+${line}`, file];
  }
  return { argv, cwd: root, shell: shellOf(argv), file, line };
}

export function openerArgv(url: string): string[] {
  return process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", url];
}

/** What runs a launch on this machine: the editor for a file, the browser for a URL, else the argv itself. */
export function launchCommand(l: Launch): LaunchCommand {
  if (l.kind === "file") return editorCommand(l);
  const argv = l.kind === "url" ? openerArgv(l.url) : l.argv;
  return { argv, cwd: l.kind === "argv" ? l.cwd : process.cwd(), shell: shellOf(argv) };
}

function repoPath(path: unknown): string {
  if (typeof path !== "string" || !path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw usage("path must be a path in the repository");
  return path;
}

function lineOf(line: unknown): number {
  if (line === undefined) return 1;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw usage("line must be a line number");
  return line;
}

async function threadPlace(ctx: Ctx, review: ReviewRow, id: number): Promise<{ path: string; line: number }> {
  const [t] = await threadSummaries(ctx, review, { ids: [id], includeDrafts: true });
  if (!t) throw notFound(`thread #${id}`);
  return { path: t.anchor.path ?? t.path, line: t.anchor.range?.start ?? t.range.start };
}

/** A line of a version is where the same line is now: the editor opens the file as it is. */
async function linePlace(ctx: Ctx, review: ReviewRow, t: ActionTarget): Promise<{ path: string; line: number }> {
  const path = repoPath(t.path);
  const line = lineOf(t.line);
  if (!t.at || t.at === "now") return { path, line };
  const at = await resolveRef(ctx, review, t.at);
  const now = await resolveRef(ctx, review, "now");
  const change = await fileChange(ctx.repo.cwd, at.sha, now.sha, path);
  if (change.kind === "deleted") return { path, line };
  return { path: change.newPath, line: change.kind === "modified" ? (mapLine(line, change.hunks) ?? line) : line };
}

const editorOpen: ActionDef = {
  id: "editor.open",
  label: "open in the editor",
  command: "editor.open",
  where: ["thread"],
  available: (_ctx, t) => t.thread !== undefined || t.path !== undefined,
  async resolve(ctx, review, t) {
    const src = await nowSource(ctx, review);
    const root = src.kind === "worktree" ? src.path : (ctx.repo.toplevel ?? ctx.repo.cwd);
    const { path, line } = t.thread !== undefined ? await threadPlace(ctx, review, t.thread) : await linePlace(ctx, review, t);
    return { kind: "file", root, path, file: join(root, path), line };
  },
};

/** The page's route for a target: the thread, the file's line in the compare `from..at`, or the review. */
export function routeOf(t: ActionTarget): Route {
  if (t.thread !== undefined) return { name: "thread", id: t.thread };
  if (t.path === undefined) return { name: "home" };
  return { name: "compare", from: t.from ?? "base", to: t.at ?? "now", file: repoPath(t.path), ...(t.line !== undefined ? { line: lineOf(t.line) } : {}) };
}

const browserOpen: ActionDef = {
  id: "browser.open",
  label: "open in the browser",
  command: "browser.open",
  where: ["everywhere"],
  available: () => true,
  async resolve(ctx, review, t) {
    if (t.thread !== undefined && !ctx.store.db.query("SELECT 1 FROM threads WHERE id = ? AND review_id = ?").get(t.thread, review.id)) {
      throw notFound(`thread #${t.thread}`);
    }
    const hash = routeHash(routeOf(t), review.id);
    const { readServerInfo } = await import("../server/info.ts");
    let info: { port: number; token: string } | null = await readServerInfo(ctx.repo.commonDir);
    if (!info) {
      const { startDetached } = await import("../server/server.ts");
      info = await startDetached(ctx, { port: 0, open: false, printUrlOnly: false, json: false });
    }
    if (!info) throw new StetError("the server did not start; run `stet serve` to see why", 1, "no_server");
    return { kind: "url", url: `http://127.0.0.1:${info.port}/${hash}&token=${info.token}` };
  },
};

/** The core's own actions; modules add theirs after them. */
export const CORE_ACTIONS: readonly ActionDef[] = [editorOpen, browserOpen];

/** A target from a request body or flags: the fields of the right types, or a usage error. */
export function actionTarget(body: unknown): ActionTarget {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw usage("the target must be an object");
  const b = body as Record<string, unknown>;
  const t: ActionTarget = {};
  if (b.thread !== undefined) {
    if (typeof b.thread !== "number" || !Number.isInteger(b.thread) || b.thread < 1) throw usage("thread must be a thread id");
    t.thread = b.thread;
  }
  if (b.path !== undefined) t.path = repoPath(b.path);
  if (b.line !== undefined) t.line = lineOf(b.line);
  for (const k of ["at", "from"] as const) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string" || !b[k]) throw usage(`${k} must be a version or a commit`);
    t[k] = b[k];
  }
  return t;
}
