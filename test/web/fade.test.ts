import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register();
afterAll(async () => {
  if (mine) await GlobalRegistrator.unregister();
});

const { crossfade, holdFade, snapshot, stillness } = await import("../../web/lib/fade.ts");

const frames = (n: number) => new Promise((r) => setTimeout(r, n * 20));
const layer = () => document.querySelector<HTMLElement>(".view-fade");
const fading = () => layer()?.style.opacity === "0";
const realMatch = window.matchMedia;
let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `<div class="pane"><div class="codeview-host" id="h"><p data-file="a.kt">line</p></div></div>`;
  root = document.querySelector(".pane")!;
  root.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
});

afterEach(() => {
  window.matchMedia = realMatch;
  layer()?.remove();
  window.dispatchEvent(new KeyboardEvent("keydown"));
});

const reduce = () => {
  window.matchMedia = ((q: string) => ({ matches: /reduced-motion/.test(q), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
};

describe("fades over a change of view", () => {
  test("a copy of the view lies over it, takes no input and does not pass for it; the first key takes it away", () => {
    snapshot(new DOMRect(0, 0, 400, 300), [root]);
    const l = layer()!;
    expect(l.inert && l.getAttribute("aria-hidden")).toBe("true");
    expect(l.shadowRoot?.textContent).toBe("line");
    expect(document.querySelectorAll("[data-file], #h, .codeview-host").length).toBe(2);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    expect(layer()).toBeNull();
  });

  test("with reduced motion there is no copy: the view changes at once", () => {
    reduce();
    crossfade(root, ".codeview-host");
    snapshot(new DOMRect(0, 0, 400, 300), [root]);
    expect(layer()).toBeNull();
  });

  test("a change set off while the copy waits joins it: one copy, faded once every part says its view is in place", () => {
    const a = snapshot(new DOMRect(0, 0, 400, 300), [root]);
    const b = snapshot(new DOMRect(0, 0, 400, 300), [root]);
    const free = holdFade();
    expect(document.querySelectorAll(".view-fade").length).toBe(1);
    a.go();
    b.go();
    expect(fading()).toBe(false);
    free();
    expect(fading()).toBe(true);
  });

  test("a copy that has started to fade is not joined: the next change gets its own", () => {
    snapshot(new DOMRect(0, 0, 400, 300), [root]).go();
    const first = layer();
    snapshot(new DOMRect(0, 0, 400, 300), [root]);
    expect(document.querySelectorAll(".view-fade").length).toBe(1);
    expect(layer()).not.toBe(first);
    expect(fading()).toBe(false);
  });

  test("the view counts as in place once it is there and its scrolling boxes held still for a few frames", async () => {
    let ready = false;
    crossfade(root, ".codeview-host", () => ready);
    await frames(10);
    expect(fading()).toBe(false);
    ready = true;
    await frames(10);
    expect(fading()).toBe(true);
  });

  test("stillness: the same state for the given number of frames in a row", () => {
    const still = stillness(2);
    expect(["a", "a", "b", "b", "b", "c"].map(still)).toEqual([false, false, false, false, true, false]);
  });
});
