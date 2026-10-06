import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { formatStatus, formatVersions } from "../src/cli/format.ts";
import { guideMarkdown, parseGuide, threadsIn } from "../src/core/guide.ts";
import { ok, stet } from "./helpers/cli.ts";
import { edit, Fixture, lines } from "./helpers/fixture.ts";

const GUIDE = `# Verdict on submit

1. Keep the verdict with the submission, so the history shows
   who approved what and when.
   src/store.ts:3-5
2. The CLI takes --verdict; \`stet wait\` reports "approved" to the agent,
   which closes #12 and answers #7.

   A second paragraph, and \`#99\` in code is no thread.
   src/cli.ts:2-4
   src/service.ts:7
3. Tests for both verdicts.
   test/verdict.test.ts
`;

describe("the guide format", () => {
  test("steps with text over several lines, several references, whole files and thread references", () => {
    const g = parseGuide(GUIDE);
    expect(g.title).toBe("Verdict on submit");
    expect(g.intro).toBe("");
    expect(g.steps).toEqual([
      {
        text: "Keep the verdict with the submission, so the history shows\nwho approved what and when.",
        refs: [{ path: "src/store.ts", range: { start: 3, end: 5 } }],
        threads: [],
      },
      {
        text: 'The CLI takes --verdict; `stet wait` reports "approved" to the agent,\nwhich closes #12 and answers #7.\n\nA second paragraph, and `#99` in code is no thread.',
        refs: [
          { path: "src/cli.ts", range: { start: 2, end: 4 } },
          { path: "src/service.ts", range: { start: 7, end: 7 } },
        ],
        threads: [12, 7],
      },
      { text: "Tests for both verdicts.", refs: [{ path: "test/verdict.test.ts", range: null }], threads: [] },
    ]);
  });

  test("printed back in the format it was written in", () => {
    const g = parseGuide(GUIDE);
    expect(parseGuide(guideMarkdown({ ...g, steps: g.steps.map((s, i) => ({ ...s, index: i + 1 })) }))).toEqual(g);
    expect(guideMarkdown({ title: "T", intro: "", steps: [{ index: 1, text: "a\nb", refs: [{ path: "x.ts", range: { start: 2, end: 2 } }], threads: [] }] })).toBe(
      "# T\n\n1. a\n   b\n   x.ts:2\n",
    );
  });

  test("no title, text before the first step, ) after the number, ./ and backticks around a path", () => {
    const g = parseGuide("Why this change.\n\n1) First\n   `./a.ts:1`\n10. Second\n    b.ts\n");
    expect(g.title).toBeNull();
    expect(g.intro).toBe("Why this change.");
    expect(g.steps.map((s) => [s.text, s.refs])).toEqual([
      ["First", [{ path: "a.ts", range: { start: 1, end: 1 } }]],
      ["Second", [{ path: "b.ts", range: null }]],
    ]);
  });

  test("a guide without steps, a step without lines or text, and bad ranges are refused, all of them at once", () => {
    expect(() => parseGuide("# Only a title\n\nSome words.")).toThrow("the guide has no steps");
    let message = "";
    try {
      parseGuide("1. Names nothing\n   and goes on.\n2.\n   a.ts:1\n3. Bad range\n   a.ts:5-2\n4. Outside\n   ../x.ts\n");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("step 1 names no lines");
    expect(message).toContain("step 2 has no text");
    expect(message).toContain("step 3: a.ts:5-2: a range is a-b");
    expect(message).toContain("step 4: ../x.ts: give the path from the repository's root");
  });

  test("a short last line of text is text, not a reference: a reference has a folder or an extension, and no punctuation at its end", () => {
    const g = parseGuide(
      [
        "1. Дифф после возврата остаётся",
        "   прежним.",
        "   test/perf/ui-check.ts:1781-1826",
        "2. Two lines of text,",
        "   done",
        "   Makefile.am",
        "3. Ends in a word with a colon:",
        "   see:",
        "   src/a.ts",
        "4. And with a comma or a dot after a path",
        "   src/a.ts,",
        "   docs/",
        "   web/lib/guide.ts:3",
      ].join("\n"),
    );
    expect(g.steps.map((s) => [s.text.split("\n").pop(), s.refs.map((r) => r.path)])).toEqual([
      ["прежним.", ["test/perf/ui-check.ts"]],
      ["done", ["Makefile.am"]],
      ["see:", ["src/a.ts"]],
      ["docs/", ["web/lib/guide.ts"]],
    ]);
    expect(g.steps[3]!.text).toBe("And with a comma or a dot after a path\nsrc/a.ts,\ndocs/");
    expect(() => parseGuide("1. Только текст,\n   и в конце слово\n   прежним.\n")).toThrow("step 1 names no lines");
    expect(() => parseGuide("1. A file without a folder or an extension\n   Makefile\n")).toThrow("step 1 names no lines");
  });

  test("thread references outside code", () => {
    expect(threadsIn("fixes #3, see #3 and #10; not `#4`, not a&#5, not x#6")).toEqual([3, 10]);
  });
});

describe("a version with a guide", () => {
  const f = new Fixture();
  const agent = { cwd: f.root, role: "agent" as const };
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const guideFile = join(f.root, "..", `${f.root.split("/").pop()}-guide.md`);

  beforeAll(async () => {
    f.write("src/store.ts", lines(10));
    f.write("old.ts", lines(3));
    f.write("logo.png", "\x89PNG\r\n\x1a\n\0\0\0binary");
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    f.write("src/store.ts", edit(lines(10), (l) => (l[3] = "four, changed")));
    f.write("src/cli.ts", lines(6));
    f.write("src/service.ts", lines(8));
    f.write("test/verdict.test.ts", lines(2));
    f.rm("old.ts");
  });

  afterAll(() => {
    f.cleanup();
    Bun.spawnSync(["rm", "-f", guideFile]);
  });

  const create = async (text: string) => {
    await Bun.write(guideFile, text);
    return stet(["version", "create", "--label", "verdict", "--guide", guideFile], agent);
  };

  test("is refused when a path is not in it or a range is past the end of its file, naming each", async () => {
    const r = await create(
      `# G\n\n1. Store\n   src/store.ts:3-11\n   src/nope.ts\n2. Gone file, picture\n   old.ts\n   logo.png\n3. Lines of a picture\n   logo.png:1\n   old.ts:1\n`,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("so no version was created");
    expect(r.stderr).toContain("step 1: src/store.ts:3-11: the file has 10 lines in this version");
    expect(r.stderr).toContain("step 1: src/nope.ts: no such file in this version");
    expect(r.stderr).not.toContain("step 2");
    expect(r.stderr).toContain("step 3: logo.png:1: a binary file has no lines");
    expect(r.stderr).toContain("step 3: old.ts:1: no such file in this version");
    expect(await ok(stet(["versions", "list"], agent))).toEqual([]);
  });

  test("a guide that does not parse is refused before anything is taken", async () => {
    const r = await create("# G\n\nno steps here\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the guide has no steps");
    const missing = await stet(["version", "create", "--guide", join(f.root, "missing.md")], agent);
    expect(missing.stderr).toContain("--guide: no file");
  });

  test("is stored with the version; versions list, status and stet guide show it", async () => {
    const created = await ok(create(GUIDE.replace("src/service.ts:7", "src/service.ts:7\n   old.ts")));
    expect(created.version).toMatchObject({ number: 1, label: "verdict", guide: true });

    const vs = await ok(stet(["versions", "list"], agent));
    expect(vs.map((v: { number: number; guide?: boolean }) => [v.number, v.guide])).toEqual([[1, true]]);
    expect(formatVersions(vs)).toContain("guide");
    const s = await ok(stet(["status"], reviewer));
    expect(s.latest.guide).toBe(true);
    expect(formatStatus(s)).toContain("guide: stet guide");

    const g = await ok(stet(["guide"], reviewer));
    expect(g).toMatchObject({ version: 1, title: "Verdict on submit", intro: "" });
    expect(g.steps.map((x: { index: number; refs: unknown[]; threads: number[] }) => [x.index, x.refs.length, x.threads])).toEqual([
      [1, 1, []],
      [2, 3, [12, 7]],
      [3, 1, []],
    ]);
    expect(g.steps[1].refs[2]).toEqual({ path: "old.ts", range: null });
    expect(await ok(stet(["guide", "v1"], reviewer))).toEqual(g);
    expect(guideMarkdown(g)).toContain("2. The CLI takes --verdict;");
    expect(guideMarkdown(g)).toContain("\n   src/service.ts:7\n   old.ts\n3. Tests");
  });

  test("a version without one has none to print, and a guide needs a version", async () => {
    f.write("src/cli.ts", lines(7));
    await ok(stet(["version", "create"], agent));
    const vs = await ok(stet(["versions", "list"], agent));
    expect(vs[1].guide).toBeUndefined();
    const none = await stet(["guide"], reviewer);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("a guide to v2 not found");
    expect((await stet(["guide", "now"], reviewer)).stderr).toContain("a guide belongs to a version");
  });
});

describe("a guide the reviewer asks for", () => {
  const f = new Fixture();
  const agent = { cwd: f.root, role: "agent" as const };
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  const guideFile = join(f.root, "..", `${f.root.split("/").pop()}-asked.md`);

  beforeAll(async () => {
    f.write("a.ts", lines(10));
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    f.write("a.ts", edit(lines(10), (l) => (l[2] = "three, changed")));
    await ok(stet(["version", "create"], agent));
  });

  afterAll(() => {
    f.cleanup();
    Bun.spawnSync(["rm", "-f", guideFile]);
  });

  const draft = (body: string) => ok(stet(["comment", "add", "--file", "a.ts", "--range", "3-3", "--at", "1", "--body", body, "--draft"], reviewer));

  test("agent.guide is on unless set off, and status says so for the next version", async () => {
    expect((await ok(stet(["status"], agent))).guide).toBe("on");
    const bad = await stet(["config", "set", "agent.guide", "maybe"], agent);
    expect(bad.stderr).toContain("agent.guide takes on or off");
    await ok(stet(["config", "set", "agent.guide", "off"], agent));
    const s = await ok(stet(["status"], agent));
    expect(s.guide).toBe("off");
    expect(formatStatus(s)).toContain("guide to the next version: none (agent.guide off)");
  });

  test("a review asks for one with --guide, not with an approval; status and wait tell the agent", async () => {
    await draft("why three?");
    const refused = await stet(["review", "submit", "--approve", "--guide"], reviewer);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("goes with a request for changes");
    const r = await ok(stet(["review", "submit", "--guide"], reviewer));
    expect(r.guide).toBe(true);
    const s = await ok(stet(["status"], agent));
    expect(s.guide).toBe("requested");
    expect(formatStatus(s)).toContain("requested by the reviewer");
    const w = await ok(stet(["wait", "--for", "review", "--timeout", "1s"], agent));
    expect(w).toMatchObject({ reason: "pending", guide: "requested" });
  });

  test("a version without the guide asked for is made, with a warning; the request is then answered", async () => {
    f.write("a.ts", edit(lines(10), (l) => (l[2] = "three, again")));
    const r = await stet(["version", "create"], agent);
    expect(r.code).toBe(0);
    expect(r.json.version).toMatchObject({ number: 2, guideRequested: true });
    expect(r.json.version.guide).toBeUndefined();
    expect(r.json.warning).toContain("the reviewer asked for a guide to this version and it has none");
    expect((await ok(stet(["status"], agent))).guide).toBe("off");
  });

  test("the version that brings the guide asked for is marked as its answer; a review that does not ask leaves the setting", async () => {
    await draft("and four?");
    await ok(stet(["review", "submit", "--guide"], reviewer));
    f.write("a.ts", edit(lines(10), (l) => (l[3] = "four, changed")));
    await Bun.write(guideFile, "# Four\n\n1. Four changed, as #2 asked.\n   a.ts:4\n");
    const v3 = await ok(stet(["version", "create", "--guide", guideFile], agent));
    expect(v3).toEqual({ version: expect.objectContaining({ number: 3, guide: true, guideRequested: true }) });
    await draft("and five?");
    await ok(stet(["review", "submit"], reviewer));
    expect((await ok(stet(["status"], agent))).guide).toBe("off");
    await ok(stet(["config", "set", "agent.guide", "--unset"], agent));
    expect((await ok(stet(["status"], agent))).guide).toBe("on");
    const vs = await ok(stet(["versions", "list"], agent));
    expect(vs.map((v: { guide?: true; guideRequested?: true }) => [v.guide ?? false, v.guideRequested ?? false])).toEqual([
      [false, false],
      [false, true],
      [true, true],
    ]);
  });
});
