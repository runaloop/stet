import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Demo, withBrowser } from "./lib.ts";

export async function publicationGuide() {
  const demo = new Demo();
  const source = "export const retryLimit = 3;\n";
  let checked = 0;
  const check = (ok: boolean, what: string) => { if (!ok) throw new Error(what); checked++; console.log(`ok ${what}`); };
  try {
    demo.write("src/queue.ts", "export const retryLimit = 1;\n");
    demo.commitBase();
    const init = demo.stet("init", "--staged");
    const review = init.review.id as number;
    demo.write("src/queue.ts", source);
    demo.git("add", "src/queue.ts");
    demo.stet("version", "create", "--label", "Keep pending jobs on retry");
    const file = join(tmpdir(), "stet-guide", "publication-plan.json");
    const input = { schema: 1, review, version: 1, protection: "local", actions: ["commit"],
      commit: { message: "Keep pending jobs on retry\n\nPreserve the reviewed queue behavior.\n",
        author: { name: "Author", email: "author@example.com" }, committer: { name: "Publisher", email: "publisher@example.com" }, signing: "none", timestamps: "execution" } };
    mkdirSync(join(tmpdir(), "stet-guide"), { recursive: true });
    writeFileSync(file, JSON.stringify(input));
    let plan = demo.stet("publication", "prepare", "--file", file);
    const view = () => demo.stet("publication", "show", plan.id);
    await withBrowser(demo, async (p) => {
      await p.b.send("browsingContext.activate", { context: p.b.context });
      const ready = async () => {
        await p.go(`#/drafts?review=${review}`);
        await p.waitFor(`document.querySelector('.publication-card') && document.querySelector('.publication-card').getAttribute('aria-busy') === 'false'`);
      };
      const scroll = (sel: string) => p.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'}); true`);
      const click = async (sel: string) => { await scroll(sel); await p.click(await p.need(sel)); };
      const pick = async () => {
        await p.waitFor(`document.querySelector('.publication-scope input:not(:disabled)') && document.querySelector('.publication-card').getAttribute('aria-busy') === 'false'`);
        await click(".publication-scope input");
        await p.waitFor(`!document.querySelector('.publication-card .btn.approve').disabled`);
      };
      const authorize = async () => {
        await pick();
        await click(".publication-card .btn.approve");
        await p.waitFor(`document.querySelector('.publication-status').textContent === 'Authorized: one commit'`);
      };
      const control = async (text: string) => {
        const sel = `.publication-controls button`;
        await p.eval(`[...document.querySelectorAll(${JSON.stringify(sel)})].find(e => e.textContent === ${JSON.stringify(text)}).scrollIntoView({block:'center'}); true`);
        await p.click(await p.need(sel, text));
      };
      await ready();
      check(await p.eval(`!document.querySelector('.publication-scope input').checked && document.querySelector('.publication-card .btn.approve').disabled`), "publication scopes start unchecked");
      check(view().grant === null, "preparation creates no permission");
      await scroll(".publication-card");
      const card = await p.need(".publication-card");
      const scope = await p.need(".publication-scope");
      await p.shot("publication-1.png", [
        { html: "① Code approval and publication permission are separate. This card names the version, branch, message and attribution", at: { x: 1350, y: 165 }, ring: { ...card, h: Math.min(card.h, 250) }, w: 390 },
        { html: "② Nothing is selected for you. Choose the action, then authorize it; this does not execute the commit", at: { x: 1350, y: 520 }, ring: scope, w: 390 },
      ]);
      await p.eval(`document.activeElement?.blur(); true`);
      await p.keys("S");
      await p.sleep(500);
      await ready();
      check(view().grant === null, "S approves code without authorizing publication");
      await pick();
      await p.keys("\uE004");
      check(await p.eval(`document.activeElement?.textContent === 'Approve v1 and authorize commit'`), "Tab focuses the explicit consent action");
      await p.keys("\uE007");
      await p.waitFor(`document.querySelector('.publication-status').textContent === 'Authorized: one commit'`);
      check(view().decision.allowed, "keyboard consent authorizes only the selected exact commit");
      await scroll(".publication-card");
      const allowed = await p.need(".publication-status");
      await p.shot("publication-2.png", [{ html: "③ The agent may now request this one commit. Changes, expiry, pause or revocation stop future dispatch", at: { x: 1350, y: 260 }, ring: allowed, w: 390 }]);
      await control("Pause publication");
      await p.waitFor(`document.querySelector('.publication-status').textContent === 'Publication paused'`);
      check(!view().decision.allowed, "pause blocks a previously authorized action");
      await control("Resume publication");
      await p.waitFor(`document.querySelector('.publication-status').textContent !== 'Publication paused' && !!document.querySelector('.publication-scope input:not(:disabled)') && document.querySelector('.publication-card').getAttribute('aria-busy') === 'false'`);
      check(!view().decision.allowed && !await p.eval(`document.querySelector('.publication-scope input').checked`), "resume requires fresh consent");
      await authorize();
      await control("Revoke permission");
      await p.waitFor(`document.querySelector('.publication-status').textContent === 'Permission revoked'`);
      check(!view().decision.allowed, "revoke withdraws permission without changing the code verdict");
      await pick();
      demo.stet("version", "create", "--allow-empty", "--label", "Final queue behavior");
      await p.waitFor(`document.querySelector('.publication-card .btn.approve').disabled`, 10000);
      check(!view().decision.allowed, "a new version invalidates consent even with unchanged bytes");
      writeFileSync(file, JSON.stringify({ ...input, version: 2 }));
      plan = demo.stet("publication", "prepare", "--file", file);
      await p.waitFor(`document.querySelector('.publication-card h3') && document.querySelector('.publication-card').textContent.includes('Reviewed v2') && document.querySelector('.publication-card').getAttribute('aria-busy') === 'false'`, 10000);
      check(!await p.eval(`document.querySelector('.publication-scope input').checked`), "a replacement plan clears the old scope selection");
      await authorize();
      const receipt = demo.stet("publish", "--plan", plan.id, "--through", "commit", "--operation", "queue-commit");
      check(receipt.state === "confirmed" && demo.git("rev-parse", "HEAD^{tree}").trim() === plan.tree, "the agent executor creates exactly the approved tree");
      await p.waitFor(`document.querySelector('.publication-status').textContent.startsWith('Commit confirmed')`, 10000);
      check(demo.stet("publish", "--plan", plan.id, "--through", "commit", "--operation", "queue-commit").commit === receipt.commit, "retry returns the same receipt");
    });
    console.log(`${checked} publication browser checks passed`);
  } finally { demo.dispose(); }
}
