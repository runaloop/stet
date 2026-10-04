import { expect, test } from "bun:test";
import type { GitFileDto, GitStateDto } from "../../src/core/types.ts";
import { fileMarks, gitSummary } from "../../web/lib/gitmarks.ts";

const file = (path: string, f: Partial<GitFileDto> = {}): GitFileDto => ({ path, staged: false, unstaged: false, untracked: false, conflict: false, unpushed: false, ...f });
const state = (g: Partial<GitStateDto> = {}): GitStateDto => ({
  branch: "feat",
  worktree: "/w",
  detached: false,
  tip: "a".repeat(40),
  upstream: "origin/feat",
  tracking: true,
  gone: false,
  ahead: 0,
  behind: 0,
  unpushed: [],
  files: [],
  truncated: false,
  ...g,
});
const texts = (ms: { text: string }[]) => ms.map((m) => m.text);

test("a file's marks: its worktree state, then ↑ when commits that touch it are not pushed", () => {
  expect(texts(fileMarks(undefined, false))).toEqual([]);
  expect(texts(fileMarks(file("a", { staged: true, unpushed: true }), false))).toEqual(["staged", "↑"]);
  expect(texts(fileMarks(file("a", { staged: true, unstaged: true }), false))).toEqual(["partly staged"]);
  expect(texts(fileMarks(file("a", { untracked: true }), false))).toEqual(["new"]);
  expect(texts(fileMarks(file("a", { unpushed: true }), false))).toEqual(["↑"]);
  expect(texts(fileMarks(file("a", { staged: true }), true))).toEqual([]);
  const outside = fileMarks(file("a", { unstaged: true }), true)[0]!;
  expect(outside.tone).toBe("warn");
  expect(outside.title).toContain("not in this review");
});

test("the header line: pushed or not first, then what is not committed", () => {
  expect(texts(gitSummary(state(), false))).toEqual(["pushed"]);
  expect(texts(gitSummary(state({ ahead: 3, behind: 1 }), false))).toEqual(["↑3 not pushed", "↓1"]);
  expect(texts(gitSummary(state({ upstream: null, ahead: 2 }), false))).toEqual(["not pushed · 2 commits"]);
  expect(texts(gitSummary(state({ gone: true }), false))).toEqual(["remote branch gone"]);
  const files = [file("a", { staged: true }), file("b", { staged: true, unstaged: true }), file("c", { unstaged: true }), file("d", { untracked: true })];
  expect(texts(gitSummary(state({ files }), false))).toEqual(["pushed", "2 staged", "2 not staged", "1 new"]);
  expect(texts(gitSummary(state({ files }), true))).toEqual(["pushed", "2 staged", "3 not in review"]);
});
