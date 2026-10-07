import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Demo, OUT, renderPngs, withBrowser, type Rect } from "./lib.ts";

const PNG = "docs/design/card.png";

const badge = `<div id="badge" style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 4px;padding:4px 10px;border-radius:999px;background:#efe7ff;color:#5b2bd1;font-weight:600;font-size:12px">🎁 10% off your next order</div>`;

const card = (o: { gap: number; badge: "none" | "outside" | "inside" }) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#eef1f5;font:14px/1.35 system-ui,sans-serif;color:#1d2127">
<div style="width:340px;margin:16px 16px 8px;background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.14);overflow:hidden">
  <div style="display:flex;align-items:center;gap:8px;padding:12px 14px;background:#fff6dc"><span>⚠️</span><b style="flex:1">Payment pending</b><span style="color:#2f6fdd;font-weight:600">Pay</span></div>
  <div style="height:${o.gap}px"></div>
  <div style="padding:0 14px"><div style="color:#667;font-size:12px">Order</div><div style="font-weight:600;font-size:16px">#A-1042</div></div>
  <div style="display:flex;padding:12px 14px;gap:12px"><div style="flex:1"><div style="color:#667;font-size:12px">Items</div><b style="font-size:18px">3</b></div><div style="flex:1"><div style="color:#667;font-size:12px">Delivery</div><b style="font-size:18px">Tomorrow</b></div></div>
  ${o.badge === "inside" ? badge : ""}
  <div style="display:flex;gap:10px;padding:10px 14px 16px"><span style="flex:1;text-align:center;padding:9px;border-radius:10px;background:#2f6fdd;color:#fff;font-weight:600">Track</span><span style="flex:1;text-align:center;padding:9px;border-radius:10px;background:#eef1f5;font-weight:600">Details</span></div>
</div>
${o.badge === "outside" ? `<div>${badge}</div>` : ""}
</body>`;

const BADGE = `(() => { const r = document.getElementById("badge")?.getBoundingClientRect(); return r ? { x: r.left * devicePixelRatio, y: r.top * devicePixelRatio, w: r.width * devicePixelRatio, h: r.height * devicePixelRatio } : null; })()`;

export async function imagesGuide() {
  const demo = new Demo();
  try {
    const [, outside] = (await renderPngs([
      { html: card({ gap: 16, badge: "none" }), w: 372, h: 300, dpr: 1.5, to: join(demo.repo, PNG) },
      { html: card({ gap: 12, badge: "outside" }), w: 372, h: 300, dpr: 1.5, to: join(demo.repo, "v1.png"), measure: BADGE },
      { html: card({ gap: 12, badge: "inside" }), w: 372, h: 300, dpr: 1.5, to: join(demo.repo, "v2.png") },
    ])) as [null, Rect, null];
    demo.write("app/src/main/java/shop/OrderCard.kt", "package shop\n\nclass OrderCard(val number: String)\n");
    demo.write(".gitignore", "v1.png\nv2.png\n");
    demo.commitBase();
    copyFileSync(join(demo.repo, "v1.png"), join(demo.repo, PNG));
    demo.write("app/src/main/java/shop/OrderCard.kt", "package shop\n\nclass OrderCard(val number: String, val promo: String?)\n");
    demo.stet("version", "create", "--label", "promo badge under the card");

    await withBrowser(demo, async (p) => {
      await p.go("#/compare/base..1");
      await p.waitFor(`[...document.querySelectorAll(".imgdiff img")].length === 2 && [...document.querySelectorAll(".imgdiff img")].every(i => i.complete)`, 15000);
      await p.eval(`[...document.querySelectorAll(".side-tabs button")].find(b => b.textContent === "Files").click(); document.activeElement?.blur(); true`);
      await p.eval(`(() => { const h = document.querySelector(".codeview-host"); h.scrollTop = document.querySelector(".imgdiff").getBoundingClientRect().top - h.getBoundingClientRect().top + h.scrollTop - 90; return true; })()`);
      await p.sleep(1200);
      const box = await p.eval(`(() => { const i = document.querySelectorAll(".imgdiff .imgbox img")[1]; const r = i.getBoundingClientRect(); return { x: r.left, y: r.top, s: r.width / i.naturalWidth }; })()`);
      const pad = 6;
      const from = { x: Math.round(box.x + (outside.x - pad) * box.s), y: Math.round(box.y + (outside.y - pad) * box.s) };
      const to = { x: Math.round(box.x + (outside.x + outside.w + pad) * box.s), y: Math.round(box.y + (outside.y + outside.h + pad) * box.s) };
      await p.pointer([{ type: "pointerMove", ...from }, { type: "pointerDown", button: 0 }, { type: "pointerMove", x: to.x - 10, y: to.y - 5 }, { type: "pointerMove", ...to }, { type: "pointerUp", button: 0 }]);
      await p.waitFor(`document.querySelector(".imgdiff .new-thread textarea")`);
      await p.eval(`document.querySelector(".imgdiff .new-thread textarea").focus(); true`);
      await p.keys(..."In the design the badge is inside the card, under the columns.");
      await p.sleep(400);
      const modes = await p.need(".imgdiff .seg");
      const zoom = await p.need(".imgdiff .zoom-bar");
      const caption = await p.need(".imgdiff-caption");
      const frame = await p.need(".imgdiff .img-frame.tone-pending");
      const note = await p.need(".imgdiff .new-thread .note");
      await p.shot("images-1.png", [
        { html: "Size and bytes, old → new", at: { x: 300, y: caption.y + 40 }, to: { x: caption.x - 4, y: caption.y + caption.h / 2 }, w: 250 },
        { html: "Old and new side by side, a swipe divider, one over the other, or the pixels that differ", at: { x: modes.x + modes.w / 2 + 60, y: modes.y - 84 }, to: { x: modes.x + modes.w / 2, y: modes.y - 4 }, ring: modes, w: 360 },
        { html: "Drag on either image to frame an area: a thread on it, like one on lines", at: { x: frame.x - 400, y: frame.y - 20 }, to: { x: frame.x - 4, y: frame.y + frame.h / 2 }, w: 300 },
        { html: "Zoom in to frame a small detail: also Ctrl + the wheel, or + − 0 over a picture", at: { x: zoom.x + zoom.w + 260, y: zoom.y + 36 }, to: { x: zoom.x + zoom.w / 2, y: zoom.y + zoom.h + 4 }, ring: zoom, w: 360 },
        { html: "The agent gets the image with this area framed, and the area at full size", at: { x: note.x + 900, y: note.y + 60 }, to: { x: note.x + 820, y: note.y + note.h + 20 }, w: 360 },
      ]);
      await p.eval(`[...document.querySelectorAll(".imgdiff .new-thread button")].find(b => b.textContent.includes("Send now")).click(); true`);
      await p.waitFor(`document.querySelector('.imgdiff a.img-frame[data-thread]')`, 8000);

      await p.eval(`[...document.querySelectorAll(".imgdiff .seg button")].find(b => b.textContent === "difference").click(); true`);
      await p.waitFor(`/px differ/.test(document.querySelector(".imgdiff-canvas .imgstack-labels")?.textContent ?? "")`, 8000);
      await p.sleep(500);
      const sum = await p.need(".imgdiff-canvas .imgstack-labels span");
      const changed = await p.need(".imgdiff-canvas .tone-change-box");
      await p.shot("images-2.png", [
        { html: "Pixels that differ in magenta, the rest faded; the dashed box holds every change", at: { x: changed.x + changed.w + 60, y: changed.y + 40 }, to: { x: changed.x + changed.w + 4, y: changed.y + changed.h / 2 }, w: 340 },
        { html: "How many pixels and where. A layout that moves things down marks all below: swipe or onion skin show that better", at: { x: sum.x + sum.w + 220, y: sum.y + 50 }, to: { x: sum.x + sum.w + 4, y: sum.y + sum.h / 2 }, w: 380 },
      ]);
      await p.eval(`[...document.querySelectorAll(".imgdiff .seg button")].find(b => b.textContent === "side by side").click(); true`);

      const t = (demo.stet("threads", "list", "--status", "all") as { id: number }[])[0]!;
      copyFileSync(join(demo.repo, "v2.png"), join(demo.repo, PNG));
      demo.stet("reply", String(t.id), "--intent", "fixed", "--body", "Moved the badge into the card, under the columns.");
      demo.stet("version", "create", "--label", "badge inside the card");
      const shown = demo.stet("thread", "show", String(t.id)) as { image: { shot: string; crop: string } };
      copyFileSync(shown.image.shot, join(OUT, "images-agent.png"));
      copyFileSync(shown.image.crop, join(OUT, "images-agent-crop.png"));

      await p.go(`#/thread/${t.id}`);
      await p.waitFor(`document.querySelectorAll(".image-area .region-crop img").length === 2 && document.querySelectorAll(".timeline .step-thumb").length === 2`, 15000);
      await p.sleep(1200);
      const thumb = await p.need(".timeline .step:last-child .step-thumb");
      const toggle = await p.need(".code-label .seg");
      const crops = await p.need(".image-area .imgpair");
      await p.shot("images-3.png", [
        { html: "Each step of the timeline shows the area at that version", at: { x: thumb.x + thumb.w + 160, y: thumb.y - 30 }, to: { x: thumb.x + thumb.w + 4, y: thumb.y + thumb.h / 2 }, w: 300 },
        { html: "The area before and after the agent's fix; or the whole image with the frame", at: { x: 40, y: toggle.y + 60 }, to: { x: toggle.x - 4, y: toggle.y + toggle.h / 2 }, ring: toggle, w: 320 },
        { html: "The frame stays where it was drawn; a changed image makes the thread “changed”", at: { x: crops.x + 220, y: crops.y + crops.h + 50 }, to: { x: crops.x + crops.w * 0.7, y: crops.y + crops.h - 20 }, w: 330 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
