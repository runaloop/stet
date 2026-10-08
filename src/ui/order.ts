import { globToRegExp } from "./filters.ts";

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

export class FileOrder {
  readonly groups: OrderGroup[];
  private readonly res: RegExp[][];
  private readonly rest: number;
  private readonly tests: number;

  constructor(groups: OrderGroup[]) {
    this.groups = groups;
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
