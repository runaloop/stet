import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BlameDto } from "../../src/core/types.ts";

const realFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://127.0.0.1:4000/" });
(globalThis as { __STET_NO_WORKERS?: boolean }).__STET_NO_WORKERS = true;

const run = (start: number, end: number, origin: BlameDto["runs"][number]["origin"], extra: Partial<BlameDto["runs"][number]> = {}) => ({
  start,
  end,
  origin,
  round: null,
  threads: [],
  source: origin.kind === "base" ? null : { path: "docs/a.md", start, end },
  ...extra,
});

const BLAME: BlameDto = {
  path: "docs/a.md",
  at: { ref: "3", sha: "s3", label: "v3" },
  range: { start: 4, end: 12 },
  runs: [
    run(4, 4, { kind: "base", version: null, label: null, createdAt: null }),
    run(5, 7, { kind: "version", version: 3, label: "fixes", createdAt: "2026-10-05T00:00:00Z" }, {
      round: { index: 1, at: "2026-10-04T00:00:00Z", verdict: "changes", version: 2 },
      source: { path: "docs/a.md", start: 6, end: 8 },
      threads: [{ id: 12, title: "cache invalidation on logout", status: "open", match: "file", reply: { id: 40, intent: "fixed", body: "Done.", at: "2026-10-05T00:00:00Z" } }],
    }),
    run(8, 8, { kind: "version", version: 1, label: null, createdAt: "2026-10-01T00:00:00Z" }),
    run(9, 12, { kind: "now", version: null, label: null, createdAt: null }, {
      round: { index: 2, at: "2026-10-05T01:00:00Z", verdict: "changes", version: 3 },
      threads: [{ id: 6, title: "Is the table in sync?", status: "open", match: "named", reply: { id: 41, intent: "answered", body: "Same.", at: "2026-10-05T02:00:00Z" } }],
    }),
  ],
};

const asked: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith("/api/blame")) {
    asked.push(url);
    return Response.json(BLAME);
  }
  return Response.json({ ok: true });
}) as typeof fetch;

const { render } = await import("preact");
const state = await import("../../web/state.ts");
const { BlamePop, blamePop, blameTargets, openBlame } = await import("../../web/components/Blame.tsx");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const press = (key: string, code = "") => window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));

beforeAll(() => {
  state.reviewId.value = 1;
  state.status.value = { versionsList: [{ number: 1 }, { number: 2 }, { number: 3 }] } as never;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
  globalThis.fetch = realFetch;
});

describe("blame popover", () => {
  test("the links of a run: its version's compare on its lines, then its threads", () => {
    const t = blameTargets(BLAME, 3);
    expect(t[0]).toEqual([]);
    expect(t[1]).toEqual([
      { kind: "version", route: { name: "compare", from: "2", to: "3", file: "docs/a.md", line: 6, end: 8 } },
      { kind: "thread", route: { name: "thread", id: 12 } },
    ]);
    expect(t[2]![0]!.route).toEqual({ name: "compare", from: "base", to: "1", file: "docs/a.md", line: 8 });
    expect(t[3]![0]!.route).toEqual({ name: "compare", from: "3", to: "now", file: "docs/a.md", line: 9, end: 12 });
  });

  test("shows each run with its version, round and threads, and Enter follows the first thread", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<BlamePop />, host);
    openBlame({ path: "docs/a.md", start: 4, end: 12, at: "3", label: "v3", place: () => null });
    await tick();
    expect(asked[0]).toBe("/api/blame?review=1&path=docs%2Fa.md&from=4&to=12&at=3");
    const pop = host.querySelector(".blame-pop")!;
    expect(pop.querySelector(".blame-head")!.textContent).toBe("docs/a.md:4–12 at v3");
    const rows = [...pop.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "4base",
      "5–7v3 · round 1 · fixed #12 “cache invalidation on logout” (same file)",
      "8v1",
      "9–12now (not in a version yet) · round 2 · answered #6 “Is the table in sync?” (named)",
    ]);
    const links = [...pop.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "#/compare/2..3?file=docs%2Fa.md&line=6-8",
      "#/thread/12",
      "#/compare/base..1?file=docs%2Fa.md&line=8",
      "#/compare/3..now?file=docs%2Fa.md&line=9-12",
      "#/thread/6",
    ]);
    expect(pop.querySelector("a.on")!.getAttribute("href")).toBe("#/thread/12");
    press("j", "KeyJ");
    await tick();
    expect(host.querySelector("a.on")!.getAttribute("href")).toBe("#/compare/base..1?file=docs%2Fa.md&line=8");
    press("k", "KeyK");
    press("k", "KeyK");
    await tick();
    expect(host.querySelector("a.on")!.getAttribute("href")).toBe("#/compare/2..3?file=docs%2Fa.md&line=6-8");
    press("Enter");
    await tick();
    expect(location.hash).toBe("#/compare/2..3?file=docs%2Fa.md&line=6-8");
    expect(blamePop.value).toBeNull();
    render(null, host);
  });

  test("Esc closes it, and so does the cursor moving on", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(<BlamePop />, host);
    openBlame({ path: "docs/a.md", start: 4, end: 4, at: "3", label: "v3", place: () => null });
    await tick();
    expect(host.querySelector(".blame-pop")).not.toBeNull();
    press("Escape");
    await tick();
    expect(host.querySelector(".blame-pop")).toBeNull();
    const { cursor } = await import("../../web/compare.ts");
    openBlame({ path: "docs/a.md", start: 4, end: 4, at: "3", label: "v3", place: () => null });
    await tick();
    cursor.value = { path: "docs/a.md", row: 3 };
    await tick();
    expect(host.querySelector(".blame-pop")).toBeNull();
    render(null, host);
  });

  test("the base answers itself, without asking the server", async () => {
    const before = asked.length;
    openBlame({ path: "docs/a.md", start: 2, end: 3, at: "base", label: "base", place: () => null });
    expect(asked.length).toBe(before);
    expect(blamePop.value!.data!.runs.map((r) => r.origin.kind)).toEqual(["base"]);
    blamePop.value = null;
  });
});
