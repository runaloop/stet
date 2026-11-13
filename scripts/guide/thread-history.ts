import { Demo, withBrowser } from "./lib.ts";

/** Replacement, deletion and unknown placement are separate from the discussion's state. */
export async function threadHistoryGuide() {
  const demo = new Demo();
  let checked = 0;
  const check = (ok: boolean, label: string) => { if (!ok) throw new Error(label); checked++; console.log(`ok ${label}`); };
  const source = (field: string, tail = "") => `export class RetryQueue {\n  constructor() {}\n  options = {\n    ${field},\n    enabled: true,\n  };\n}\n${tail}`;
  const rewrite = Array.from({ length: 30 }, (_, i) => `export const entry${i + 1} = ${i + 1};`);
  try {
    demo.write("src/RetryQueue.ts", source("oldLimit: 1"));
    demo.write("src/LegacyQueue.ts", "export class LegacyQueue {\n  retry() { return 1; }\n}\n");
    demo.write("src/Entries.ts", rewrite.join("\n") + "\n");
    demo.commitBase();
    demo.stet("version", "create", "--label", "Initial queue configuration");
    const thread = (file: string, range: string, body: string) => demo.stet("comment", "add", "--file", file, "--range", range, "--at", "1", "--body", body, "--as", "reviewer").id as number;
    const replaced = thread("src/RetryQueue.ts", "4", "Does this option belong in the queue configuration?");
    const deleted = thread("src/LegacyQueue.ts", "2", "Can this legacy path be removed?");
    const unlocated = thread("src/Entries.ts", "10-12", "Explain these entries before rewriting them.");
    demo.write("src/RetryQueue.ts", source("oldLimit: 1", "export const active = true;\n"));
    demo.stet("version", "create", "--label", "An unrelated follow-up");
    demo.write("src/RetryQueue.ts", source("retryLimit: 3", "export const active = true;\n"));
    demo.remove("src/LegacyQueue.ts");
    const next = [...rewrite];
    next.splice(2, 20, ...Array.from({ length: 20 }, (_, i) => `export const replacement${i + 1} = 'new';`));
    demo.write("src/Entries.ts", next.join("\n") + "\n");
    demo.stet("version", "create", "--label", "Replace the option and retire the legacy queue");
    demo.stet("version", "create", "--allow-empty", "--label", "A later version preserves history");
    await withBrowser(demo, async (p) => {
      await p.b.send("browsingContext.activate", { context: p.b.context });
      const open = async (id: number) => {
        await p.go(`#/thread/${id}`);
        await p.waitFor(`document.querySelector('.detail-head .tid')?.textContent === '#${id}'`);
        await p.waitFor(`document.querySelector('.code-area diffs-container')?.shadowRoot?.querySelector('[data-line]')`);
      };
      const notice = () => p.eval(`document.querySelector('.thread-code-notice')?.textContent`);
      await open(replaced);
      await p.waitFor(`document.querySelector('[data-code-state="replaced"]')`);
      check(await p.eval(`document.querySelector('[data-side="old"]').textContent.includes('v1') && document.querySelector('[data-side="new"]').textContent.includes('v4')`), "replacement labels the original and selected versions");
      const marker = await p.eval(`(() => { const host = document.querySelector('.code-area diffs-container'); const m = host.querySelector('.thread-marker') ?? host.shadowRoot.querySelector('.thread-marker'); if (!m) return null; const r = m.getBoundingClientRect(); const h = host.getBoundingClientRect(); return { left: r.left, mid: h.left + h.width / 2, text: m.textContent }; })()`);
      check(marker && marker.left < marker.mid && marker.text.includes('historical location'), "the replacement's thread marker is on the old side, with its historical version");
      const versions = await p.need(".thread-version-headings");
      const banner = await p.need(".thread-code-notice");
      await p.shot("thread-history-replaced.png", [
        { html: "① The original lines were replaced. Their thread marker belongs to the earlier code, not to its replacement", at: { x: 1350, y: 180 }, ring: banner, w: 390 },
        { html: "② Both sides name their version: original commented code and selected version", at: { x: 1350, y: 380 }, ring: versions, w: 390 },
      ]);
      await p.click(await p.need(".code-tabs button", "At v4"));
      await p.waitFor(`document.querySelector('[data-code-state="replaced"]')?.textContent.includes('This is their replacement')`);
      check(await p.eval(`!document.querySelector('.code-area .thread-marker')`), "the single-version replacement does not acquire the original thread marker");
      await p.click(await p.need('[data-code-state="replaced"] button'));
      await p.waitFor(`document.querySelector('[data-side="old"]')`);
      await p.click(await p.need(".code-tabs button", "unified"));
      await p.waitFor(`document.querySelector('.code-tabs > button:last-child')?.textContent === 'split'`);
      check((await notice()).includes("replaced"), "unified diff keeps the explicit replacement notice and version labels");
      await p.click(await p.need(".code-tabs button", "split"));

      await open(deleted);
      await p.waitFor(`document.querySelector('.historical-code.deleted')`);
      check((await notice()).includes("File deleted at v3") && (await notice()).includes("still open"), "later versions preserve the confirmed deletion version without resolving the discussion");
      check(await p.eval(`document.querySelector('.thread-code-absent').textContent.includes('v4') && !document.querySelector('.historical-code [data-side="new"]')`), "the selected version is empty and old source has a separate historical frame");
      check(await p.eval(`!!document.querySelector('.historical-code diffs-container').shadowRoot.querySelector('[data-stet-mark~="history-removed"]')`), "the deleted fragment is marked in red with a minus on its historical lines");
      await p.shot("thread-history-deleted.png", [{ html: "③ This file is absent at v4. The source below is explicitly historical; the discussion stays open", at: { x: 1350, y: 250 }, ring: await p.need(".thread-code-absent"), w: 390 }]);
      await p.click(await p.need(".code-tabs button", "At v4"));
      await p.waitFor(`document.querySelector('.historical-code h4')?.textContent.includes('v2')`);
      check(true, "At step falls back to the last known version with an explicit historical label");
      await p.click(await p.need(".code-tabs button", "Then"));
      await p.waitFor(`document.querySelector('.historical-code h4')?.textContent.includes('v1')`);
      check((await notice()).includes("deleted"), "Then retains the deletion notice above the original historical code");
      await p.click(await p.need(".code-tabs button", "Diff"));

      await open(unlocated);
      await p.waitFor(`document.querySelector('.historical-code.unlocated')`);
      check((await notice()).includes("Cannot locate") && (await notice()).includes("Deletion is not confirmed"), "an unlocated anchor never claims that its code was deleted");
      check(await p.eval(`!document.querySelector('.historical-code diffs-container').shadowRoot.querySelector('[data-stet-mark~="history-removed"]')`), "unknown placement does not paint historical source as confirmed deletion");
      await p.shot("thread-history-unlocated.png", [{ html: "④ A lost location is not proof of deletion. The earlier source remains available without a deletion claim", at: { x: 1350, y: 240 }, ring: await p.need(".thread-code-notice"), w: 390 }]);
      check([replaced, deleted, unlocated].every((id) => demo.stet("thread", "show", String(id)).thread.status === "open"), "viewing replacement, deletion and historical source never resolves any thread");
    });
    console.log(`${checked} thread history browser checks passed`);
  } finally { demo.dispose(); }
}
