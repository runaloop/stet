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

export async function navigationGuide() {
  const demo = new Demo();
  try {
    demo.write(`${DIR}/Cart.kt`, cart(""));
    demo.write(`${DIR}/Checkout.kt`, checkout("        return payments.charge(card, Money.ZERO)\n"));
    demo.write(`${DIR}/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi) {\n    fun price(sku: Sku): Money = api.fetch(sku)\n}\n");
    demo.commitBase();
    demo.write(`${DIR}/Cart.kt`, cart("\n    fun remove(item: Item) {\n        items -= item\n    }\n\n    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.price(item.sku) }\n"));
    demo.write(`${DIR}/Checkout.kt`, checkout("        val total = cart.total()\n        return payments.charge(card, total)\n"));
    demo.write(`${DIR}/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi, private val clock: Clock) {\n    private val entries = HashMap<Sku, Entry>()\n\n    fun price(sku: Sku): Money = entries[sku]?.takeIf { clock.elapsed() - it.at < TTL }?.money ?: fetch(sku)\n}\n");
    demo.stet("version", "create", "--label", "cart total, checkout");
    const ask = (file: string, range: string, body: string) =>
      demo.stet("comment", "add", "--file", `${DIR}/${file}`, "--range", range, "--at", "1", "--body", body, "--as", "reviewer").id as number;
    const t1 = ask("Cart.kt", "10-12", "Should remove() drop every copy of the item or just one?");
    const t2 = ask("Checkout.kt", "4-5", "What happens when the total is zero?");
    ask("PriceCache.kt", "6-6", "Where does TTL come from?");
    demo.stet("reply", String(t1), "--intent", "answered", "--body", "Every copy: `items -= item` removes all equal items. A cart shows one row per SKU with a count, so that matches the screen.");
    demo.stet("reply", String(t2), "--intent", "fixed", "--body", "A zero total now skips the charge and returns an empty receipt.");
    demo.write(`${DIR}/Checkout.kt`, checkout("        val total = cart.total()\n        if (total == Money.ZERO) return Receipt.EMPTY\n        return payments.charge(card, total)\n"));
    demo.stet("version", "create", "--label", "review fixes");
    demo.write(`${DIR}/PriceCache.kt`, "package shop\n\nclass PriceCache(private val api: PriceApi, private val clock: Clock) {\n    private val entries = HashMap<Sku, Entry>()\n\n    fun price(sku: Sku): Money = entries[sku]?.takeIf { clock.elapsed() - it.at < TTL }?.money ?: fetch(sku)\n\n    companion object {\n        val TTL = 10.minutes\n    }\n}\n");

    await withBrowser(demo, async (p) => {
      const cursorRow = (): Promise<Rect | null> =>
        p.eval(`(() => { for (const c of document.querySelectorAll(".codeview-host diffs-container")) { const row = c.shadowRoot.querySelector('[data-content] > [data-stet-mark~="cursor"]'); if (row) { const r = row.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } } return null; })()`);

      await p.go("#/compare/1..2");
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("What changed in v2")`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      await p.sleep(1500);
      const fromBtn = await p.need(".vstep.from .vend.on");
      const toBtn = await p.need(".vstep.to .vend.on");
      const v1 = await p.need(".vstep.from .vbody");
      const nowStep = await p.need(".vstep.now .vbody");
      const title = await p.need(".range-title");
      await p.shot("versions-1.png", [
        { html: "<b>from</b>: the old side of the diff, the code as it was at this version. Here v1", at: { x: 40, y: 190 }, to: { x: fromBtn.x + fromBtn.w / 2, y: fromBtn.y + fromBtn.h + 2 }, ring: fromBtn, w: 420 },
        { html: "<b>to</b>: the new side, here v2. So the diff shows what changed from v1 to v2", at: { x: 40, y: 300 }, to: { x: toBtn.x + toBtn.w / 2, y: toBtn.y + toBtn.h + 2 }, ring: toBtn, w: 420 },
        { html: "A click on the version itself shows only what changed in it (v1: base → v1). A drag from one version to another sets both ends", at: { x: 40, y: 410 }, to: { x: v1.x + 20, y: v1.y + v1.h - 2 }, ring: v1, w: 420 },
        { html: "<b>now</b> is the working tree: <b>to</b> here shows the changes not saved as a version yet", at: { x: 40, y: 540 }, to: { x: nowStep.x + nowStep.w / 2, y: nowStep.y + nowStep.h + 22 }, ring: nowStep, w: 420 },
        { html: "The title says what is shown. Keys: <b>]v</b> <b>[v</b> move <b>to</b>, <b>}</b> <b>{</b> move <b>from</b>", at: { x: title.x + title.w + 180, y: title.y - 22 }, to: { x: title.x + title.w + 4, y: title.y + title.h / 2 }, ring: title, w: 420 },
      ]);

      await p.go("#/compare/base..2");
      await p.waitFor(`document.querySelector(".codeview-host .thread-mini")`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      await p.sleep(1200);
      await p.keys("]", "t");
      await p.sleep(900);
      const tabs = await p.need("header.top nav");
      const strip = await p.need(".vstrip");
      const card = await p.need(".codeview-host .thread-mini.focused");
      const cur = (await cursorRow())!;
      const file = await p.need(".file-row.active");
      await p.shot("navigation-1.png", [
        { html: "<b>Round</b> what is left to do · <b>Changes</b> the code (<b>v</b>) · <b>Drafts</b> your unsent comments (<b>s</b>)", at: { x: tabs.x - 720, y: 2 }, to: { x: tabs.x - 4, y: tabs.y + tabs.h / 2 }, ring: tabs, w: 700 },
        { html: "Which code: <b>from</b> and <b>to</b> under a version set the two ends of the diff; a click on a version shows only what changed in it. <b>]v</b> <b>[v</b> and <b>}</b> <b>{</b> move the ends from the keyboard", at: { x: 60, y: 330 }, to: { x: strip.x - 4, y: strip.y + strip.h / 2 }, ring: strip, w: 440 },
        { html: "The cursor. <b>j</b> <b>k</b> a line, <b>]c</b> <b>[c</b> a change, <b>]h</b> <b>[h</b> a hunk, <b>gg</b> <b>G</b> the ends, <b>Ctrl+d</b> <b>Ctrl+u</b> half a page. <b>i</b> comments on it, <b>V</b> selects lines", at: { x: cur.x - 650, y: cur.y - 27 }, to: { x: cur.x - 4, y: cur.y + cur.h / 2 }, ring: { x: cur.x, y: cur.y, w: Math.min(cur.w, 600), h: cur.h }, w: 600 },
        { html: "<b>]t</b> <b>[t</b> step through the threads on the diff, <b>Enter</b> opens the one under the cursor. <b>]u</b> or <b>n</b>: the next one with news", at: { x: card.x - 655, y: card.y + 14 }, to: { x: card.x - 4, y: card.y + card.h / 2 }, ring: card, w: 600 },
        { html: "The file you are in. A click jumps to a file; <b>]b</b> <b>[b</b> (or <b>L</b> <b>H</b>) next / previous file", at: { x: 20, y: 200 }, to: { x: file.x + 80, y: file.y + file.h + 2 }, ring: file, w: 380 },
      ]);

      await p.keys(" ");
      await p.waitFor(`document.querySelector(".which-key")`);
      await p.sleep(400);
      const which = await p.need(".which-key");
      const group = await p.need(".which-key .which-item.group");
      await p.shot("navigation-2.png", [
        { html: "<b>Space</b> opens a menu of what can follow, as in LazyVim. Entries with + are groups: <b>Space s</b> search, <b>Space u</b> view switches, <b>Space r</b> review, <b>Space g</b> git", at: { x: which.x - 540, y: which.y }, to: { x: group.x - 4, y: group.y + group.h / 2 }, ring: group, w: 500 },
        { html: "<b>Space Space</b> finds a file of the diff by name; <b>Space s k</b> finds a key by what it does and runs it. <b>Esc</b> closes the menu", at: { x: which.x - 540, y: which.y + 130 }, ring: which, w: 500 },
      ]);
      await p.keys("");
      await p.sleep(300);

      await p.keys("");
      await p.waitFor(`document.querySelector(".detail-head .tid")`);
      await p.sleep(1500);
      const nav = await p.need(".thread-nav");
      const tree = await p.need(".tree .thread-row.active");
      const timeline = await p.need(".timeline");
      const back = await p.need(".head-actions a.btn", "Back to the changes");
      const msgs = await p.need(".thread-msgs");
      const hint = await p.need(".msgs-head .hint");
      await p.shot("navigation-3.png", [
        { html: "<b>k</b> <b>j</b> previous / next thread, <b>n</b> <b>N</b> the next / previous one with news, <b>J</b> <b>K</b> the first thread of the next / previous file", at: { x: timeline.x + 260, y: timeline.y - 6 }, to: { x: nav.x + 200, y: nav.y + nav.h + 2 }, ring: { x: nav.x, y: nav.y, w: 260, h: nav.h }, w: 520 },
        { html: "Every thread by file, in the order of the Changes page. A click opens one; the filters above narrow the list", at: { x: 20, y: 470 }, to: { x: tree.x + 120, y: tree.y + tree.h + 2 }, ring: tree, w: 380 },
        { html: "<b>[</b> <b>]</b> step through the versions of this code: what it was when you wrote the thread, and after each round", at: { x: 20, y: 640 }, to: { x: timeline.x - 4, y: timeline.y + 30 }, w: 420 },
        { html: "<b>Esc</b>: back to the Changes page, at this thread · <b>Ctrl+O</b> <b>Ctrl+I</b> jump back / forward (pages, search hits, file jumps)", at: { x: 300, y: 2 }, to: { x: back.x + back.w / 2, y: back.y - 4 }, ring: back, w: 1000 },
        { html: "<b>}</b> <b>{</b> step through the messages, <b>r</b> replies (see Long conversations)", at: { x: msgs.x + 20, y: msgs.y + 420 }, to: { x: hint.x + 20, y: hint.y + hint.h + 2 }, ring: hint, w: 420 },
      ]);

      await p.eval(`document.activeElement?.blur(); true`);
      await p.keys(" ", "s", "k");
      await p.waitFor(`document.querySelector(".picker input")`);
      await p.sleep(400);
      await p.eval(`(() => { const i = document.querySelector(".picker input"); i.value = "next thread"; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
      await p.sleep(500);
      const picker = await p.need(".picker");
      const input = await p.need(".picker input");
      await p.shot("navigation-4.png", [
        { html: "Forgot a key? <b>Space s k</b> and type what you want to do; <b>Enter</b> runs the key. <b>?</b> shows every key of every page as a table with the same filter", at: { x: input.x + input.w + 40, y: input.y - 20 }, to: { x: input.x + input.w + 4, y: input.y + input.h / 2 }, ring: picker, w: 420 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
