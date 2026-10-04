import { Demo, withBrowser } from "./lib.ts";

const DIR = "app/src/main/java/shop";
const screen = (extra = "") => `package shop

class CartViewModel(
    private val events: CartEvents,
    private val cart: Cart,
) {
    fun onAction(action: CartAction) {
        logCartActionIfNeeded(action)
        when (action) {
            is CartAction.Add -> cart.add(action.item)
            is CartAction.Remove -> cart.remove(action.item)
            is CartAction.Refresh -> Unit
        }
    }

    private fun logCartActionIfNeeded(action: CartAction) {
        if (action is CartAction.Refresh) return
        events.logCartAction(action)
    }
${extra}}
`;

export async function checkClaim() {
  const demo = new Demo();
  try {
    demo.write(`${DIR}/CartEvents.kt`, `package shop

class CartEvents(private val log: EventLog) {
    fun logCartAction(action: CartAction) {
        log.record("cart_action", mapOf("action" to action.name))
    }
}
`);
    demo.write(`${DIR}/CartViewModel.kt`, screen());
    demo.commitBase();
    demo.write(`${DIR}/CartViewModel.kt`, screen("\n    fun onOpened() = events.logCartAction(CartAction.Open)\n"));
    demo.stet("version", "create", "--label", "cart events");
    const tid = demo.stet("comment", "add", "--file", `${DIR}/CartViewModel.kt`, "--range", "16-19", "--at", "1", "--body", "Why this wrapper? The Refresh check could live right in onAction.", "--as", "reviewer").id as number;
    demo.stet("reply", String(tid), "--intent", "fixed", "--body", "Agreed, the wrapper is not needed: `logCartActionIfNeeded` only filters out Refresh and calls the helper. Merging it into onAction.");
    demo.write(`${DIR}/Cart.kt`, "package shop\n\ninterface Cart {\n    fun add(item: Item)\n    fun remove(item: Item)\n}\n");
    demo.stet("version", "create", "--label", "review fixes");

    await withBrowser(demo, async (p) => {
      const code = ".thread-code .code-area diffs-container";
      await p.go(`#/thread/${tid}`);
      await p.waitFor(`document.querySelector(${JSON.stringify(code)})?.shadowRoot?.textContent.includes("logCartActionIfNeeded")`, 15000);
      await p.sleep(1200);
      const w = (await p.textRect(code, "logCartActionIfNeeded", true))!;
      const warn = await p.need(".state-strip .warn-text");
      const tabs = await p.need(".side-tabs");
      await p.shot("check-claim-1.png", [
        { html: "① Double-click a name in the code<br>(or select it and press <b>*</b>)", at: { x: w.x + 60, y: w.y + 150 }, to: { x: w.x + w.w / 2, y: w.y + w.h + 2 }, ring: w, w: 360 },
        { html: "The agent says “fixed”, but the thread's lines did not change: worth a check", at: { x: 860, y: warn.y + 48 }, to: { x: warn.x + 140, y: warn.y + warn.h + 2 }, w: 380 },
        { html: "② The results show up here, in the Search tab", at: { x: tabs.x + 20, y: tabs.y + 240 }, to: { x: tabs.x + tabs.w - 30, y: tabs.y + tabs.h + 2 }, w: 300 },
      ]);

      await p.click(w, 2);
      await p.waitFor(`document.querySelectorAll(".search .snip.match").length >= 2`);
      await p.sleep(600);
      await p.eval(`[...document.querySelectorAll(".search .snip.match")].find(x => x.textContent.includes("logCartActionIfNeeded(action)") && !x.textContent.includes("fun "))?.click(); true`);
      await p.waitFor(`document.querySelector(".thread-code .peek diffs-container")`);
      await p.sleep(1200);
      await p.eval(`document.querySelector(".search .snip-row:has(.current) .quote, .search .snip-row .quote")?.click(); true`);
      await p.sleep(600);
      await p.eval(`(() => { document.querySelector(".thread-msgs > .composer textarea").blur(); const s = document.createElement("style"); s.textContent = ".quote{opacity:1!important}"; document.head.appendChild(s); return true; })()`);
      await p.sleep(300);
      const results = await p.need(".search .hit-file");
      const quote = await p.need(".search .snip-row:has(.current) .quote");
      const peek = await p.need(".thread-code .peek");
      const reply = await p.need(".thread-msgs > .composer textarea");
      const close = await p.need(".thread-code .peek .peek-head .btn");
      const line8 = await p.eval(`(() => { const row = document.querySelector(".thread-code .peek diffs-container").shadowRoot.querySelector('[data-content] > [data-line="8"]'); const r = row.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      await p.shot("check-claim-2.png", [
        { html: "② Every match in every file of this version. Two here, both in this file: the declaration and one call. Nobody else calls the wrapper", at: { x: results.x + 10, y: results.y + results.h + 150 }, to: { x: results.x + 60, y: results.y + results.h + 4 }, ring: results, w: 420 },
        { html: "③ A click on a result opens the file here, over the thread's code, at that line. The conversation on the right stays", at: { x: peek.x + 30, y: peek.y + 600 }, to: { x: line8.x + 160, y: line8.y + line8.h + 2 }, ring: peek, w: 380 },
        { html: "④ ❝ puts this line with its path into your reply", at: { x: quote.x - 40, y: quote.y + 90 }, to: { x: quote.x + quote.w / 2, y: quote.y + quote.h + 2 }, w: 280 },
        { html: "Or select several lines in this file and press “Quote in reply”", at: { x: peek.x + 430, y: peek.y + 780 }, w: 340 },
        { html: "⑤ The quote is in the reply. Finish it and press Ctrl+S: a draft, the agent sees it after Submit", at: { x: reply.x + 20, y: reply.y + reply.h + 80 }, to: { x: reply.x + reply.w / 2, y: reply.y + reply.h - 6 }, ring: reply, w: 380 },
        { html: "⑥ Esc or close: the file closes and the thread's code is back. Ctrl+O: back, if you went to another page", at: { x: peek.x + 430, y: peek.y + 600 }, to: { x: close.x + close.w / 2, y: close.y + close.h + 2 }, w: 340 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
