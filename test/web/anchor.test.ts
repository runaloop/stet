import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register();
afterAll(async () => {
  if (mine) await GlobalRegistrator.unregister();
});

const { filesBox, pin, placeAt } = await import("../../web/views/anchor.ts");
const { snapshot } = await import("../../web/lib/fade.ts");

const frames = (n: number) => new Promise((r) => setTimeout(r, n * 20));
const fading = () => document.querySelector<HTMLElement>(".view-fade")?.style.opacity === "0";

// the browser calls observers in the order they were made, after layout and before the paint
const observers: FakeObserver[] = [];
class FakeObserver {
  readonly watched = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.watched.add(el);
  }
  unobserve(el: Element) {
    this.watched.delete(el);
  }
  disconnect() {
    this.watched.clear();
  }
}
const resized = (el: Element) => {
  for (const o of observers) if (o.watched.has(el)) o.callback([], o as unknown as ResizeObserver);
};
const realObserver = globalThis.ResizeObserver;

let scroller: HTMLElement;
let box: HTMLElement;
let row: HTMLElement;
// how far the row is from the top of the content: what grows above it adds to it
let rowTop = 0;

beforeEach(() => {
  globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
  observers.length = 0;
  document.body.innerHTML = `<div class="codeview-host"><div><div class="box"><diffs-container></diffs-container></div></div></div>`;
  scroller = document.querySelector(".codeview-host")!;
  box = document.querySelector(".box")!;
  const host = document.querySelector("diffs-container")!;
  row = document.createElement("div");
  host.attachShadow({ mode: "open" }).append(row);
  rowTop = 900;
  scroller.scrollTop = 600;
  scroller.getBoundingClientRect = () => new DOMRect(0, 100, 800, 600);
  row.getBoundingClientRect = () => new DOMRect(0, 100 + rowTop - scroller.scrollTop, 800, 20);
});

afterEach(() => {
  globalThis.ResizeObserver = realObserver;
  window.dispatchEvent(new KeyboardEvent("keydown"));
});

const rowOnScreen = () => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;

describe("a place a jump went to is kept while the files around it lay out", () => {
  test("pierre's box of the drawn files is found from a row inside a file's shadow root, and from what a file shows in its light DOM", () => {
    const shown = document.createElement("p");
    document.querySelector("diffs-container")!.append(shown);
    expect(filesBox(scroller, row)).toBe(box);
    expect(filesBox(scroller, shown)).toBe(box);
    expect(filesBox(scroller, document.body)).toBeNull();
  });

  test("pin keeps the row where it stood still: a file above it that grows is made up for, in the same frame", async () => {
    pin(scroller, () => row);
    await frames(8);
    expect(rowOnScreen()).toBe(300);
    rowTop += 450;
    resized(box);
    expect(rowOnScreen()).toBe(300);
    expect(scroller.scrollTop).toBe(1050);
  });

  test("pin lets go of a copy of the old view once the row stands still, and keeps the row in place after that", async () => {
    const fade = snapshot(new DOMRect(0, 0, 800, 600), [scroller]);
    pin(scroller, () => row);
    fade.go();
    expect(fading()).toBe(false);
    await frames(8);
    expect(fading()).toBe(true);
    rowTop += 450;
    resized(box);
    expect(rowOnScreen()).toBe(300);
  });

  test("the reader's first key lets go of it: what grows then moves the row", async () => {
    pin(scroller, () => row);
    await frames(8);
    window.dispatchEvent(new KeyboardEvent("keydown"));
    rowTop += 450;
    resized(box);
    expect(rowOnScreen()).toBe(750);
  });

  test("placeAt puts a block where it is asked and keeps it there; the next placement takes over", async () => {
    let told = false;
    placeAt(scroller, () => row, 200, 1500, () => (told = true));
    await frames(8);
    expect(rowOnScreen()).toBe(200);
    expect(told).toBe(true);
    rowTop -= 120;
    resized(box);
    expect(rowOnScreen()).toBe(200);
    pin(scroller, () => null);
    rowTop += 300;
    resized(box);
    expect(rowOnScreen()).toBe(500);
  });
});
