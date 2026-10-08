import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FileDiffMetadata } from "@pierre/diffs";
import { afterAll, expect } from "bun:test";
import type { ThreadDetail, TimelineStepDto } from "../../src/core/types.ts";
import { forModule } from "../../test/helpers/modules.ts";
import { thread } from "../../test/helpers/threads.ts";

const { describe, test } = forModule("images");

GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
const { render } = await import("preact");
const state = await import("../../web/state.ts");
const { bindings } = await import("../../web/keys.ts");
const registry = await import("../../web/modules.tsx");
const before = state.status.value;
const hosts: HTMLElement[] = [];

afterAll(async () => {
  for (const host of hosts) render(null, host);
  state.status.value = before;
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

describe("the images module on the page", () => {
  const switched = (on: boolean) => {
    state.status.value = { review: { source: "worktree", baseRef: "main" }, versions: 1, versionsList: [], ui: { config: {}, modules: on ? ["images"] : [] } } as never;
  };
  const png = { name: "res/card.png", hunks: [] } as unknown as FileDiffMetadata;
  const svg = { name: "res/icon.svg", hunks: [{}] } as unknown as FileDiffMetadata;
  const region = { x: 10, y: 5, w: 50, h: 75, iw: 120, ih: 80 };
  const step = { index: 0, label: "v1", sha: "s1", path: "res/card.png", state: "ok", method: null } as unknown as TimelineStepDto;
  const detail = { thread: { id: 1, path: "res/card.png", region }, timeline: [step] } as unknown as ThreadDetail;
  const drawn = (node: preact.VNode | null) => {
    const host = document.createElement("div");
    hosts.push(host);
    render(node, host);
    return host;
  };
  const zoomKeys = () => bindings().filter((b) => ["+", "=", "-", "0"].includes(b.keys));

  test("on: it draws pictures, fills the slots and brings the zoom keys", () => {
    switched(true);
    expect(registry.viewerFor(png, [], undefined)?.kind).toBe("image");
    expect(registry.viewerFor(svg, [], undefined)?.kind).toBe("image");
    expect(registry.isPicture(png.name)).toBe(true);
    expect(registry.isSwitchable(svg.name)).toBe(true);
    expect(registry.fileTag(png)).toBe("image");
    expect(drawn(registry.headerControl(svg.name)).querySelector(".img-svg-toggle")).not.toBeNull();
    expect(drawn(<registry.StepThumb sha="s1" path={png.name} region={region} />).querySelector(".img-step-thumb .img-crop")).not.toBeNull();
    expect(drawn(<registry.ThreadArea d={detail} from={step} to={step} />).querySelector(".img-area .img-crop")).not.toBeNull();
    expect(zoomKeys().map((b) => `${b.where} ${b.keys}`)).toEqual(["compare +", "compare =", "compare -", "compare 0", "thread +", "thread =", "thread -", "thread 0"]);
  });

  test("off in the repository: lines instead of pictures, the core's fallbacks, no zoom keys", () => {
    switched(false);
    expect(registry.viewerFor(png, [], undefined)).toBeNull();
    expect(registry.viewerFor(svg, [], "picture")).toBeNull();
    expect(registry.isPicture(png.name)).toBe(false);
    expect(registry.isSwitchable(svg.name)).toBe(false);
    expect(registry.fileTag(png)).toBeNull();
    expect(registry.headerControl(svg.name)).toBeNull();
    expect(registry.peekView({ path: png.name, sha: "s1", label: "v1", line: 1 } as never, [])).toBeNull();
    const thumb = drawn(<registry.StepThumb sha="s1" path={png.name} region={region} />);
    expect(thumb.querySelector(".img-crop")).toBeNull();
    expect(thumb.textContent).toBe("area 50×75");
    const area = drawn(<registry.ThreadArea d={detail} from={step} to={step} />);
    expect(area.querySelector(".img-area")).toBeNull();
    expect(area.textContent).toContain("a thread on an area of res/card.png: 50×75 at 10,5 of 120×80");
    expect(zoomKeys()).toEqual([]);
  });

  test("a thread on an area: its page has the module's hint while it is on, and none of it while it is off", async () => {
    const { ThreadDetailView } = await import("../../web/views/ThreadDetail.tsx");
    const written = { ...step, kind: "anchor", version: 1, range: { start: 1, end: 1 }, excerpt: null, commentIds: [] };
    const area = { thread: thread({ id: 1, path: png.name, region }), comments: [], events: [], timeline: [written], code: { then: null, now: null, interdiff: null } } as unknown as ThreadDetail;
    state.route.value = { name: "thread", id: 1 };
    state.detail.value = area;
    const page = async () => {
      const host = drawn(<ThreadDetailView id={1} />);
      await new Promise((r) => setTimeout(r, 20));
      return host.querySelector(".code-tabs")!.textContent!;
    };
    switched(true);
    expect(drawn(<registry.AreaHint />).textContent).toContain("new areas are drawn on the Changes page");
    expect(await page()).toContain("a thread on an area of an image");
    switched(false);
    expect(drawn(<registry.AreaHint />).textContent).toBe("");
    expect(await page()).not.toContain("image");
  });

  test("Esc and another range drop an area drawn for a comment, as they drop one on lines", async () => {
    const { imagePending } = await import("./state.ts");
    imagePending.value = { file: png.name, path: png.name, side: "new", sha: "s1", label: "v1", region };
    registry.cancelModules();
    expect(imagePending.value).toBeNull();
  });
});
