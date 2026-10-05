import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { ensureReview, openContext, type Ctx } from "../src/core/context.ts";
import { collectExport, exportMarkdown, gist } from "../src/core/export.ts";
import { addReply, addThread, createVersion, resolveThread, submitReview } from "../src/core/service.ts";
import type { ReviewRow } from "../src/core/store/db.ts";
import { Fixture, lines } from "./helpers/fixture.ts";
import { png } from "./helpers/png.ts";

describe("gist", () => {
  test("the first sentence of the first paragraph of prose", () => {
    expect(gist("Kept as is. The variants come from the schema.")).toBe("Kept as is.");
    expect(gist("```kotlin\nval x = 1\n```\n\nSee the fence above\nfor the case.\n\nMore.")).toBe("See the fence above for the case.");
    expect(gist("- Оставили как есть: схема бэкенда! Подробности ниже.")).toBe("Оставили как есть: схема бэкенда!");
    expect(gist("```\nonly code\n```")).toBeNull();
  });

  test("cuts a long sentence at a word", () => {
    const g = gist(`${"word ".repeat(60)}end.`)!;
    expect(g.length).toBeLessThanOrEqual(141);
    expect(g.endsWith("word…")).toBe(true);
  });
});

describe("export", () => {
  const f = new Fixture();
  let reviewer: Ctx;
  let agent: Ctx;
  let review: ReviewRow;
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    f.write("a.kt", lines(20));
    f.write("b.kt", lines(10, "net"));
    f.write("gone.kt", lines(5, "old"));
    writeFileSync(f.path("logo.png"), png(40, 20, () => [255, 0, 0, 255]));
    f.commit("base");
    f.git(["checkout", "-q", "-b", "feat"]);
    reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
    agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
    review = await ensureReview(agent);
    f.write("a.kt", lines(21));
    await createVersion(agent, review, { label: "first take" });

    const thread = async (key: string, path: string, start: number, end: number, body: string, region?: { x: number; y: number; w: number; h: number }) => {
      ids[key] = (await addThread(reviewer, review, { path, start, end, at: "1", body, draft: true, region })).id;
    };
    await thread("fixed", "a.kt", 2, 3, "Кэш не сбрасывается при выходе\n\nПодробности: после logout старые данные.");
    await thread("answered", "a.kt", 10, 10, "Why not a sealed class?");
    await thread("wontfix", "b.kt", 4, 4, "Retry without backoff");
    await thread("outdated", "gone.kt", 2, 3, "Is this file still needed?");
    await thread("image", "logo.png", 1, 1, "The red is too loud", { x: 5, y: 2, w: 10, h: 8 });
    submitReview(reviewer, review, { body: "Первый проход: see the threads." });

    await addReply(agent, review, ids.fixed!, { body: "Сбрасываю кэш в logout().", intent: "fixed" });
    await addReply(agent, review, ids.answered!, { body: "Оставили как есть: варианты приходят из схемы бэкенда. Подробнее в ADR-12.", intent: "answered" });
    await addReply(agent, review, ids.wontfix!, { body: "OkHttp's interceptor already retries, with backoff.\n\n```kotlin\nclient.retry()\n```", intent: "disagree" });
    f.write("a.kt", "first\n" + lines(21));
    f.rm("gone.kt");
    await createVersion(agent, review, { label: "fixes" });

    resolveThread(reviewer, review, ids.fixed!, "fixed");
    resolveThread(reviewer, review, ids.answered!, "answered");
    resolveThread(reviewer, review, ids.wontfix!, "wontfix");
    submitReview(reviewer, review, { verdict: "approved", body: "LGTM", open: "keep" });

    await addThread(reviewer, review, { path: "a.kt", start: 5, end: 5, at: "2", body: "SECRET reviewer draft", draft: true });
    await addReply(reviewer, review, ids.outdated!, { body: "SECRET reviewer draft reply", draft: true });
    await addReply(agent, review, ids.image!, { body: "SECRET agent draft reply", draft: true });
  }, 60_000);

  afterAll(() => f.cleanup());

  test("the summary: a line per published thread with its outcome and place, no bodies", async () => {
    const md = exportMarkdown(await collectExport(reviewer, review));
    expect(md).toBe(
      [
        "### Review: 2 rounds, v1–v2, approved at v2",
        "",
        `- #${ids.fixed} Кэш не сбрасывается при выходе (a.kt:3-4) — fixed in v2`,
        `- #${ids.answered} Why not a sealed class? (a.kt:11) — answered at v2: Оставили как есть: варианты приходят из схемы бэкенда.`,
        `- #${ids.wontfix} Retry without backoff (b.kt:4) — won't fix at v2: OkHttp's interceptor already retries, with backoff.`,
        "",
        "Open:",
        "",
        `- #${ids.outdated} Is this file still needed? (gone.kt:2-3 in v1) — outdated, waits for the agent`,
        `- #${ids.image} The red is too loud (logo.png, 10×8 at 5,2 of 40×20) — waits for the agent`,
        "",
      ].join("\n"),
    );
  });

  test("the full dump: versions, reviews, code then and now, whole conversations and timelines", async () => {
    const md = exportMarkdown(await collectExport(reviewer, review), { all: true });
    expect(md).toStartWith("# Review of feat\n\n- 2 rounds, v1–v2, approved at v2\n");
    expect(md).toMatch(/^- v1 · .* · claude \(agent\) · snapshot [0-9a-f]{10} · first take$/m);
    expect(md).toMatch(/^### Review 1: changes requested at v1 · .*\n\n> Первый проход: see the threads\.$/m);
    expect(md).toMatch(/^### Review 2: approved at v2 · .*\n\n> LGTM$/m);
    expect(md).toContain(`### #${ids.fixed} Кэш не сбрасывается при выходе\n\n- Status: resolved, fixed by alice · `);
    expect(md).toContain("- Written on: `a.kt:2-3` at v1\n- Now: `a.kt:3-4` at v2, moved\n");
    expect(md).toContain("#### Code then (v1)\n\n```\n  1  line 1\n> 2  line 2\n> 3  line 3\n");
    expect(md).toContain("#### Code now (v2)\n\n```\n  1  first\n  2  line 1\n> 3  line 2\n> 4  line 3\n");
    expect(md).toContain("> Кэш не сбрасывается при выходе\n>\n> Подробности: после logout старые данные.");
    expect(md).toMatch(/\*\*#\d+ claude\*\* \(agent, fixed · .* · at v1\)\n\n> Сбрасываю кэш в logout\(\)\./);
    expect(md).toContain("> ```kotlin\n> client.retry()\n> ```");
    expect(md).toMatch(/_Resolved by the reviewer · .* UTC_/);
    expect(md).toContain(`- v1: written, \`a.kt:2-3\` · comments #`);
    expect(md).toContain("- Now: outdated at v2 (file-deleted): the code it was on is gone");
    expect(md).toContain("- Image: `logo.png` at v1, area 10×8 at 5,2 of 40×20 (pixels from the top left)");
    expect(md).not.toContain("SECRET");
  });

  test("drafts stay out whoever exports", async () => {
    for (const ctx of [reviewer, agent]) {
      const x = await collectExport(ctx, review);
      expect(x.threads.map((d) => d.thread.id)).toEqual([ids.fixed!, ids.answered!, ids.wontfix!, ids.outdated!, ids.image!]);
      expect(JSON.stringify(x)).not.toContain("SECRET");
      expect(x.threads.every((d) => d.comments.every((c) => !c.draft))).toBe(true);
    }
  });

  test("an approval followed by new code says so", async () => {
    f.write("b.kt", lines(11, "net"));
    await createVersion(agent, review, { label: "after the approval" });
    const md = exportMarkdown(await collectExport(agent, review));
    expect(md).toStartWith("### Review: 2 rounds, v1–v3, approved at v2 · changed after\n");
  });
});
