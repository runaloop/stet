import { Demo, withBrowser, type Rect } from "./lib.ts";

const DIR = "app/src/main/java/shop";

const cart = (body: string) => `package shop

class Cart(private val prices: PriceCache) {
    private val items = mutableListOf<Item>()

    fun add(item: Item) {
        items += item
    }
${body}}
`;
const checkout = (body: string) => `package shop

class Checkout(private val cart: Cart, private val payments: Payments) {
    fun pay(card: Card): Receipt {
${body}    }
}
`;
const cache = (body: string) => `package shop

class PriceCache(private val api: PriceApi, private val clock: Clock) {
${body}}
`;

export async function viewedGuide() {
  const demo = new Demo();
  try {
    demo.write(`${DIR}/Cart.kt`, cart(""));
    demo.write(`${DIR}/Checkout.kt`, checkout("        return payments.charge(card, Money.ZERO)\n"));
    demo.write(`${DIR}/PriceCache.kt`, cache("    fun price(sku: Sku): Money = api.fetch(sku)\n"));
    demo.commitBase();
    const remove = "\n    fun remove(item: Item) {\n        items -= item\n    }\n";
    demo.write(`${DIR}/Cart.kt`, cart(`${remove}\n    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.price(item.sku) }\n`));
    demo.write(`${DIR}/Checkout.kt`, checkout("        val total = cart.total()\n        return payments.charge(card, total)\n"));
    demo.write(`${DIR}/PriceCache.kt`, cache("    private val entries = HashMap<Sku, Entry>()\n\n    fun price(sku: Sku): Money = entries[sku]?.takeIf { clock.elapsed() - it.at < TTL }?.money ?: fetch(sku)\n"));
    demo.git("commit", "-qam", "cart total, checkout, price cache");
    demo.stet("version", "create", "--label", "cart total, checkout, price cache");

    await withBrowser(demo, async (p) => {
      // `what` picks the file's header in its shadow root, or its "viewed" box in the light DOM
      const onHeader = async (name: string, what: "header" | "viewed"): Promise<Rect> => {
        const pick = what === "header" ? "h" : `c.querySelector(".hdr-meta .viewed")`;
        const r = (await p.eval(`(() => { for (const c of document.querySelectorAll(".codeview-host diffs-container")) { const h = c.shadowRoot.querySelector("[data-diffs-header]"); if (!h?.querySelector("[data-title]")?.textContent.endsWith(${JSON.stringify(`/${name}`)})) continue; const b = ${pick}?.getBoundingClientRect(); return b ? { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } : null; } return null; })()`)) as Rect | null;
        if (!r) throw new Error(`no ${what} on the header of ${name}`);
        return r;
      };
      const row = (name: string) => p.need(".file-row", name);
      const tickInList = async (name: string) => {
        await p.eval(`[...document.querySelectorAll(".file-row")].find(r => r.textContent.includes(${JSON.stringify(name)})).querySelector("input").click(); true`);
        await p.sleep(500);
      };
      const tickOnHead = async (name: string) => {
        await p.click(await onHeader(name, "viewed"));
        await p.sleep(500);
      };
      const filesTab = async () => {
        await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
        await p.waitFor(`document.querySelector(".file-list .side-head")`);
      };
      const hideToast = () => p.eval(`document.querySelector(".toast")?.remove(); true`);

      await p.go("#/compare/base..1");
      await p.waitFor(`document.querySelectorAll(".codeview-host diffs-container").length === 3`, 15000);
      await filesTab();
      await p.sleep(1200);
      await tickInList("Cart.kt");
      await tickOnHead("Checkout.kt");
      await p.sleep(600);
      const cartRow = await row("Cart.kt");
      const cacheBox = await onHeader("PriceCache.kt", "viewed");
      const counter = await p.need(".file-list .side-head");
      const folded = await onHeader("Cart.kt", "header");
      const done = await p.need(".compare-head .btn", "Done up to");
      await p.shot("viewed-1.png", [
        { html: "Tick a file <b>viewed</b> in the Files tab…", at: { x: 40, y: cartRow.y + 130 }, to: { x: cartRow.x + 22, y: cartRow.y + cartRow.h + 2 }, ring: cartRow, w: 280 },
        { html: "…or on its header in the diff. No key does it", at: { x: cacheBox.x - 380, y: cacheBox.y + 250 }, to: { x: cacheBox.x + cacheBox.w / 2, y: cacheBox.y + cacheBox.h + 2 }, ring: cacheBox, w: 330 },
        { html: "A viewed file folds to its header. <b>▸</b> or <b>za</b> opens it, and it stays viewed", at: { x: folded.x + 380, y: folded.y + 60 }, to: { x: folded.x + 300, y: folded.y + folded.h - 2 }, ring: folded, w: 340 },
        { html: "How many files of the diff are viewed (folded test files count too)", at: { x: 350, y: counter.y + 140 }, to: { x: counter.x + 420, y: counter.y + counter.h + 2 }, ring: counter, w: 220 },
        { html: "<b>✓ Done up to v1</b> remembers your pass; ticking the last file does it for you", at: { x: done.x + done.w + 300, y: done.y + 40 }, to: { x: done.x + done.w + 4, y: done.y + done.h / 2 }, ring: done, w: 360 },
      ]);

      await tickOnHead("PriceCache.kt");
      await p.waitFor(`document.querySelector(".reviewed-mark")`);
      await p.sleep(400);
      const mark = await p.need(".reviewed-mark");
      const toast = await p.need(".toast");
      const pass = await p.need(".vstep .vlabel .seen");
      await p.shot("viewed-2.png", [
        { html: "The last file is ticked, so the pass is remembered: you went through the code up to v1", at: { x: mark.x + mark.w + 300, y: mark.y + 40 }, to: { x: mark.x + mark.w + 4, y: mark.y + mark.h / 2 }, ring: mark, w: 360 },
        { html: "The ✓ on the strip marks your last pass", at: { x: 220, y: pass.y + 130 }, to: { x: pass.x + pass.w / 2, y: pass.y + pass.h + 4 }, ring: pass, w: 280 },
        { html: "Next time <b>v</b> (on this page <b>Space r v</b>) opens what changed after it", at: { x: toast.x - 120, y: toast.y - 130 }, to: { x: toast.x + toast.w / 2, y: toast.y - 4 }, ring: toast, w: 340 },
      ]);
      await hideToast();

      demo.write(`${DIR}/Cart.kt`, cart(`${remove}\n    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.price(item.sku) * item.count }\n`));
      demo.git("commit", "-qam", "review: total counts every copy");
      demo.stet("version", "create", "--label", "review: total counts every copy");
      await p.waitFor(`[...document.querySelectorAll(".vstep .vlabel")].some(l => l.textContent.startsWith("v2"))`, 15000);
      await p.go("#/compare/base..2");
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("The whole branch (base → v2)") && document.querySelectorAll(".codeview-host diffs-container").length === 3`, 15000);
      await p.sleep(1500);
      const changed = await onHeader("Cart.kt", "header");
      const changedRow = await row("Cart.kt");
      const still = await onHeader("Checkout.kt", "header");
      const since = await p.need(".presets .chip", "since I last looked");
      const news = await p.need(".banner");
      await p.shot("viewed-3.png", [
        { html: "The agent handed over v2 and changed Cart.kt in it", at: { x: news.x + 640, y: news.y + 4 }, to: { x: news.x + 590, y: news.y + news.h / 2 }, w: 520 },
        { html: "Its content is new, so it is not viewed any more and opens again. Nothing marks it as changed since you viewed it", at: { x: 40, y: changedRow.y + 230 }, to: { x: changed.x - 8, y: changed.y + changed.h / 2 }, ring: changed, w: 400 },
        { html: "Its tick is gone in the Files tab too: 2/3 viewed", at: { x: 40, y: changedRow.y + 110 }, to: { x: changedRow.x + 22, y: changedRow.y + changedRow.h + 2 }, ring: changedRow, w: 300 },
        { html: "A file whose content did not change stays viewed and folded, in any range that ends at the same code", at: { x: 40, y: still.y - 30 }, to: { x: still.x - 8, y: still.y + still.h / 2 }, ring: still, w: 400 },
        { html: "<b>since I last looked</b>: from your last pass (v1) to the newest code", at: { x: since.x + 360, y: since.y - 34 }, to: { x: since.x + since.w / 2 + 20, y: since.y - 2 }, ring: since, w: 420 },
      ]);

      await p.keys(" ", "r", "v");
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("Since you last looked")`, 15000);
      await p.sleep(1500);
      const title = await p.need(".range-title");
      const doneTo = await p.need(".compare-head .btn", "Done up to");
      const strip = await p.need(".vstrip");
      await p.shot("viewed-4.png", [
        { html: "<b>Space r v</b> (<b>v</b> on other pages): what changed after your last pass, v1 → v2", at: { x: title.x + title.w + 40, y: title.y - 52 }, to: { x: title.x + title.w - 30, y: title.y - 2 }, ring: title, w: 700 },
        { html: "Only Cart.kt changed in v2. Tick it, or press this button, and the pass moves to v2", at: { x: 1300, y: doneTo.y + 14 }, to: { x: doneTo.x + doneTo.w + 4, y: doneTo.y + doneTo.h / 2 }, ring: doneTo, w: 420 },
        { html: "The strip shows the same range: from your pass (✓) to the newest version", at: { x: 40, y: strip.y + 200 }, to: { x: strip.x - 6, y: strip.y + strip.h / 2 }, ring: strip, w: 300 },
      ]);

      await p.go("#/overview");
      await p.waitFor(`document.querySelector(".round li.todo")`, 15000);
      await p.sleep(800);
      const step = await p.need(".round li.todo");
      await p.shot("viewed-5.png", [
        { html: "The Round page says the same: the code changed after your last pass, and the link opens it", at: { x: step.x + 260, y: step.y + step.h + 90 }, to: { x: step.x + 220, y: step.y + step.h + 4 }, ring: step, w: 400 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
