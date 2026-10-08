import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });

class FakeEventSource extends EventTarget {
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = 1;
  constructor(readonly url: string) {
    super();
    FakeEventSource.last = this;
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(data) }));
  }
}

const realFetch = globalThis.fetch;
const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
  if (url.startsWith("/api/cursors")) return Response.json({ reviewed: { ref: "2", sha: "s2", label: "v2", at: "t" }, viewed: ["a.kt@1..2"] });
  if (url.startsWith("/api/threads")) return Response.json([]);
  return Response.json({ ok: true });
}) as typeof fetch;
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const state = await import("../../web/state.ts");
const { BUILD } = await import("../../src/core/build.ts");
const before = state.reviewId.value;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  state.reviewId.value = null;
  state.startLive();
  state.reviewId.value = before;
  globalThis.fetch = realFetch;
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  if (mine) await GlobalRegistrator.unregister();
});

beforeEach(() => {
  state.reviewId.value = 1;
  state.startLive();
  calls.length = 0;
});

test("a store change fetches only its part of the page", async () => {
  const es = FakeEventSource.last!;
  es.emit("store", { kinds: ["reads"] });
  await tick();
  expect(calls).toEqual(["GET /api/threads"]);

  calls.length = 0;
  const reviewed = state.reviewedCursor.value;
  es.emit("store", { kinds: ["viewed"] });
  await tick();
  expect(calls).toEqual(["GET /api/cursors"]);
  expect([...state.viewedKeys.value]).toEqual(["a.kt@1..2"]);
  expect(state.reviewedCursor.value).toBe(reviewed);

  calls.length = 0;
  es.emit("store", { kinds: ["cursors"] });
  await tick();
  expect(calls).toEqual(["GET /api/cursors"]);
  expect(state.reviewedCursor.value?.label).toBe("v2");

  calls.length = 0;
  es.emit("store", { kinds: ["config"] });
  await tick();
  expect(calls).toEqual(["GET /api/review"]);

  calls.length = 0;
  es.emit("store", { kinds: ["viewed", "cursors", "reads"] });
  await tick();
  expect(calls.sort()).toEqual(["GET /api/cursors", "GET /api/threads"]);
});

test("a hello from a server of another build reloads the page, once for that build", () => {
  const reload = spyOn(location, "reload").mockImplementation(() => {});
  try {
    const es = FakeEventSource.last!;
    es.emit("hello", { build: BUILD });
    expect(reload).not.toHaveBeenCalled();
    es.emit("hello", { build: "next" });
    expect(reload).toHaveBeenCalledTimes(1);
    es.emit("hello", { build: "next" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  } finally {
    reload.mockRestore();
    sessionStorage.removeItem("stet.reloadedFor");
  }
});
