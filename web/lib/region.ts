import { structuredPatch } from "diff";

export interface LineRange {
  start: number;
  end: number;
}

export interface RegionDiff {
  changed: boolean;
  patch: string | null;
  complete: boolean;
}

const overlaps = (start: number, count: number, r: LineRange) => start <= r.end && start + Math.max(count, 1) - 1 >= r.start;

function slice(text: string, r: LineRange): string {
  return text.split("\n").slice(r.start - 1, r.end).join("\n");
}

export function regionDiff(
  oldFile: { path: string; text: string; range: LineRange | null },
  newFile: { path: string; text: string; range: LineRange },
  context = 6,
): RegionDiff {
  const changed = !oldFile.range || slice(oldFile.text, oldFile.range) !== slice(newFile.text, newFile.range);
  const p = structuredPatch(oldFile.path, newFile.path, oldFile.text, newFile.text, undefined, undefined, { context });
  const hunks = p.hunks.filter(
    (h) => (oldFile.range && overlaps(h.oldStart, h.oldLines, oldFile.range)) || overlaps(h.newStart, h.newLines, newFile.range),
  );
  const complete = hunks.length === p.hunks.length;
  if (hunks.length === 0) return { changed, patch: null, complete };
  const body = hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");
  const rename = oldFile.path !== newFile.path ? `rename from ${oldFile.path}\nrename to ${newFile.path}\n` : "";
  return {
    changed,
    complete,
    patch: `diff --git a/${oldFile.path} b/${newFile.path}\n${rename}--- a/${oldFile.path}\n+++ b/${newFile.path}\n${body}\n`,
  };
}

export type RegionKind = "changed" | "nearby" | "same";

export interface RegionPatch {
  kind: RegionKind;
  patch: string;
  complete: boolean;
}

function lines(text: string): string[] {
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

export function contextPatch(
  oldFile: { path: string; text: string },
  newFile: { path: string; text: string; range: LineRange },
  context = 6,
): string {
  const next = lines(newFile.text);
  const start = Math.max(1, newFile.range.start - context);
  const end = Math.min(next.length, newFile.range.end + context);
  let offset = 0;
  for (const h of structuredPatch(oldFile.path, newFile.path, oldFile.text, newFile.text, undefined, undefined, { context: 0 }).hunks) {
    const before = h.newLines === 0 ? h.newStart < start : h.newStart + h.newLines - 1 < start;
    if (before) offset += h.newLines - h.oldLines;
  }
  const n = Math.max(0, end - start + 1);
  const body = next.slice(start - 1, end).map((l) => ` ${l}`).join("\n");
  const rename = oldFile.path !== newFile.path ? `rename from ${oldFile.path}\nrename to ${newFile.path}\n` : "";
  return `diff --git a/${oldFile.path} b/${newFile.path}\n${rename}--- a/${oldFile.path}\n+++ b/${newFile.path}\n@@ -${start - offset},${n} +${start},${n} @@\n${body}\n`;
}

export function regionPatch(
  oldFile: { path: string; text: string; range: LineRange | null },
  newFile: { path: string; text: string; range: LineRange },
  context = 6,
): RegionPatch {
  const d = regionDiff(oldFile, newFile, context);
  if (d.patch) return { kind: d.changed ? "changed" : "nearby", patch: d.patch, complete: d.complete };
  return { kind: "same", patch: contextPatch(oldFile, newFile, context), complete: d.complete };
}
