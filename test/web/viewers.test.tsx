import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FileDiffMetadata } from "@pierre/diffs";
import { afterAll, describe, expect, test } from "bun:test";

GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
const { render } = await import("preact");
const state = await import("../../web/state.ts");
const compare = await import("../../web/compare.ts");
const registry = await import("../../web/modules.tsx");
const { threadLanding, viewerOf } = await import("../../web/views/Compare.tsx");
const before = state.status.value;
const hosts: HTMLElement[] = [];

afterAll(async () => {
  for (const host of hosts) render(null, host);
  state.status.value = before;
  compare.fileView.value = new Map();
  compare.drawnFiles.value = new Set();
  await GlobalRegistrator.unregister();
});

const settings = (config: Record<string, string>) => {
  state.status.value = { review: { source: "worktree", baseRef: "main" }, versions: 1, versionsList: [], ui: { config, modules: [] } } as never;
};
const drawn = (node: preact.VNode | null) => {
  const host = document.createElement("div");
  hosts.push(host);
  render(node, host);
  return host;
};

describe("Markdown, a kind of file of the core, through the registry", () => {
  const md = { name: "docs/guide.md", hunks: [{}] } as unknown as FileDiffMetadata;
  const code = { name: "src/a.ts", hunks: [{}] } as unknown as FileDiffMetadata;

  test("the Changes page draws a Markdown file with the Markdown viewer, also with every module off", () => {
    settings({});
    compare.fileView.value = new Map();
    expect(viewerOf(md, [])).toBe("markdown");
    expect(registry.viewerByKind("markdown")?.cssClass).toBe("md-anno");
    expect(viewerOf(code, [])).toBeNull();
    expect(registry.textViewer(md.name)?.kind).toBe("markdown");
    expect(registry.textViewer(code.name)).toBeNull();
    expect(registry.isSwitchable(md.name)).toBe(true);
    expect(registry.isPicture(md.name)).toBe(false);
  });

  test("compare.markdown code shows it as code until the reader switches it", () => {
    settings({ "compare.markdown": "code" });
    compare.fileView.value = new Map();
    expect(viewerOf(md, [])).toBeNull();
    expect(registry.textViewer(md.name)?.text.view()).toBe("code");
    compare.setFileView(md.name, "rendered");
    expect(viewerOf(md, [])).toBe("markdown");
    settings({});
    compare.setFileView(md.name, "code");
    expect(viewerOf(md, [])).toBeNull();
  });

  test("a jump to a thread on its lines lands on the block that holds them while it is drawn rendered", () => {
    compare.drawnFiles.value = new Set([md.name]);
    expect(threadLanding(md.name, false)).toBe("blocks");
    compare.drawnFiles.value = new Set();
    expect(threadLanding(md.name, false)).toBe("lines");
    expect(threadLanding(code.name, false)).toBe("lines");
  });

  test("its file header has the switch between rendered and code; other files have none from it", () => {
    settings({});
    const header = drawn(registry.headerControl(md.name));
    expect(header.querySelector(".md-toggle")?.textContent).toBe("¶ rendered");
    expect(registry.headerControl(code.name)).toBeNull();
  });
});

describe("the modules on", () => {
  test("stay the same list while the same modules are on, so what asks the registry is not made again", () => {
    settings({});
    const was = registry.webModules.value;
    settings({ "compare.markdown": "code" });
    expect(registry.webModules.value).toBe(was);
  });
});
