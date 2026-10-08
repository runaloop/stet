import { afterAll, expect, spyOn, test } from "bun:test";
import { ensureReview, openContext } from "../src/core/context.ts";
import * as snapshot from "../src/core/snapshot.ts";
import { handleApi, type ServerState } from "../src/server/api.ts";
import { Fixture, lines } from "./helpers/fixture.ts";

const f = new Fixture();

afterAll(() => f.cleanup());

test("two first requests at once share one pinned now", async () => {
  f.write("a.kt", lines(5));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(6));
  const ctx = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
  const review = await ensureReview(ctx);
  const state: ServerState = { ctx, defaultReview: review.id, pinnedNow: new Map(), pinning: new Map() };
  const takeNow = snapshot.takeNow;
  // Slow enough that the second request comes while the first one is still taking the snapshot.
  const spy = spyOn(snapshot, "takeNow").mockImplementation(async (...args) => {
    await Bun.sleep(100);
    return takeNow(...args);
  });
  try {
    const get = (path: string) => handleApi(state, new Request(`http://127.0.0.1/api/${path}`), new URL(`http://127.0.0.1/api/${path}`));
    const [threads, status] = await Promise.all([get("threads"), get("review")]);
    expect(threads.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    const pin = state.pinnedNow.get(review.id)!;
    expect(await status.json()).toMatchObject({ pinnedNow: pin.sha, pinnedNowAt: pin.at });
    expect(state.pinning.size).toBe(0);

    const refresh = new Request("http://127.0.0.1/api/now/refresh", { method: "POST" });
    await handleApi(state, refresh, new URL(refresh.url));
    expect(spy).toHaveBeenCalledTimes(2);
  } finally {
    spy.mockRestore();
    ctx.store.close();
  }
});
