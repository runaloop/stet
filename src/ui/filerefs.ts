/** A file a message names: `src/Foo.kt:14-15`, `Foo.kt:14:3`, `Foo.kt#L14-L15`, `Foo.kt line 14`, `Foo.kt:14@v3`, or a path alone. */
export interface FileRef {
  /** Where it starts in the text, and the text that becomes the link. */
  index: number;
  text: string;
  /** The path with forward slashes, without a drive, a leading `/`, `~/`, `./` or `../`. */
  path: string;
  /** Written from somewhere else than the repository's root (absolute, `../`): its leading folders may not be the repository's. */
  loose: boolean;
  start: number | null;
  end: number | null;
  column: number | null;
  /** `@v3`: the version the reference names, else the message's own. */
  version: number | null;
}

const SEG = String.raw`\.?[\p{L}\p{N}_+\-]+(?:\.[\p{L}\p{N}_+\-]+)*`;
const PATH = String.raw`(?:[A-Za-z]:[\\/]|~[\\/]|(?:\.{1,2}[\\/])+|[\\/])?(?:${SEG}[\\/])*${SEG}`;
const DASH = String.raw`(?:[\-–—]|\s[\-–—]\s)`;
// "строка", "стр.": Russian for "line".
const LINES = [
  String.raw`:(?<a>\d+)(?:${DASH}(?<b>\d+))?(?::(?<c>\d+))?`,
  String.raw`#L(?<h>\d+)(?:-L?(?<i>\d+))?`,
  String.raw`,?\s+(?:lines?|строк[аиеуы]?|стр\.)\s*(?<w>\d+)(?:\s*[\-–—]\s*(?<x>\d+))?`,
].join("|");
const FILE_REF = new RegExp(String.raw`(?<![\p{L}\p{N}_.\\/@:#~+\-])(?<path>${PATH})(?:${LINES})?(?:@v(?<v>\d+))?(?![\p{L}\p{N}_@])`, "gu");
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()"'`]+|\bwww\.[^\s<>()"'`]+/gi;
const EXT = /\.\p{L}[\p{L}\p{N}_+-]*$/u;

/** The file references in `text`, in order. A name without a line needs an extension; whether it names a file is for `resolveFile`. */
export function fileRefs(text: string): FileRef[] {
  const urls = [...text.matchAll(URL)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const out: FileRef[] = [];
  for (const m of text.matchAll(FILE_REF)) {
    const at = m.index!;
    if (urls.some(([a, b]) => at < b && at + m[0].length > a)) continue;
    const g = m.groups!;
    const written = g.path!.replace(/\\/g, "/");
    const path = written.replace(/^(?:[A-Za-z]:\/|~\/|(?:\.\.?\/)+|\/)/, "");
    const base = path.slice(path.lastIndexOf("/") + 1);
    const a = Number(g.a ?? g.h ?? g.w ?? 0) || null;
    const b = Number(g.b ?? g.i ?? g.x ?? 0) || null;
    // a name without an extension only before a line, and only one a file has: `Makefile:3`, not `localhost:8080` or `12:30`
    if (!EXT.test(base) && (a === null || g.w !== undefined || (!path.includes("/") && !/^\p{Lu}/u.test(base)))) continue;
    out.push({
      index: at,
      text: m[0],
      path,
      loose: written !== path && !/^\.\//.test(written),
      start: a === null ? null : b === null ? a : Math.min(a, b),
      end: a === null ? null : b === null ? a : Math.max(a, b),
      column: Number(g.c ?? 0) || null,
      version: Number(g.v ?? 0) || null,
    });
  }
  return out;
}

/** The paths of a set of files by their names, for `resolveFile`. */
export interface FileIndex {
  byName: ReadonlyMap<string, readonly string[]>;
}

export function fileIndex(paths: readonly string[]): FileIndex {
  const byName = new Map<string, string[]>();
  for (const p of paths) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    const list = byName.get(name);
    if (list) list.push(p);
    else byName.set(name, [p]);
  }
  return { byName };
}

/** The files of `index` a written path may be: itself, the files it is the end of, or for a loose path the longest one that ends it. */
export function matchFile(ref: Pick<FileRef, "path" | "loose">, index: FileIndex): string[] {
  const { path } = ref;
  const same = index.byName.get(path.slice(path.lastIndexOf("/") + 1)) ?? [];
  if (same.includes(path)) return [path];
  const within = same.filter((f) => f.endsWith(`/${path}`));
  if (within.length || !ref.loose) return within;
  const around = same.filter((f) => path.endsWith(`/${f}`));
  const longest = Math.max(0, ...around.map((f) => f.length));
  return around.filter((f) => f.length === longest);
}

/**
 * The files a reference names, from the first index that has any: the files of the review's diff, then the
 * repository's. One is a link, several a choice; none leaves the text as it is. Null while an index it needs is not
 * there yet.
 */
export function resolveFile(ref: Pick<FileRef, "path" | "loose">, indexes: readonly (FileIndex | null)[]): string[] | null {
  for (const index of indexes) {
    if (!index) return null;
    const hit = matchFile(ref, index);
    if (hit.length) return hit;
  }
  return [];
}

/** `14`, `14–15`, or an empty string for a reference without lines. */
export function linesText(r: { start: number | null; end: number | null }): string {
  return r.start === null ? "" : r.end === null || r.end === r.start ? `${r.start}` : `${r.start}–${r.end}`;
}
