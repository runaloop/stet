import { Demo, withBrowser } from "./lib.ts";

const FILE = "app/src/main/java/shop/PriceCache.kt";

const cache = (ttl: string) => `package shop

class PriceCache(private val api: PriceApi, private val clock: Clock) {
    private val entries = HashMap<Sku, Entry>()

    fun price(sku: Sku): Money {
        val hit = entries[sku]
        if (hit != null && clock.now() - hit.at < ${ttl}) return hit.money
        val money = api.fetch(sku)
        entries[sku] = Entry(money, clock.now())
        return money
    }
}
`;

/** Joins the lines of a paragraph; lists and code blocks keep theirs. */
const flow = (s: string) => s.replace(/([^`\n])\n *(?=[^\n`\d-])/g, "$1 ");

const REPLIES: [string, string][] = [
  [
    "agent",
    `Ten minutes comes from the pricing service: it publishes new prices at most every 15 minutes, so a
ten-minute cache never shows a price older than one publish cycle. What I checked:

1. PriceApi.fetch is the only way prices get in, and it is called from price() only.
2. The checkout screen calls price() again right before paying, so a stale price
   cannot be charged: the total is recomputed there.
3. The cache is per session (PriceCache lives in SessionScope), so two users never share entries.
4. Memory: about 400 SKUs per session in the worst case we have in the logs, a few KB.

What it does not handle:

- a price change pushed by the service between two fetches stays invisible for up to 10 minutes
  in the product list (not in checkout, see 2);
- the clock is the device clock, so a user who moves the clock back keeps a price longer.

If the product list must show a new price at once, the service would have to push invalidations;
it does not have that today. I would keep 10 minutes and log the age of the price at checkout,
so we can see how often the list and the checkout disagree.`,
  ],
  ["reviewer", "The device clock is the part I do not like. Can it use the monotonic clock instead?"],
  [
    "agent",
    `Yes: SystemClock.elapsedRealtime() does not move when the user changes the time and keeps
counting in deep sleep. Clock already has an elapsed() method used by the session timeout, so:

\`\`\`
if (hit != null && clock.elapsed() - hit.at < TTL) return hit.money
\`\`\`

and Entry stores clock.elapsed(). One catch: elapsedRealtime restarts at boot, but the cache does
not survive a restart of the process anyway, so an entry can never compare against a value from
before the boot.`,
  ],
  ["reviewer", "Good, do that. And make the ten minutes a named constant."],
];

const NEW: string[] = [
  "Done: Entry keeps clock.elapsed(), the check uses it, and TTL = 10.minutes is a constant in the companion object.",
  `Also added a test for the clock change: PriceCacheTest.userMovesTheClockBack sets the wall clock
two hours back and checks that the cached price still expires after ten minutes of elapsed time.
It fails on the old code (the entry stayed for two hours and ten minutes) and passes now.

I did not add the checkout logging yet: it touches CheckoutViewModel, which is outside this change.
Tell me if you want it here or as a separate change.`,
];

export async function conversationGuide() {
  const demo = new Demo();
  try {
    demo.write(FILE, "package shop\n\nclass PriceCache\n");
    demo.commitBase();
    demo.write(FILE, cache("10 * 60 * 1000"));
    demo.stet("version", "create", "--label", "price cache");
    const id = demo.stet("comment", "add", "--file", FILE, "--range", "8-8", "--at", "1", "--body", "Why ten minutes? What happens when a price changes in between?", "--as", "reviewer").id as number;
    const reply = (who: string, body: string) => demo.stet("reply", String(id), "--body", flow(body), ...(who === "reviewer" ? ["--as", "reviewer"] : []));

    await withBrowser(demo, async (p) => {
      for (const [who, body] of REPLIES) reply(who, body);
      await p.go(`#/thread/${id}`);
      await p.waitFor(`document.querySelector(".detail-head .tid")?.textContent === "#${id}"`);
      await p.sleep(1500);
      await p.go("#/compare/base..1");
      await p.sleep(800);
      demo.write(FILE, cache("TTL").replace("clock.now() - hit.at", "clock.elapsed() - hit.at").replace("Entry(money, clock.now())", "Entry(money, clock.elapsed())"));
      demo.stet("version", "create", "--label", "monotonic clock");
      reply("agent", NEW[0]!);
      reply("agent", NEW[1]!);
      await p.go(`#/thread/${id}`);
      await p.waitFor(`document.querySelector(".thread-msgs .new-line") && document.querySelector(".thread-msgs").scrollTop > 0`);
      await p.sleep(2000);

      const fresh = await p.need(".msgs-head .link");
      const line = await p.need(".thread-msgs .new-line");
      const keysHint = await p.need(".msgs-head .hint");
      const cards = await p.need(".timeline > li:last-child");
      const code = await p.need(".code-area");
      const below = code.y + code.h + 24;
      const right = cards.x + cards.w + 30;
      await p.shot("hero.png", []);
      await p.shot("conversation-1.png", [
        { html: "How many messages, how many are new. A click comes back to the first new one", at: { x: right, y: cards.y + 4 }, to: { x: fresh.x - 4, y: fresh.y + fresh.h / 2 }, ring: fresh, w: 360 },
        { html: "① A thread opens at the first message you have not read, under a <b>new</b> line. Nothing new: at the last message, with the reply box", at: { x: code.x + 300, y: below }, to: { x: line.x - 4, y: line.y + line.h / 2 }, ring: line, w: 420 },
        { html: "Keys in the messages: <b>{</b> <b>}</b> previous / next, <b>gg</b> <b>G</b> first / last, <b>Ctrl+d</b> <b>Ctrl+u</b> half a page (the code keeps its own scroll), <b>za</b> fold, <b>r</b> reply. <b>?</b> lists them all", at: { x: code.x + 300, y: below + 130 }, ring: keysHint, w: 420 },
      ]);

      await p.eval(`document.activeElement?.blur(); true`);
      await p.keys("g", "g");
      await p.sleep(300);
      await p.keys("}");
      await p.sleep(600);
      const cur = await p.need(".msg.at-cursor");
      const unfold = await p.need(".msg.folded .unfold");
      await p.shot("conversation-2.png", [
        { html: "The cursor. <b>r</b> replies to this message; before you move the cursor, <b>r</b> replies to the thread", at: { x: cards.x + cards.w + 30, y: cards.y + 4 }, to: { x: cur.x - 4, y: cur.y + 20 }, ring: { x: cur.x, y: cur.y, w: cur.w, h: Math.min(cur.h, 60) }, w: 400 },
        { html: "② Long messages you have read fold to a few lines. <b>za</b> or a click unfolds the one under the cursor, <b>zR</b> unfolds all, <b>zM</b> folds them again", at: { x: code.x + 300, y: code.y + code.h + 24 }, to: { x: unfold.x - 4, y: unfold.y + unfold.h / 2 }, ring: unfold, w: 420 },
      ]);
    });
  } finally {
    demo.dispose();
  }
}
