import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureReview, openContext, type Ctx } from "../src/core/context.ts";
import { collectExport, exportMarkdown, gist } from "../src/core/export.ts";
import { addReply, addThread, createVersion, resolveThread, submitReview } from "../src/core/service.ts";
import type { ReviewRow } from "../src/core/store/db.ts";
import { ok, stet } from "./helpers/cli.ts";
import { Fixture, lines } from "./helpers/fixture.ts";
import { png } from "./helpers/png.ts";

describe("gist", () => {
  test("sentences from the start of the first paragraph of prose until there is enough to say something", () => {
    expect(gist("The variants come from the backend schema, so they stay open. A sealed class would break the parser.")).toBe(
      "The variants come from the backend schema, so they stay open.",
    );
    expect(gist("Да. Оставили как есть: варианты приходят из схемы бэкенда, менять её нельзя. Подробнее в ADR-12.")).toBe(
      "Да. Оставили как есть: варианты приходят из схемы бэкенда, менять её нельзя.",
    );
    expect(gist("Хорошая идея. Записал. Сделаю в следующей версии, вместе с тестами. Остальное потом.")).toBe(
      "Хорошая идея. Записал. Сделаю в следующей версии, вместе с тестами.",
    );
    expect(gist("```kotlin\nval x = 1\n```\n\nSee the fence above\nfor the case.\n\nMore.")).toBe("See the fence above for the case.");
    expect(gist("- Согласен.\n\nДальше другой абзац.")).toBe("Согласен.");
    expect(gist("```\nonly code\n```")).toBeNull();
  });

  test("cuts a long sentence at a word", () => {
    const g = gist(`Yes. ${"word ".repeat(60)}end.`)!;
    expect(g.length).toBeLessThanOrEqual(141);
    expect(g).toStartWith("Yes. word word");
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
        `- #${ids.answered} Why not a sealed class? (a.kt:11) — answered at v2: Оставили как есть: варианты приходят из схемы бэкенда. Подробнее в ADR-12.`,
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

describe("export of threads the agent opened", () => {
  test("the gist comes from the reviewer's last reply, never from the opening question", async () => {
    const f = new Fixture();
    try {
      f.write("a.kt", lines(10));
      f.commit("base");
      f.git(["checkout", "-q", "-b", "feat"]);
      const reviewer = await openContext({ cwd: f.root, role: "reviewer", author: "alice" });
      const agent = await openContext({ cwd: f.root, role: "agent", author: "claude" });
      const review = await ensureReview(agent);
      f.write("a.kt", lines(11));
      await createVersion(agent, review, {});
      const asked = await addThread(agent, review, { path: "a.kt", start: 2, end: 2, at: "1", body: "Куда G: в общий модуль или в фичу?" });
      await addReply(reviewer, review, asked.id, { body: "Хорошая мысль." });
      await addReply(reviewer, review, asked.id, { body: "Да. В общий модуль: он нужен двум фичам сразу, и платёжной, и профилю. Остальное потом." });
      resolveThread(reviewer, review, asked.id, "answered");
      const silent = await addThread(agent, review, { path: "a.kt", start: 5, end: 5, at: "1", body: "Оставить старый формат?" });
      resolveThread(reviewer, review, silent.id, "answered");

      expect(exportMarkdown(await collectExport(reviewer, review))).toBe(
        [
          "### Review: v1",
          "",
          `- #${asked.id} Куда G: в общий модуль или в фичу? (a.kt:2) — answered at v1: Да. В общий модуль: он нужен двум фичам сразу, и платёжной, и профилю.`,
          `- #${silent.id} Оставить старый формат? (a.kt:5) — answered at v1`,
          "",
        ].join("\n"),
      );
    } finally {
      f.cleanup();
    }
  }, 30_000);
});

describe("stet export", () => {
  const f = new Fixture();
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const agent = { cwd: f.root, role: "agent" as const };

  beforeAll(async () => {
    f.write("a.txt", lines(10));
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    await ok(stet(["version", "create"], agent));
    await ok(stet(["comment", "add", "--file", "a.txt", "--range", "2-3", "--at", "1", "--body", "Почему так?"], reviewer));
  }, 30_000);

  afterAll(() => f.cleanup());

  test("prints Markdown when piped, and JSON only with --json", async () => {
    const r = await stet(["export"], { ...agent, json: false });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("### Review: v1\n\nOpen:\n\n- #1 Почему так? (a.txt:2-3) — waits for the agent\n");
    const all = await stet(["export", "--all"], { ...agent, json: false });
    expect(all.stdout).toStartWith("# Review of feat\n");
    const json = await ok(stet(["export"], agent));
    expect(json.threads[0].thread.title).toBe("Почему так?");
  });

  test("--out writes the file and refuses to overwrite it without --force", async () => {
    const file = join(f.root, "..", `${f.root.split("/").pop()}-review.md`);
    try {
      const r = await ok(stet(["export", "--out", file], { ...agent, json: false }));
      expect(r.out).toBe(file);
      expect(readFileSync(file, "utf8")).toStartWith("### Review: v1\n");
      const again = await stet(["export", "--all", "--out", file], { ...agent, json: false });
      expect(again.code).toBe(3);
      expect(again.stderr).toContain("--force");
      await ok(stet(["export", "--all", "--out", file, "--force"], { ...agent, json: false }));
      expect(readFileSync(file, "utf8")).toStartWith("# Review of feat\n");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("exports a closed review, by branch or by id", async () => {
    await ok(stet(["review", "close"], reviewer));
    expect((await stet(["status"], agent)).code).toBe(2);
    const r = await stet(["export"], { ...agent, json: false });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Почему так?");
    const byId = await stet(["export", "--all", "--review", "1", "-b", "nowhere"], { ...agent, json: false });
    expect(byId.stdout).toMatch(/^- Started .*, closed .* UTC$/m);
  });
});
