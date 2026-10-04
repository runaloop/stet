import { Demo, withBrowser } from "./lib.ts";

const CART = "app/src/main/java/shop/Cart.kt";
const PAY = "app/src/main/java/shop/Checkout.kt";

const cart = (body: string) => `package shop

class Cart(private val prices: Prices) {
    private val items = mutableListOf<Item>()

    fun add(item: Item) {
        items += item
    }
${body}}
`;
const checkout = (body: string) => `package shop

class Checkout(private val cart: Cart, private val gateway: Gateway) {
${body}}
`;

export async function commitsGuide() {
  const demo = new Demo();
  try {
    demo.write(CART, cart(""));
    demo.write(PAY, checkout("    fun pay(card: Card): Receipt = gateway.charge(card, cart.total())\n"));
    demo.commitBase();
    const commit = (msg: string) => {
      demo.git("add", "-A");
      demo.git("commit", "-q", "-m", msg);
    };
    demo.write(CART, cart("\n    fun remove(item: Item) {\n        items -= item\n    }\n"));
    commit("Cart: remove items");
    demo.write(CART, cart("\n    fun remove(item: Item) {\n        items -= item\n    }\n\n    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.of(item) }\n"));
    commit("Cart: total of the items");
    demo.stet("version", "create", "--label", "cart");
    demo.write(PAY, checkout("    fun pay(card: Card): Receipt {\n        val total = cart.total()\n        require(total > Money.ZERO) { \"empty cart\" }\n        return gateway.charge(card, total)\n    }\n"));
    commit("Checkout: refuse an empty cart");
    demo.write(PAY, checkout("    fun pay(card: Card): Receipt {\n        val total = cart.total()\n        require(total > Money.ZERO) { \"empty cart\" }\n        return retry(times = 2) { gateway.charge(card, total) }\n    }\n"));
    commit("Checkout: retry a declined card twice");
    demo.write(CART, cart("\n    fun remove(item: Item) {\n        items.remove(item)\n    }\n\n    fun total(): Money = items.fold(Money.ZERO) { sum, item -> sum + prices.of(item) }\n"));

    await withBrowser(demo, async (p) => {
      const row = (text: string) => `[...document.querySelectorAll(".commit-row")].find(r => r.textContent.includes(${JSON.stringify(text)}))`;
      const rowRect = async (text: string, sel: string, n = 0) =>
        (await p.eval(`(() => { const r = ${row(text)}.querySelectorAll(${JSON.stringify(sel)})[${n}].getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`)) as { x: number; y: number; w: number; h: number };
      const title = () => p.eval(`document.querySelector(".range-title").textContent`) as Promise<string>;

      await p.go("#/compare/base..now");
      await p.waitFor(`document.querySelectorAll(".codeview-host diffs-container").length > 0`, 15000);
      await p.sleep(1000);
      const chip = await p.need(".commits-chip");
      await p.click(chip);
      await p.waitFor(`document.querySelectorAll(".commit-row").length >= 5`);
      await p.sleep(600);
      const ends = await rowRect("Cart: remove items", ".end");
      const endsTo = await rowRect("Checkout: refuse an empty cart", ".end", 1);
      const msg = await rowRect("retry a declined card", ".subject");
      const tag = await rowRect("Cart: total of the items", ".vtag");
      const sep = await p.need(".commit-sep");
      const typed = await p.need(".commit-range");
      await p.shot("commits-1.png", [
        { html: "① <b>commits…</b> (or <b style=\"white-space:nowrap\">Space g c</b>) lists the commits of the branch, newest first", at: { x: chip.x + 60, y: chip.y + 330 }, to: { x: chip.x + chip.w / 2, y: chip.y + chip.h + 4 }, ring: chip, w: 380 },
        { html: "② <b>first</b>: the oldest commit to show, <b>last</b>: the newest. Both are included, as on GitHub", at: { x: 240, y: ends.y + 40 }, to: { x: ends.x - 8, y: ends.y + ends.h / 2 }, ring: { x: ends.x, y: ends.y, w: 76, h: ends.h }, w: 360 },
        { html: "A click on a message shows that commit alone", at: { x: msg.x + msg.w + 40, y: msg.y - 30 }, to: { x: msg.x + msg.w + 4, y: msg.y + msg.h / 2 }, w: 250 },
        { html: "v1 was taken on top of this commit (v1 without + is the commit itself)", at: { x: tag.x - 345, y: tag.y + 14 }, to: { x: tag.x - 4, y: tag.y + tag.h / 2 }, ring: tag, w: 330 },
        { html: "Below the line: commits already in main", at: { x: msg.x + msg.w + 40, y: sep.y - 36 }, to: { x: sep.x + 300, y: sep.y + sep.h / 2 }, w: 250 },
        { html: "Or type any range, as in git diff A B", at: { x: typed.x - 120, y: typed.y + 40 }, to: { x: typed.x + typed.w / 2, y: typed.y + typed.h + 4 }, ring: typed, w: 260 },
      ]);
      console.log("  title 1:", await title());

      await p.click(ends);
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("4 commits")`);
      await p.click(endsTo);
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("3 commits") && document.querySelectorAll(".commit-row.in").length === 3`);
      await p.sleep(1500);
      const head = await p.need(".compare .range-title");
      const bar = await p.eval(`(() => { const rows = [...document.querySelectorAll(".commit-row.in")]; const a = rows[0].getBoundingClientRect(), b = rows[rows.length - 1].getBoundingClientRect(); return { x: Math.round(a.left), y: Math.round(a.top), w: 8, h: Math.round(b.bottom - a.top) }; })()`);
      const strip = await p.need(".vstrip");
      await p.shot("commits-2.png", [
        { html: "③ The title says what is shown: three commits, from “remove items” to “refuse an empty cart”", at: { x: 30, y: 200 }, to: { x: head.x - 6, y: head.y + head.h / 2 }, ring: head, w: 500 },
        { html: "The bar marks the commits in the diff; the strip above shows its two ends", at: { x: bar.x + 60, y: bar.y + bar.h + 130 }, to: { x: bar.x + 4, y: bar.y + bar.h + 2 }, ring: { x: bar.x - 2, y: bar.y, w: 10, h: bar.h }, w: 340 },
        { html: "Comment as on any compare: select lines or click +. Esc closes the list", at: { x: strip.x + 760, y: strip.y + 420 }, w: 330 },
      ]);
      console.log("  title 2:", await title());
      await p.eval(`${row("retry a declined card")}.querySelector("a.commit-msg").click(); true`);
      await p.waitFor(`document.querySelector(".range-title")?.textContent.startsWith("Commit ")`);
      console.log("  title 3:", await title());
      await p.eval(`${row("not committed yet")}.querySelector(".end").click(); true`);
      await p.waitFor(`document.querySelector(".range-title")?.textContent.includes("not committed yet")`);
      console.log("  title 4:", await title());
    });
  } finally {
    demo.dispose();
  }
}
