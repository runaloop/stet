import type { FileDiffMetadata } from "@pierre/diffs";
import { globToRegExp } from "./filters.ts";
import { diffRows } from "./search.ts";

export const DEFAULT_TEST_GLOBS = [
  "**/src/test/**",
  "**/src/androidTest/**",
  "**/src/testFixtures/**",
  "**/*Test.kt",
  "**/*Tests.kt",
  "**/*Test.java",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.test.js",
  "**/*.test.jsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/*.spec.js",
  "**/__tests__/**",
  "**/*_test.go",
  "**/test_*.py",
  "**/*_test.py",
  "**/*_spec.rb",
  "**/*_test.rb",
  "**/*Tests.swift",
  "**/*Tests.cs",
];

export const DEFAULT_SKIP_MARKERS = [
  "@Ignore",
  "@Disabled",
  "@Test(enabled = false",
  "@Test(enabled=false",
  ".skip(",
  "xit(",
  "xdescribe(",
  "xtest(",
  "assumeTrue(false",
  "assume(false",
  "t.Skip(",
  "pytest.mark.skip",
  "unittest.skip",
  "XCTSkip",
  "[Ignore",
  "(Skip =",
];

export const DEFAULT_COLLAPSE_GLOBS = ["**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/gradle.lockfile", "**/verification-metadata.xml"];

export interface FoldConfig {
  tests: string[];
  skipMarkers: string[];
  collapse: string[];
}

export function parseList(raw: string | null | undefined, fallback: string[]): string[] {
  if (raw === null || raw === undefined) return fallback;
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

export type FoldGroup = "tests" | "generated";

export interface FoldDecision {
  group: FoldGroup | null;
  keptBecause: string | null;
}

const compiled = new Map<string, RegExp>();
function matchesAny(path: string, globs: string[]): boolean {
  return globs.some((g) => {
    let re = compiled.get(g);
    if (!re) compiled.set(g, (re = globToRegExp(g)));
    return re.test(path);
  });
}

export function isTestPath(path: string, globs: string[], prevPath?: string): boolean {
  return matchesAny(path, globs) || (!!prevPath && matchesAny(prevPath, globs));
}

export function foldOf(fd: FileDiffMetadata, cfg: FoldConfig): FoldDecision {
  if (matchesAny(fd.name, cfg.collapse)) return { group: "generated", keptBecause: null };
  if (!isTestPath(fd.name, cfg.tests, fd.prevName)) return { group: null, keptBecause: null };
  if (fd.type === "deleted") return { group: null, keptBecause: "test file deleted" };
  const rows = diffRows(fd);
  const removed = rows.filter((r) => r.kind === "del").length;
  if (removed) return { group: null, keptBecause: `${removed} test line${removed === 1 ? "" : "s"} removed or changed` };
  const marker = rows.find((r) => r.kind === "add" && cfg.skipMarkers.some((m) => r.text.includes(m)));
  if (marker) return { group: null, keptBecause: `adds ${cfg.skipMarkers.find((m) => marker.text.includes(m))}` };
  return { group: "tests", keptBecause: null };
}

export function viewedKey(fd: FileDiffMetadata): string {
  return `${fd.name}@${fd.type === "deleted" ? fd.prevObjectId : fd.newObjectId}`;
}
