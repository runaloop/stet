import { globToRegExp } from "./filters.ts";
import { isTestPath } from "./fold.ts";

/** A group of files on the Changes page. A group without globs takes every file no other group matches. */
export interface OrderGroup {
  name: string;
  globs: string[];
}

/** Kept tests (the ones matched by compare.tests that are not folded) go to the group with this name. */
export const TESTS = "tests";

export const DEFAULT_ORDER =
  "code; " +
  "config: **/*.json, **/*.yaml, **/*.yml, **/*.toml, **/*.properties, **/*.xml, **/src/*/res/**, **/*.gradle, **/*.gradle.kts, gradle/**, **/*.pro, **/*.cfg, **/*.ini, **/*.conf; " +
  "tests; " +
  "docs: **/*.md, **/*.mdx, **/*.rst, **/*.adoc, docs/**";

/** A file as an order sees it: its path, and its path before a rename. */
export interface OrderFile {
  path: string;
  prevPath?: string;
}

/** An order of files `compare.order` may name by its id: the core's, or one an enabled module adds. */
export interface OrderPreset {
  id: string;
  label: string;
  /** What comes first and whom it suits, for a list of the presets. */
  describe: string;
  /** Its groups, written as `compare.order` takes them; without them every file is in one group. */
  groups?: string;
  /** Files of one group: negative when `a` comes first; 0 leaves them in the order the place that lists them has. */
  compare?(a: OrderFile, b: OrderFile): number;
}

export const KINDS: OrderPreset = {
  id: "kinds",
  label: "By kind",
  describe: "code, then resources, build and config, changed tests, docs; the path order within each",
  groups: DEFAULT_ORDER,
};

/** The presets of every build; `kinds` is the order of a repository that sets none. */
export const CORE_PRESETS: readonly OrderPreset[] = [KINDS];

const TITLES: Record<string, string> = {
  code: "Code",
  config: "Resources, build and config",
  tests: "Changed tests",
  docs: "Docs",
};

export function groupTitle(name: string): string {
  return TITLES[name] ?? name;
}

/** `code; config: **\/*.json, **\/*.yml; tests; docs: **\/*.md`: groups top to bottom, globs after a colon. */
export function parseOrder(raw: string | null | undefined): OrderGroup[] {
  const groups: OrderGroup[] = [];
  for (const part of (raw ?? DEFAULT_ORDER).split(/[;\n]/)) {
    const m = /^\s*([^:]*?)\s*(?::(.*))?$/.exec(part);
    const name = m?.[1] ?? "";
    if (!name || groups.some((g) => g.name === name)) continue;
    groups.push({ name, globs: (m?.[2] ?? "").split(/[\s,]+/).filter(Boolean) });
  }
  if (!groups.some((g) => !g.globs.length && g.name !== TESTS)) groups.unshift({ name: "code", globs: [] });
  return groups;
}

/** A value of `compare.order` that names a preset: one word. Groups of one's own have a `;` or a `:`. */
const isPresetId = (raw: string) => /^[\w.-]+$/.test(raw.trim());

/** `compare.order`: a preset's id, or groups of its own; unset, or an id none of `presets` has, is the default. */
export function orderOf(raw: string | null | undefined, presets: readonly OrderPreset[] = CORE_PRESETS): FileOrder {
  if (raw != null && !isPresetId(raw)) return new FileOrder(parseOrder(raw));
  const preset = presets.find((p) => p.id === raw?.trim()) ?? KINDS;
  return new FileOrder(parseOrder(preset.groups ?? ""), preset.compare);
}

/** Why `compare.order` cannot be `raw`: it names a preset none of `presets` has. Null when it can. */
export function orderProblem(raw: string, presets: readonly OrderPreset[]): string | null {
  if (!isPresetId(raw) || presets.some((p) => p.id === raw.trim())) return null;
  return `no order preset '${raw.trim()}'; known: ${presets.map((p) => p.id).join(", ")}; groups of your own take a ';' or a ':', as in "code; docs: **/*.md"`;
}

export class FileOrder {
  readonly groups: OrderGroup[];
  /** The preset's order of files of one group. */
  readonly within?: (a: OrderFile, b: OrderFile) => number;
  private readonly res: RegExp[][];
  private readonly rest: number;
  private readonly tests: number;

  constructor(groups: OrderGroup[], within?: (a: OrderFile, b: OrderFile) => number) {
    this.groups = groups;
    this.within = within;
    this.res = groups.map((g) => g.globs.map(globToRegExp));
    this.rest = groups.findIndex((g) => !g.globs.length && g.name !== TESTS);
    const t = groups.findIndex((g) => g.name === TESTS);
    this.tests = t >= 0 ? t : this.rest;
  }

  /** Index of the group a file belongs to; `test` is whether compare.tests matches it. */
  rank(path: string, test: boolean): number {
    if (test) return this.tests;
    const i = this.res.findIndex((list) => list.some((re) => re.test(path)));
    return i >= 0 ? i : this.rest;
  }

  name(rank: number): string {
    return this.groups[rank]?.name ?? "code";
  }
}

/**
 * Two files in the order of `compare.order` and `compare.tests`: by group, then by the preset's order. 0 leaves them to
 * the caller, whose own order breaks the tie.
 */
export function fileComparator(order: FileOrder, tests: string[]): (a: OrderFile, b: OrderFile) => number {
  const ranks = new Map<string, number>();
  const rank = (f: OrderFile) => {
    let r = ranks.get(f.path);
    if (r === undefined) ranks.set(f.path, (r = order.rank(f.path, isTestPath(f.path, tests, f.prevPath))));
    return r;
  };
  return (a, b) => rank(a) - rank(b) || (order.within?.(a, b) ?? 0);
}
