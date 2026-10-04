import { join } from "node:path";
import { Demo, withBrowser } from "./lib.ts";

const APP = "app/src/main/java/shop";

export async function liveGuide() {
  const demo = new Demo();
  try {
    demo.write(`${APP}/Cart.kt`, "package shop\n\nclass Cart {\n    val items = mutableListOf<Item>()\n}\n");
    demo.write("app/src/main/res/values/strings.xml", '<resources>\n    <string name="app_name">Shop</string>\n</resources>\n');
    demo.commitBase();
    const remote = join(demo.repo, ".git", "origin.git");
    demo.git("init", "-q", "--bare", remote);
    demo.git("remote", "add", "origin", remote);
    demo.git("push", "-q", "origin", "main");
    demo.write(`${APP}/Cart.kt`, "package shop\n\nclass Cart(private val cache: PriceCache) {\n    val items = mutableListOf<Item>()\n}\n");
    demo.git("commit", "-qam", "cart takes a price cache");
    demo.git("push", "-q", "-u", "origin", "feature");
    demo.write(`${APP}/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi) {\n    fun price(sku: Sku): Money = api.fetch(sku)\n}\n");
    demo.git("add", "-A");
    demo.git("commit", "-qm", "price cache");
    demo.write("app/src/main/res/values/strings.xml", '<resources>\n    <string name="app_name">Shop</string>\n    <string name="price_stale">Price may have changed</string>\n</resources>\n');
    demo.git("add", "app/src/main/res/values/strings.xml");
    demo.write(`${APP}/Cart.kt`, "package shop\n\nclass Cart(private val cache: PriceCache) {\n    val items = mutableListOf<Item>()\n\n    fun total(): Money = items.sumOf { cache.price(it.sku) }\n}\n");
    demo.write(`${APP}/sync/PriceSync.kt`, "package shop.sync\n\nclass PriceSync(private val cache: PriceCache) : CoroutineWorker() {\n    override suspend fun doWork() = Result.success()\n}\n");
    demo.stet("version", "create", "--label", "price cache");

    await withBrowser(demo, async (p) => {
      await p.go("#/compare/base..1");
      await p.waitFor(`/↑1/.test(document.querySelector(".gitchip")?.textContent ?? "") && document.querySelectorAll(".file-row .gmark").length >= 3`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      demo.write(`${APP}/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi) {\n    private val cached = mutableMapOf<Sku, Money>()\n\n    fun price(sku: Sku): Money = cached.getOrPut(sku) { api.fetch(sku) }\n}\n");
      await p.waitFor(`document.querySelector("header .refresh.moved")`, 15000);
      await p.sleep(600);
      const chip = await p.need(".gitchip");
      const moved = await p.need("header .refresh.moved");
      const list = await p.need(".file-list");
      const last = await p.eval(`(() => { const r = [...document.querySelectorAll(".file-row")].pop().getBoundingClientRect(); return Math.round(r.bottom); })()`);
      const marks = await p.need(".file-row .gmark", "not staged");
      const ring = { x: marks.x - 6, y: list.y + 26, w: list.x + list.w - marks.x - 6, h: last - list.y - 26 };
      const head = await p.need(".file-meta .gmark");
      await p.shot("live-1.png", [
        { html: "Where the branch is in git: 1 commit not pushed to origin/feature, 1 file staged, 2 not staged, 1 new. A click (or Space g s) lists them", at: { x: 24, y: last + 60 }, to: { x: chip.x + 30, y: chip.y + chip.h + 4 }, ring: chip, w: 400 },
        { html: "The agent changed a file after the page read “now”. Nothing redraws by itself: R (or a click) re-reads it", at: { x: moved.x + 520, y: moved.y + 56 }, to: { x: moved.x + moved.w + 4, y: moved.y + moved.h / 2 + 4 }, ring: moved, w: 360 },
        { html: "Each file says what git has of it: not staged, staged, new, ↑ changed by commits not pushed", at: { x: 24, y: last + 220 }, to: { x: ring.x + ring.w / 2, y: ring.y + ring.h + 6 }, ring, w: 400 },
        { html: "And so does the file's header in the diff", at: { x: head.x - 240, y: head.y - 140 }, to: { x: head.x + head.w / 2, y: head.y - 6 }, ring: head, w: 240 },
      ]);
      await p.click(chip);
      await p.waitFor(`document.querySelector(".git-panel")`);
      await p.sleep(400);
      const panel = await p.need(".git-panel");
      await p.shot("live-2.png", [
        { html: "Commits no remote has, then files staged, not staged and new; a file of the diff on screen is a link to it", at: { x: 24, y: panel.y + panel.h + 50 }, to: { x: panel.x + 120, y: panel.y + panel.h + 6 }, ring: panel, w: 360 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
