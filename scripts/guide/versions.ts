import { Demo, withBrowser } from "./lib.ts";

const DIR = "app/src/main/java/shop";
const ROUNDS = [
  ["cart total and checkout", "price cache with a TTL", "receipt keeps the currency", "pricing docs"],
  ["review 1: remove() drops every copy", "review 1: a zero total skips the charge", "TTL comes from the config"],
  ["review 2: the cache logs a miss", "review 2: PriceApi renamed to PricingApi", "tests for the price cache", "lint fixes"],
  ["review 3: currency rounding in one place", "changelog", "review 3: receipt test for a zero total"],
];

const pricing = (lines: string[]) => `package shop

class Pricing(private val api: PricingApi) {
${lines.map((l, i) => `    // ${l}\n    fun step${i + 1}() = api.touch(${i + 1})\n`).join("\n")}}
`;

export async function versionsGuide() {
  const demo = new Demo();
  try {
    demo.write(`${DIR}/Cart.kt`, "package shop\n\nclass Cart {\n    private val items = mutableListOf<Item>()\n\n    fun add(item: Item) {\n        items += item\n    }\n}\n");
    demo.write(`${DIR}/Pricing.kt`, pricing([]));
    demo.commitBase();
    const done: string[] = [];
    let thread = 0;
    ROUNDS.forEach((labels, r) => {
      for (const label of labels) {
        done.push(label);
        demo.write(`${DIR}/Pricing.kt`, pricing(done));
        demo.stet("version", "create", "--label", label);
      }
      if (r === ROUNDS.length - 1) return;
      const n = done.length;
      const id = demo.stet("comment", "add", "--file", `${DIR}/Cart.kt`, "--range", "6-8", "--at", String(n), "--body", `Round ${r + 1}: does add() need a quantity?`, "--as", "reviewer", "--draft").id as number;
      if (!thread) thread = id;
      demo.stet("review", "submit", "--body", `review ${r + 1}`, "--as", "reviewer");
      demo.stet("reply", String(id), "--intent", "answered", "--body", "Not yet: one row per SKU, the count comes later.");
    });

    await withBrowser(demo, async (p) => {
      await p.go("#/compare/6..8");
      await p.waitFor(`document.querySelector(".vstrip .vstep.fold") && document.querySelector(".range-title")?.textContent.includes("v6")`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      await p.sleep(1500);
      const fold = await p.need(".vstrip .vstep.fold");
      const find = await p.need(".vstrip .vstep.fold .vend");
      const from = await p.need(".vstep.from .vend.on");
      const older = await p.need("header.top button.older");
      const now = await p.need(".vstep.now .vbody");
      await p.shot("versions-many-1.png", [
        { html: "Versions far from the range fold into one step. A click shows them; <b>find…</b> lists every version", at: { x: 40, y: 230 }, to: { x: fold.x + fold.w / 2, y: fold.y + fold.h + 2 }, ring: { x: fold.x, y: fold.y, w: fold.w, h: find.y + find.h - fold.y }, w: 400 },
        { html: "The range stays whole with a version on each side, so <b>]v</b> <b>[v</b> and <b>}</b> <b>{</b> step on from here", at: { x: 40, y: 380 }, to: { x: from.x + from.w / 2, y: from.y + from.h + 2 }, w: 400 },
        { html: "The newest versions and <b>now</b> are always in view", at: { x: now.x - 120, y: 300 }, to: { x: now.x + now.w / 2, y: now.y + now.h + 2 }, w: 300 },
        { html: "The header keeps the last six; this button opens the list of all versions (<b>Space f v</b>)", at: { x: 40, y: 130 }, to: { x: older.x + older.w / 2, y: older.y + older.h + 4 }, ring: older, w: 400 },
      ]);

      await p.keys(" ", "f", "v");
      await p.waitFor(`document.querySelector(".picker .ver-pick")`);
      await p.sleep(500);
      const input = await p.need(".picker input");
      const round = await p.need(".picker .ver-round");
      const hint = await p.need(".picker .hint");
      await p.shot("versions-many-2.png", [
        { html: "Type a number (<b>12</b>, <b>v12</b>) or words of the label the agent gave the version", at: { x: input.x + input.w + 40, y: input.y - 10 }, to: { x: input.x + input.w + 4, y: input.y + input.h / 2 }, w: 360 },
        { html: "Newest first, grouped by the review they answer: what the agent did after your review 3, after review 2…", at: { x: round.x - 400, y: round.y + 40 }, to: { x: round.x - 4, y: round.y + round.h / 2 }, ring: round, w: 360 },
        { html: "<b>Enter</b> what changed in it · <b>Shift+Enter</b> make it “from” · <b>Ctrl+Enter</b> make it “to”", at: { x: hint.x + hint.w + 40, y: hint.y - 30 }, to: { x: hint.x + hint.w + 4, y: hint.y + hint.h / 2 }, ring: hint, w: 360 },
      ]);
      await p.keys("");
      await p.sleep(300);

      await p.go(`#/thread/${thread}`);
      await p.waitFor(`document.querySelector(".timeline .step.fold")`, 15000);
      await p.sleep(1500);
      const tfold = await p.need(".timeline .step.fold");
      await p.shot("versions-many-3.png", [
        { html: "A thread's timeline folds the versions where nothing happened to its code and nobody wrote; versions with messages or changes stay", at: { x: tfold.x - 40, y: tfold.y + 120 }, to: { x: tfold.x + tfold.w / 2, y: tfold.y + tfold.h + 2 }, ring: tfold, w: 420 },
      ]);

      await p.go("#/overview");
      await p.waitFor(`document.querySelector(".round-versions")`, 15000);
      await p.sleep(800);
      const link = await p.need(".round-versions summary a");
      const closed = await p.need(".round-versions:not([open]) summary b");
      await p.shot("versions-many-4.png", [
        { html: "The Round page lists versions by the review they answer; the link shows everything the agent changed in that round", at: { x: link.x + link.w + 60, y: link.y - 30 }, to: { x: link.x + link.w + 4, y: link.y + link.h / 2 }, ring: link, w: 420 },
        { html: "Older rounds are folded: a click opens one", at: { x: closed.x + 520, y: closed.y + 30 }, to: { x: closed.x + closed.w + 4, y: closed.y + closed.h / 2 }, ring: closed, w: 300 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
