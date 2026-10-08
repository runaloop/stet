import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { thread } from "../helpers/threads.ts";

GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
const state = await import("../../web/state.ts");
await import("../../web/modules.tsx");
const before = state.status.value;
const threadsBefore = state.threads.value;

afterAll(async () => {
  state.status.value = before;
  state.threads.value = threadsBefore;
  state.modulePresets.value = [];
  await GlobalRegistrator.unregister();
});

const settings = (config: Record<string, string>) => {
  state.status.value = { review: { source: "worktree", baseRef: "main" }, versions: 1, versionsList: [], ui: { config, modules: [] } } as never;
};
const tree = () => state.groups.value.map((g) => g.path);

describe("the order of files on the page", () => {
  state.threads.value = ["README.md", "src/a.test.ts", "src/b.ts", "web/c.ts"].map((path, i) => thread({ id: i + 1, path }));

  test("kinds, unset and an id the page does not know give the same default order", () => {
    settings({});
    expect(tree()).toEqual(["src/b.ts", "web/c.ts", "src/a.test.ts", "README.md"]);
    settings({ "compare.order": "kinds" });
    expect(tree()).toEqual(["src/b.ts", "web/c.ts", "src/a.test.ts", "README.md"]);
    settings({ "compare.order": "by-path" });
    expect(tree()).toEqual(["src/b.ts", "web/c.ts", "src/a.test.ts", "README.md"]);
    settings({ "compare.order": "docs: **/*.md; code" });
    expect(tree()).toEqual(["README.md", "src/a.test.ts", "src/b.ts", "web/c.ts"]);
  });

  test("a preset a module's web part brings sorts the files as it does in the CLI", () => {
    settings({ "compare.order": "web-first" });
    expect(tree()).toEqual(["src/b.ts", "web/c.ts", "src/a.test.ts", "README.md"]);
    state.modulePresets.value = [{ id: "web-first", label: "Web first", describe: "the page's files first", groups: "web: web/**; code" }];
    expect(tree()).toEqual(["web/c.ts", "README.md", "src/a.test.ts", "src/b.ts"]);
  });
});
