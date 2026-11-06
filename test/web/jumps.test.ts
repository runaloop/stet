import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Window } from "happy-dom";
import { parseHash } from "../../src/ui/route.ts";

GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
const dom = window as unknown as Window;
const { cursor, peek } = await import("../../web/compare.ts");
const { navigate, noteJump, ownNavigation, route, selectedStep } = await import("../../web/state.ts");
const { apply, installHistory, jumpBack, jumpForward, leftPage, openPeek, pendingSpot, takeSpot } = await import("../../web/jumps.ts");
const { handleKey } = await import("../../web/keys.ts");

const first = { path: "first.ts", sha: "v1", label: "v1", line: 3, jumped: true as const };
const nested = { path: "nested.ts", sha: "v1", label: "v1", line: 9, jumped: true as const };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
let sequence = 0;
let origin: string;
let thread: string;
let uninstall: () => void;
let changed: () => void;

beforeEach(async () => {
  origin = `#/compare/base..${++sequence}`;
  thread = `#/thread/${sequence}`;
  history.replaceState(null, "", origin);
  history.pushState(null, "", thread);
  await tick();
  route.value = parseHash(thread);
  cursor.value = { path: "thread.ts", row: 4 };
  selectedStep.value = 1;
  peek.value = null;
  pendingSpot.value = null;
  let currentHash = thread;
  // Match main.tsx's listener ordering; ThreadDetail applies its saved spot once mounted.
  changed = () => {
    leftPage(currentHash, ownNavigation(location.hash));
    currentHash = location.hash;
    route.value = parseHash(currentHash);
    const saved = takeSpot(currentHash);
    if (saved) apply(saved);
  };
  window.addEventListener("hashchange", changed);
  uninstall = installHistory();
});

afterEach(async () => {
  uninstall();
  window.removeEventListener("hashchange", changed);
  // apply() schedules scroll restoration; finish those frames before removing the DOM.
  await dom.happyDOM.waitUntilComplete();
});

afterAll(async () => {
  await dom.happyDOM.waitUntilComplete();
  await GlobalRegistrator.unregister();
});

async function traverse(delta: number): Promise<void> {
  history.go(delta);
  await tick();
}

async function leave(own: boolean): Promise<void> {
  if (own) navigate({ name: "compare", from: "base", to: "now" });
  else location.hash = "#/compare/base..now";
  // Happy DOM carries pushState's state into a hash navigation; browsers start a new entry.
  history.replaceState(null, "");
  await tick();
  expect(peek.value).toBeNull();
}

describe("preview history across pages", () => {
  for (const own of [true, false]) {
    test(`${own ? "app" : "manual hash"} navigation returns to a preview whose Escape consumes its browser entry`, async () => {
      openPeek(first);
      await leave(own);
      await traverse(-1);
      expect(location.hash).toBe(thread);
      expect(peek.value).toEqual(first);

      expect(handleKey(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
      await tick();
      expect(peek.value).toBeNull();
      expect(history.state?.stetPeek).toBeUndefined();
      expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
      expect(selectedStep.value).toBe(1);

      await traverse(-1);
      expect(location.hash).toBe(origin);
      await traverse(1);
      expect(location.hash).toBe(thread);
      expect(peek.value).toBeNull();
      await traverse(1);
      expect(peek.value).toEqual(first);
      await traverse(1);
      expect(location.hash).toBe("#/compare/base..now");
      expect(peek.value).toBeNull();
    });
  }

  test("Ctrl+O and close restore nested previews before the original code after a page return", async () => {
    openPeek(first);
    cursor.value = { path: "first.ts", row: 2 };
    openPeek(nested);
    await leave(true);
    await traverse(-1);
    expect(peek.value).toEqual(nested);

    expect(handleKey(new KeyboardEvent("keydown", { key: "o", code: "KeyO", ctrlKey: true }))).toBe(true);
    await tick();
    expect(peek.value).toEqual(first);
    expect(cursor.value).toEqual({ path: "first.ts", row: 2 });
    // The close button invokes jumpBack directly for a jumped preview.
    expect(jumpBack()).toBe(true);
    await tick();
    expect(peek.value).toBeNull();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
    expect(jumpForward()).toBe(true);
    await tick();
    expect(peek.value).toEqual(first);
    expect(jumpForward()).toBe(true);
    await tick();
    expect(peek.value).toEqual(nested);
  });

  test("cursor and search jumps inside a returned preview still precede closing it", async () => {
    openPeek(first);
    cursor.value = { path: "first.ts", row: 2 };
    noteJump();
    cursor.value = { path: "first.ts", row: 8 };
    await leave(true);
    await traverse(-1);
    expect(cursor.value?.row).toBe(8);

    jumpBack();
    expect(peek.value).toEqual(first);
    expect(cursor.value?.row).toBe(2);
    jumpForward();
    expect(peek.value).toEqual(first);
    expect(cursor.value?.row).toBe(8);
    jumpBack();
    jumpBack();
    await tick();
    expect(peek.value).toBeNull();
    expect(history.state?.stetPeek).toBeUndefined();
  });

  test("returning to an older chain and nesting keeps it separate from a newer chain", async () => {
    openPeek(first);
    const firstId = history.state.stetPeekChain;
    await leave(true);
    openPeek({ ...first, path: "other.ts" });
    const otherId = history.state.stetPeekChain;
    expect(otherId).not.toBe(firstId);
    await traverse(-2);
    expect(peek.value).toEqual(first);
    openPeek(nested);
    expect(history.state.stetPeekChain).toBe(firstId);
    await leave(true);
    await traverse(-1);
    jumpBack();
    await tick();
    expect(peek.value).toEqual(first);
    jumpBack();
    await tick();
    expect(peek.value).toBeNull();
    await traverse(-1);
    expect(location.hash).toBe(origin);
  });

  test("skipping a preview restores its underlying entry's cursor and preserves other history state", async () => {
    history.replaceState({ other: "kept" }, "");
    openPeek(first);
    cursor.value = { path: "first.ts", row: 2 };
    await leave(true);
    await traverse(-2);
    expect(location.hash).toBe(thread);
    expect(peek.value).toBeNull();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
    expect(history.state.other).toBe("kept");
    expect(history.state.stetPeek).toBeUndefined();
    await traverse(-1);
    expect(location.hash).toBe(origin);
    await traverse(1);
    expect(peek.value).toBeNull();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
    await traverse(1);
    expect(peek.value).toEqual(first);
    expect(cursor.value).toEqual({ path: "first.ts", row: 2 });
    jumpBack();
    await tick();
    noteJump();
    cursor.value = { path: "thread.ts", row: 40 };
    await leave(true);
    await traverse(-1);
    expect(peek.value).toBeNull();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 40 });
    jumpBack();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
  });

  test("same-hash returns between different preview chains restore cursor jumps and browser close targets", async () => {
    openPeek(first);
    await leave(true);
    navigate({ name: "thread", id: sequence });
    history.replaceState(null, "");
    await tick();
    const second = { ...first, path: "second.ts" };
    openPeek(second);
    cursor.value = { path: "second.ts", row: 10 };
    noteJump();
    cursor.value = { path: "second.ts", row: 20 };

    await traverse(-3);
    expect(location.hash).toBe(thread);
    expect(peek.value).toEqual(first);
    jumpBack();
    await tick();
    expect(peek.value).toBeNull();
    expect(history.state.stetPeek).toBeUndefined();
    await traverse(4);
    expect(peek.value).toEqual(second);
    expect(cursor.value).toEqual({ path: "second.ts", row: 20 });
    jumpBack();
    expect(peek.value).toEqual(second);
    expect(cursor.value).toEqual({ path: "second.ts", row: 10 });
    jumpBack();
    await tick();
    expect(peek.value).toBeNull();
    expect(history.state.stetPeek).toBeUndefined();
    await traverse(-1);
    expect(location.hash).toBe("#/compare/base..now");
  });

  test("a browser preview entry without in-memory metadata remains closable", async () => {
    uninstall();
    history.pushState({ stetPeek: 1, stetPeekChain: 100_000, peek: first }, "", location.href);
    peek.value = first;
    uninstall = installHistory();
    noteJump();
    cursor.value = { path: "first.ts", row: 20 };
    jumpBack();
    expect(cursor.value).toEqual({ path: "thread.ts", row: 4 });
    expect(peek.value).toEqual(first);
    openPeek(nested);
    await leave(true);
    await traverse(-1);
    jumpBack();
    await tick();
    expect(peek.value).toEqual(first);
    jumpBack();
    await tick();
    expect(peek.value).toBeNull();
    expect(history.state?.stetPeek).toBeUndefined();
    await traverse(-1);
    expect(location.hash).toBe(origin);
  });
});
