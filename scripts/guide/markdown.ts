import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Demo, renderPngs, withBrowser, type Rect } from "./lib.ts";

const SHOT = "docs/checkout.png";

const screen = (o: { invoice: boolean }) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#eef1f5;font:14px/1.35 system-ui,sans-serif;color:#1d2127">
<div style="width:300px;margin:14px;background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.14);padding:14px">
  <div style="font-weight:600;font-size:16px;margin-bottom:10px">Checkout</div>
  <div style="display:flex;justify-content:space-between;color:#667"><span>3 items</span><b style="color:#1d2127">€42.50</b></div>
  <div style="display:flex;gap:8px;margin-top:14px">
    <span style="flex:1;text-align:center;padding:9px;border-radius:10px;background:#2f6fdd;color:#fff;font-weight:600">Pay by card</span>
    ${o.invoice ? `<span style="flex:1;text-align:center;padding:9px;border-radius:10px;background:#eef1f5;font-weight:600">Invoice</span>` : ""}
  </div>
</div>
</body>`;

const before = `# Shop

A small demo shop for the Android app. The cart lives in memory.

## Run it

\`\`\`bash
./gradlew installDebug
\`\`\`

## How it is built

The app is a single activity with Compose screens. Each screen has a view model that talks to a repository.

The repository reads from the local database first and refreshes from the network in the background.

Screens:

- Catalog
- Product page
- Cart

## Checkout

- Pay by card
- Order history

Payments go through the old gateway, see [payments](docs/payments.md).

![Checkout screen](docs/checkout.png)

| Setting | Default |
|---|---|
| currency | EUR |
| cache | off |
`;

const after = `# Shop

A small demo shop for the Android app. The cart lives in SQLite and survives a restart.

## Run it

\`\`\`bash
./gradlew installDebug -Pflavor=demo
\`\`\`

## How it is built

The app is a single activity with Compose screens. Each screen has a view model that talks to a repository.

The repository reads from the local database first and refreshes from the network in the background.

Screens:

- Catalog
- Product page
- Cart

## Checkout

- Pay by card or by invoice
- Order history
- Promo codes

![Checkout screen](docs/checkout.png)

| Setting | Default |
|---|---|
| currency | EUR |
| cache | 10 minutes |

## Limits

One shop per installation.
`;

export async function markdownGuide() {
  const demo = new Demo();
  try {
    await renderPngs([
      { html: screen({ invoice: false }), w: 328, h: 150, to: join(demo.repo, SHOT) },
      { html: screen({ invoice: true }), w: 328, h: 150, to: join(demo.repo, "v1.png") },
    ]);
    demo.write(".gitignore", "v1.png\n");
    demo.write("README.md", before);
    demo.write("docs/payments.md", "# Payments\n");
    demo.write("app/src/main/java/shop/Checkout.kt", "package shop\n\nclass Checkout(val cart: Cart)\n");
    demo.commitBase();
    copyFileSync(join(demo.repo, "v1.png"), join(demo.repo, SHOT));
    demo.write("README.md", after);
    demo.write("app/src/main/java/shop/Checkout.kt", "package shop\n\nclass Checkout(val cart: Cart, val invoices: Invoices)\n");
    demo.stet("version", "create", "--label", "invoices");
    const line = (text: string, needle: string) => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
    demo.stet("comment", "add", "--file", "README.md", "--range", `${line(after, "by invoice")}-${line(after, "by invoice")}`, "--at", "1", "--body", "Invoices need a VAT number: where does it come from?", "--as", "reviewer");
    demo.stet("comment", "add", "--file", "README.md", "--range", `${line(before, "old gateway")}-${line(before, "old gateway")}`, "--at", "base", "--side", "old", "--body", "Where do payments go now? The gateway section is gone.", "--as", "reviewer");

    await withBrowser(demo, async (p) => {
      const md = `document.querySelector('.md-view[data-file="README.md"]')`;
      const toTop = (sel: string, gap: number) =>
        p.eval(`(() => { const h = document.querySelector(".codeview-host"); const el = document.querySelector(${JSON.stringify(sel)}); h.scrollTop += el.getBoundingClientRect().top - h.getBoundingClientRect().top - ${gap}; return true; })()`);
      await p.go("#/compare/base..1");
      await p.waitFor(`document.querySelector(".md-toggle")`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      await p.waitFor(`${md}?.querySelectorAll("img").length === 2 && [...${md}.querySelectorAll("img")].every(i => i.complete) && ${md}.querySelector("pre.shiki")`, 15000);
      await p.sleep(600);
      await toTop(`.md-view[data-file="README.md"]`, 70);
      await p.sleep(800);
      const toggle = await p.need(".md-toggle");
      const heads = await p.need(".md-head[data-side='old']");
      const changedOld = await p.need(".md-cell[data-side='old'] p.md-changed");
      const changedNew = await p.need(".md-cell[data-side='new'] p.md-changed");
      const removed = await p.need(".md-cell[data-side='old'] p.md-changed", "old gateway");
      const card = await p.need(".md-cell[data-side='new'] .md-threads .thread-mini");
      const pictureOld = await p.need(".md-cell[data-side='old'] img");
      const pictureNew = await p.need(".md-cell[data-side='new'] img");
      const gap = await p.need(".md-cell[data-side='old'] .md-gap");
      const fold = await p.need(".md-view .md-fold");
      await p.shot("markdown-1.png", [
        { html: "<b>‹/› code</b>: this file as code, at the same place on the screen. Markdown opens rendered (<code>compare.markdown</code>)", at: { x: toggle.x - 520, y: toggle.y - 56 }, to: { x: toggle.x - 4, y: toggle.y + toggle.h / 2 }, ring: toggle, w: 450 },
        { html: "Split view: the old version and the new one, block facing block. Unchanged blocks stay level", at: { x: 40, y: 250 }, to: { x: heads.x - 4, y: heads.y + heads.h / 2 }, w: 420 },
        { html: "The words that changed: struck through on the old side, green on the new one", at: { x: 40, y: 360 }, to: { x: changedOld.x - 14, y: changedOld.y + changedOld.h / 2 }, ring: { x: changedOld.x - 12, y: changedOld.y, w: changedNew.x + changedNew.w - changedOld.x + 12, h: Math.max(changedOld.h, changedNew.h) }, w: 420 },
        { html: "Items of a changed list face each other; an added one faces an empty slot", at: { x: 40, y: gap.y - 70 }, to: { x: gap.x - 4, y: gap.y + gap.h / 2 }, ring: gap, w: 420 },
        { html: "Removed: red on the old side, nothing facing it. A thread on old lines shows on the old side", at: { x: 40, y: removed.y + 10 }, to: { x: removed.x - 14, y: removed.y + removed.h / 2 }, w: 420 },
        { html: "A thread shows on the block its lines are in, with its card under it", at: { x: card.x + 200, y: card.y + 50 }, to: { x: card.x + 160, y: card.y + card.h + 2 }, ring: card, w: 330 },
        { html: "Unchanged text between the changes folds into a bar: <b>show above</b>, <b>show below</b> or <b>show all</b> opens it, in the code too", at: { x: 40, y: fold.y - 30 }, to: { x: fold.x - 4, y: fold.y + fold.h / 2 }, ring: fold, w: 420 },
        { html: "Each side's pictures come from its own version", at: { x: 40, y: pictureOld.y + 20 }, to: { x: pictureOld.x - 4, y: pictureOld.y + pictureOld.h / 2 }, ring: { x: pictureOld.x, y: pictureOld.y, w: pictureNew.x + pictureNew.w - pictureOld.x, h: pictureNew.h }, w: 420 },
      ]);

      const item: Rect = await p.need(".md-cell[data-side='new'] li", "Promo codes");
      await p.pointer([{ type: "pointerMove", x: item.x + 60, y: item.y + item.h / 2 }]);
      await p.waitFor(`document.querySelector(".md-gutter .md-plus")`);
      await p.sleep(300);
      const plus = await p.need(".md-gutter .md-plus");
      const jump = await p.need(".md-gutter .md-jump");
      await p.click(plus);
      await p.waitFor(`document.querySelector(".md-view .new-thread textarea")`);
      await p.keys(..."How long is a promo code valid?");
      await p.pointer([{ type: "pointerMove", x: item.x + 60, y: item.y + item.h / 2 }]);
      await p.sleep(400);
      const picked = await p.need(".md-cell[data-side='new'] li.md-picked");
      const note = await p.need(".md-view .new-thread .note");
      const caption = await p.need(".md-view .md-bar .hint");
      const copy = await p.need(".md-view .new-thread .copy-link");
      await p.shot("markdown-2.png", [
        { html: "<b>+</b> beside a block starts a thread on its lines, on its side. Or put the cursor on it (a click, <b>j</b> <b>k</b>, <b>]c</b>) and press <b>i</b>; <b>V</b> takes several blocks", at: { x: plus.x - 600, y: plus.y + 50 }, to: { x: plus.x - 4, y: plus.y + plus.h / 2 }, ring: plus, w: 470 },
        { html: "<b>‹/›</b> shows the block's lines in the code, with the cursor on them", at: { x: jump.x - 600, y: jump.y + 125 }, to: { x: jump.x - 4, y: jump.y + jump.h / 2 }, ring: jump, w: 470 },
        { html: "The thread is on the block's lines, as if you had selected them in the code", at: { x: jump.x - 600, y: jump.y + 195 }, to: { x: note.x - 4, y: note.y + note.h / 2 }, ring: { x: picked.x, y: picked.y, w: picked.w, h: picked.h }, w: 470 },
        { html: "The keys of the code work on blocks: <b>j</b> <b>k</b> a block, <b>]c</b> <b>[c</b> a change, <b>]t</b> a thread, <b>Enter</b> opens it", at: { x: caption.x + caption.w + 20, y: caption.y + 40 }, to: { x: caption.x + caption.w - 60, y: caption.y + caption.h + 2 }, w: 360 },
        { html: "<b>Copy link</b>: a link that opens these blocks, highlighted (or <b>Space g Y</b>)", at: { x: copy.x + 40, y: copy.y + 45 }, to: { x: copy.x + copy.w / 2, y: copy.y + copy.h + 2 }, ring: copy, w: 270 },
      ]);
      await p.eval(`[...document.querySelectorAll(".md-view .new-thread button")].find(b => b.textContent === "Cancel").click(); true`);

      await p.eval(`[...document.querySelectorAll(".compare-head .btn")].find(b => b.textContent === "unified").click(); true`);
      await p.waitFor(`document.querySelector('.md-view.md-one[data-file="README.md"]') && [...${md}.querySelectorAll("img")].every(i => i.complete) && ${md}.querySelector("pre.shiki")`, 15000);
      await p.sleep(600);
      await toTop(`.md-view[data-file="README.md"]`, 70);
      await p.sleep(800);
      const inline = await p.need(".md-one .md-cell[data-side='new'] p.md-words");
      // the thread on the first item breaks the list after it
      const top = await p.need(".md-one .md-cell[data-side='new'] li", "Pay by card");
      const list = await p.need(".md-one .md-cell[data-side='new'] ul", "Promo codes");
      const gone = await p.need(".md-one .md-cell[data-side='new'] p.md-removed", "old gateway");
      await p.shot("markdown-3.png", [
        { html: "Unified view: one column. A block with a few words changed shows once, with the changes in its text", at: { x: inline.x + inline.w + 30, y: inline.y - 40 }, to: { x: inline.x + inline.w + 4, y: inline.y + inline.h / 2 }, ring: inline, w: 360 },
        { html: "A list shows once too: the changed words in an item, an added item green", at: { x: list.x + list.w + 30, y: top.y - 10 }, to: { x: list.x + list.w + 4, y: (top.y + list.y + list.h) / 2 }, ring: { x: list.x, y: top.y, w: list.w, h: list.y + list.h - top.y }, w: 330 },
        { html: "A removed block is struck through where it was, with its thread", at: { x: gone.x + gone.w + 30, y: gone.y + 10 }, to: { x: gone.x + gone.w + 4, y: gone.y + gone.h / 2 }, w: 330 },
      ]);
      await p.eval(`[...document.querySelectorAll(".compare-head .btn")].find(b => b.textContent === "split").click(); true`);
    });
  } finally {
    demo.dispose();
  }
}
