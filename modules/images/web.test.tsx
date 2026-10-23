import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { FileDiffMetadata } from "@pierre/diffs";
import { afterAll, expect } from "bun:test";
import type { ThreadDetail, TimelineStepDto } from "../../src/core/types.ts";
import { forModule } from "../../test/helpers/modules.ts";
import { thread } from "../../test/helpers/threads.ts";
import { zoomScroll } from "./zoom.ts";

const { describe, test } = forModule("images");

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
const { render } = await import("preact");
const state = await import("../../web/state.ts");
const { webRows } = await import("../../web/keys.ts");
const registry = await import("../../web/modules.tsx");
const { threadLanding } = await import("../../web/views/Compare.tsx");
const { ImagePane } = await import("./ImageView.tsx");
const { Zoom } = await import("./ImageZoom.tsx");
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
  const zoomKeys = () => webRows().filter((r) => r.keys.some((k) => ["+", "=", "-", "0"].includes(k)));

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
    expect(zoomKeys().map((r) => `${r.scope} ${r.keys.join(" ")}`)).toEqual(["changes + =", "changes -", "changes 0", "thread + =", "thread -", "thread 0"]);
    expect(threadLanding(png.name, true)).toBe("file");
  });

  test("a thread's area zooms inside its crop, apart from the whole image", async () => {
    switched(true);
    const host = drawn(<registry.ThreadArea d={detail} from={step} to={step} />);
    const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === text)!;
    const crop = () => host.querySelector<HTMLElement>(".img-area .img-view .img-crop");
    const zoomed = () => host.querySelector(".img-area .img-view")!.classList.contains("zoomed");
    expect(host.querySelector(".code-label .img-zoom-bar")).not.toBeNull();
    expect(zoomed()).toBe(false);
    button("100%").click();
    await new Promise((r) => setTimeout(r, 0));
    // the crop is the region with 16 px around it, inside the 120×80 image: 76 px wide
    expect([zoomed(), crop()!.style.width]).toEqual([true, "76px"]);
    expect(host.querySelector(".code-label .img-zoom-level")!.textContent).toBe("100%");
    button("whole image").click();
    await new Promise((r) => setTimeout(r, 0));
    expect([zoomed(), host.querySelector(".code-label .img-zoom-level")]).toEqual([false, null]);
    button("the area").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(crop()!.style.width).toBe("76px");
    button("fit").click();
    await new Promise((r) => setTimeout(r, 0));
    expect([zoomed(), host.querySelector(".code-label .img-zoom-level")]).toEqual([false, null]);
  });

  test("a frame's tag knows the room on each side of its frame, to keep to the image", () => {
    switched(true);
    const pane = drawn(<ImagePane sha="s1" path={png.name} size={{ w: 120, h: 80, bytes: 1 }} frames={[{ id: 1, region: { ...region, y: 0 }, tone: "thread" }]} />);
    const tag = pane.querySelector<HTMLElement>(".img-frame-tag")!;
    expect(["up", "left", "right", "down"].map((s) => tag.style.getPropertyValue(`--room-${s}`))).toEqual(["0", "0.2", "1.2", "0.06666666666666667"]);
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
    // a thread on an area still lands on its file, which the diff shows without a picture
    expect(threadLanding(png.name, true)).toBe("file");
    expect(threadLanding(svg.name, false)).toBe("lines");
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

describe("the zoom", () => {
  test("zooming keeps the point in place from where the view stands, when it could not scroll as far as asked", () => {
    // a view scrolls no further than its picture allows: here 455 × 22 px
    const view = (maxX: number, maxY: number) => {
      let x = 0;
      let y = 0;
      return {
        get scrollLeft() { return x; },
        set scrollLeft(v: number) { x = Math.min(v, maxX); },
        get scrollTop() { return y; },
        set scrollTop(v: number) { y = Math.min(v, maxY); },
      } as unknown as HTMLElement;
    };
    const zoom = new Zoom();
    zoom.scale.value = 2;
    zoom.set(4, { x: 900, y: 600 }, view(1e6, 1e6));
    const el = view(455, 22);
    zoom.apply(el);
    zoom.set(8, { x: 100, y: 80 }, el);
    const next = view(1e6, 1e6);
    zoom.apply(next);
    expect({ x: next.scrollLeft, y: next.scrollTop }).toEqual(zoomScroll({ x: 455, y: 22 }, { x: 100, y: 80 }, 4, 8));
  });
});
