import { join } from "node:path";
import { notFound, nowSource, type Ctx } from "./context.ts";
import { threadSummaries } from "./service.ts";
import type { ReviewRow } from "./store/db.ts";

export interface JumpCommand {
  argv: string[];
  cwd: string;
  shell: string;
  file: string;
  line: number;
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

async function target(ctx: Ctx, review: ReviewRow, id: number) {
  const [t] = await threadSummaries(ctx, review, { ids: [id], includeDrafts: true });
  if (!t) throw notFound(`thread #${id}`);
  const src = await nowSource(ctx, review);
  const root = src.kind === "worktree" ? src.path : (ctx.repo.toplevel ?? ctx.repo.cwd);
  const path = t.anchor.path ?? t.path;
  const line = t.anchor.range?.start ?? t.range.start;
  return { root, path, line };
}

export function editorTemplate(): string | null {
  return process.env.STET_EDITOR?.trim() || null;
}

export function renderTemplate(template: string, vars: Record<string, string | number>): string[] {
  return template
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")));
}

export async function editorCommand(ctx: Ctx, review: ReviewRow, id: number): Promise<JumpCommand> {
  const { root, path, line } = await target(ctx, review, id);
  const file = join(root, path);
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
  return { argv, cwd: root, shell: argv.map(quote).join(" "), file, line };
}
