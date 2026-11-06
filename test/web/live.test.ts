import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { getToken, setToken, subscribe, type Live } from "../../web/api.ts";

const mine = !GlobalRegistrator.isRegistered;
if (mine) GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static last: FakeWebSocket | null = null;
  readyState = 1;
  constructor(readonly url: string | URL) {
    super();
    FakeWebSocket.last = this;
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
  disconnect() {
    this.close();
    this.dispatchEvent(new Event("close"));
  }
  emit(event: string, data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ event, data }) }));
  }
}

const realFetch = globalThis.fetch;
const realWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? "GET"} ${url.split("?")[0]}`);
  if (url.startsWith("/api/cursors")) return Response.json({ reviewed: { ref: "2", sha: "s2", label: "v2", at: "t" }, viewed: ["a.kt@1..2"] });
  if (url.startsWith("/api/threads")) return Response.json([]);
  return Response.json({ ok: true });
}) as typeof fetch;
(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;

const state = await import("../../web/state.ts");
const { BUILD } = await import("../../src/core/build.ts");
const before = state.reviewId.value;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

afterAll(async () => {
  state.reviewId.value = null;
  state.startLive();
  state.reviewId.value = before;
  globalThis.fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  if (mine) await GlobalRegistrator.unregister();
});

beforeEach(() => {
  state.reviewId.value = 1;
  state.startLive();
  calls.length = 0;
});

test("a store change fetches only its part of the page", async () => {
  const es = FakeWebSocket.last!;
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
    const es = FakeWebSocket.last!;
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

test("a broken socket resumes after the last event, reports a long outage and stops retrying when unsubscribed", async () => {
  const connections: boolean[] = [];
  const changes: number[] = [];
  const live: Live = { hello() {}, store() {}, now() {}, git() {}, change: (seq) => changes.push(seq), connection: (up) => connections.push(up) };
  const before = getToken();
  setToken("test-token");
  const stop = subscribe(17, 5, live);
  try {
    const first = FakeWebSocket.last!;
    expect(String(first.url)).toBe("ws://127.0.0.1:4000/api/events?token=test-token&review=17&since=5");
    first.emit("change", { seq: 9, events: [] });
    first.disconnect();
    await tick(1100);
    const second = FakeWebSocket.last!;
    expect(second).not.toBe(first);
    expect(new URL(second.url).searchParams.get("since")).toBe("9");
    first.emit("change", { seq: 100, events: [] });
    expect(changes).toEqual([9]);
    await tick(2100);
    expect(connections).toEqual([false]);
    second.dispatchEvent(new Event("open"));
    expect(connections).toEqual([false, true]);
    second.emit("change", { seq: 10, events: [] });
    expect(changes).toEqual([9, 10]);
    second.disconnect();
    stop();
    await tick(1100);
    expect(FakeWebSocket.last).toBe(second);
    expect(second.readyState).toBe(FakeWebSocket.CLOSED);
  } finally {
    stop();
    setToken(before);
  }
});

test("a short reconnect refreshes store state even before the offline banner would appear", async () => {
  const connections: boolean[] = [];
  const stop = subscribe(1, 0, { hello() {}, store() {}, now() {}, git() {}, change() {}, connection: (up) => connections.push(up) });
  try {
    const first = FakeWebSocket.last!;
    first.dispatchEvent(new Event("open"));
    expect(connections).toEqual([]);
    first.disconnect();
    await tick(1100);
    FakeWebSocket.last!.dispatchEvent(new Event("open"));
    expect(connections).toEqual([true]);
  } finally {
    stop();
  }
});
