import { expect, test } from "bun:test";
import type { CommentDto, VersionDto } from "../../src/core/types.ts";
import { fileIndex } from "../../src/ui/filerefs.ts";
import { linksOf, messageRefs, statesOf, targetsOf } from "../../src/tui/filerefs.ts";

test("a message's references in its text, its inline code and its code blocks, with indexes into the whole text", () => {
  const text = "Moved it (RetryQueue.kt:14-15); see `src/app/Foo.kt:42` and\n```kotlin\nBar.kt#L3\n```\nthen Baz.kt line 7.";
  const refs = messageRefs(text);
  expect(refs.map((r) => [r.text, r.path, r.start, r.end])).toEqual([
    ["RetryQueue.kt:14-15", "RetryQueue.kt", 14, 15],
    ["src/app/Foo.kt:42", "src/app/Foo.kt", 42, 42],
    ["Bar.kt#L3", "Bar.kt", 3, 3],
    ["Baz.kt line 7", "Baz.kt", 7, 7],
  ]);
  for (const r of refs) expect(text.slice(r.index, r.index + r.text.length)).toBe(r.text);
  expect(messageRefs("```ts\nconst a = 1;\n```")).toEqual([]);
});

test("a reference links to the branch's file, else the tip's; a name two files have links to both; none while the files are not known", () => {
  const branch = fileIndex(["src/routes.ts", "src/admin/routes.ts", "src/server.ts"]);
  const tree = fileIndex(["src/routes.ts", "src/admin/routes.ts", "src/server.ts", "docs/notes.md"]);
  const [server, routes, notes, gone] = messageRefs("src/server.ts:3-4, routes.ts:12, docs/notes.md and Nope.kt:1");
  expect(targetsOf(server!, branch, tree)).toEqual(["src/server.ts"]);
  expect(targetsOf(routes!, branch, tree)!.sort()).toEqual(["src/admin/routes.ts", "src/routes.ts"]);
  expect(targetsOf(notes!, branch, tree)).toEqual(["docs/notes.md"]);
  expect(targetsOf(notes!, branch, null)).toBeNull();
  expect(targetsOf(gone!, branch, tree)).toEqual([]);
  expect(targetsOf(server!, null, tree)).toBeNull();
  const c = { id: 7, body: "src/server.ts:3-4 and Nope.kt:1" } as CommentDto;
  expect(linksOf(c, branch, tree).map((l) => [l.ref.text, l.hit])).toEqual([["src/server.ts:3-4", "fref:7:0"]]);
});

test("the lines are looked for in the message's code first, then its version then, then the tip", () => {
  const vs = [{ number: 1, snapshot: "aaa1111" }, { number: 2, snapshot: "bbb2222" }] as VersionDto[];
  expect(statesOf({ thread: 3, agent: true, snapshot: "bbb2222", version: 2 }, vs, { sha: "ccc3333", label: "now" })).toEqual([
    { sha: "bbb2222", label: "v2", note: "as in the agent's reply on #3 (v2)" },
    { sha: "bbb2222", label: "v2", note: "as in the agent's reply on #3 (v2)" },
    { sha: "ccc3333", label: "now" },
  ]);
  expect(statesOf({ thread: 3, agent: false, snapshot: "ddd4444", version: 1 }, vs, null)[0]).toEqual({ sha: "ddd4444", label: "ddd4444", note: "as in the message on #3 (the code after v1)" });
});
