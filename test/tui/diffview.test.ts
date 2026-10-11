import { parsePatchFiles } from "@pierre/diffs";
import { afterAll, expect, test } from "bun:test";
import { Highlighter } from "../../src/tui/diff/highlight.ts";
import { CARD, FILE, type FileItem, type Item } from "../../src/tui/diff/model.ts";
import type { Hooks, TokenSource } from "../../src/tui/diff/paint.ts";
import { DiffView } from "../../src/tui/diff/view.ts";
import { line, plain, s, spread, type Line } from "../../src/tui/text.ts";

const PATCH = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,6 +1,8 @@
-const KEY = process.env.API_KEY ?? "";
+import { timingSafeEqual } from "node:crypto";
+
+const KEY = Buffer.from(process.env.API_KEY ?? "");
${" "}
 export function authorized(req: Request): boolean {
-  const given = req.headers.get("x-api-key") ?? "";
-  return given === KEY;
+  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
+  return given.length === KEY.length && timingSafeEqual(given, KEY);
 }
diff --git a/src/db.ts b/src/db.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/db.ts
@@ -0,0 +1,4 @@
+import { Database } from "bun:sqlite";
+
+export const db = new Database("limits.db");
+db.run("create table if not exists hits (key text, at int, a_rather_long_column_name_to_wrap text, another_one int)");
`;

const files = () => parsePatchFiles(PATCH, `p${Math.random()}`)[0]!.files;

const hooks: Hooks = {
  header: (f, w, at) => ({ spans: spread([s(`${f.collapsed ? "▸" : "▾"} ${f.key}`, "fh")], [s("[ ] viewed", "dim")], w), ...(at ? { fill: ["sel"] } : {}) }),
  group: (g, w) => line(s(`${g.open ? "▾" : "▸"} ${g.key}`.padEnd(w))),
  card: (_f, p, w, open, indent) =>
    open
      ? [line(s(" ".repeat(indent)), s(`╭─ #${p.threadId} `, "acc")), line(s(" ".repeat(indent)), s("│ a message")), line(s(" ".repeat(indent)), s("╰─"))]
      : [line(s(" ".repeat(indent)), s(`▲ #${p.threadId}  your turn  a message`.slice(0, Math.max(0, w - indent)), "acc"))],
  note: (_f, w) => line(s(" binary".padEnd(w), "dim")),
};

const plainTokens: TokenSource = { line: () => undefined, style: () => undefined };

function items(): Item[] {
  const [auth, db] = files();
  return [
    { kind: "file", key: "src/auth.ts", fd: auth!, collapsed: false, placed: [{ threadId: 1, side: "additions", range: { start: 6, end: 7 } }] },
    { kind: "file", key: "src/db.ts", fd: db!, collapsed: false, placed: [{ threadId: 3, side: "additions", range: { start: 4, end: 4 } }] },
  ];
}

function view(w: number, h: number, tokens = plainTokens): DiffView {
  const v = new DiffView(hooks, tokens);
  v.setSize(w, h);
  v.setItems(items());
  v.marks.set("src/auth.ts", { old: [], new: [{ start: 6, end: 7, strong: false }] });
  return v;
}

const text = (lines: Line[]) => `\n${lines.map((l) => plain(l).trimEnd()).join("\n")}\n`;

test("unified at 80 cells: removed lines above added ones, line numbers on both sides, the card under the thread's last line", () => {
  const v = view(80, 24);
  expect(v.split).toBe(false);
  const out = text(v.lines());
  expect(out).toContain("  1    - const KEY = process.env.API_KEY");
  expect(out).toContain("     1 + import { timingSafeEqual }");
  expect(out).toMatch(/▌ {4}7 \+ {3}return given\.length/);
  expect(out).toMatchSnapshot();
});

test("split once each side gets 72 cells: the old line left of the new one", () => {
  const v = view(170, 20);
  expect(v.split).toBe(true);
  const out = text(v.lines());
  expect(out).toMatch(/1 - const KEY = process\.env\.API_KEY \?\? "";\s+│\s+1 \+ import \{ timingSafeEqual \}/);
  expect(out).toMatchSnapshot();
  v.setLayout("unified");
  expect(v.split).toBe(false);
});

test("wrap breaks a long line under its gutter; without wrap it is cut with › and scrolls sideways", () => {
  const v = view(70, 30);
  const wrapped = text(v.lines());
  expect(wrapped).toContain("rather_long_column_name_to_wrap");
  expect(wrapped.split("\n").filter((l) => l.startsWith("         ")).length).toBeGreaterThan(0);
  v.setWrap(false);
  const cut = text(v.lines());
  expect(cut).toContain("›");
  v.scrollSide(20);
  expect(text(v.lines())).not.toContain(`db.run("create`);
  expect(wrapped).toMatchSnapshot();
  expect(cut).toMatchSnapshot();
});

test("cards open and closed: the open card is taller and pushes the lines below it down", () => {
  const v = view(80, 30);
  const closed = text(v.lines());
  expect(closed).toContain("▲ #1  your turn");
  v.toggleCard(1);
  const open = text(v.lines());
  expect(open).toContain("╭─ #1");
  expect(open.split("\n").indexOf(open.split("\n").find((l) => l.includes("▾ src/db.ts"))!)).toBe(closed.split("\n").indexOf(closed.split("\n").find((l) => l.includes("▾ src/db.ts"))!) + 2);
  expect(closed).toMatchSnapshot();
  expect(open).toMatchSnapshot();
});

test("a folded file is its header; the cursor and the view keep their line when a file above folds", () => {
  const v = view(80, 12);
  v.goTo(v.cardOf(3));
  const it = v.items.map((x) => (x.key === "src/auth.ts" ? { ...(x as FileItem), collapsed: true } : x));
  v.setItems(it);
  expect(v.info()!.thread).toBe(3);
  const y = v.lay.top(v.cursor) - v.top;
  expect(y >= 0 && y < v.height).toBe(true);
  const out = text(v.lines());
  expect(out).toContain("▸ src/auth.ts");
  expect(out).toMatchSnapshot();
});

test("moves: next file, next change, next card round the end, the page, the top and the end", () => {
  const v = view(80, 10);
  expect(v.rows.kind[v.cursor]).toBe(FILE);
  v.goTo(v.nextFile(1));
  expect(v.info()!.item.key).toBe("src/db.ts");
  v.goTo(v.nextFile(-1));
  expect(v.info()!.item.key).toBe("src/auth.ts");
  v.first();
  v.goTo(v.nextChange(1));
  expect(v.info()!.oldNo).toBe(1);
  v.goTo(v.nextChange(1));
  expect(v.info()!.oldNo).toBe(4);
  v.goTo(v.nextCard(1));
  expect(v.info()!.thread).toBe(1);
  v.goTo(v.nextCard(1));
  expect(v.info()!.thread).toBe(3);
  v.goTo(v.nextCard(1));
  expect(v.info()!.thread).toBe(1);
  v.last();
  expect(v.rows.kind[v.cursor]).toBe(CARD);
  expect(v.top + v.height).toBe(v.lay.total);
  v.page(-1);
  expect(v.top).toBeLessThan(v.lay.total - v.height);
  expect(v.threadAt(v.rowAtLine(0))).toBeNull();
});

test("the file's header stays on top while its lines scroll under it", () => {
  const v = view(80, 6);
  v.scroll(4);
  const out = v.lines();
  expect(plain(out[0]!)).toContain("▾ src/auth.ts");
  expect(v.rowAtLine(0)).toBe(0);
});

test("a resize keeps the line at the top of the view", () => {
  const v = view(70, 8);
  v.goTo(v.cardOf(3), "top");
  const row = v.lay.rowAt(v.top + 1);
  const key = [v.rows.item[row], v.rows.newNo[row]];
  v.setSize(120, 8);
  const now = v.lay.rowAt(v.top + 1);
  expect([v.rows.item[now], v.rows.newNo[now]]).toEqual(key);
});

const hl = new Highlighter();
afterAll(() => hl.close());

test("colours come from the worker for the lines on screen, the code plain until then", async () => {
  const v = view(80, 24, hl);
  let came = 0;
  hl.onColours = (fd, side, start, n) => {
    came++;
    v.invalidate(fd, side, start, n);
  };
  v.onWant = (w) => hl.want(w);
  const first = v.lines();
  expect(first.flatMap((l) => l.spans).some((x) => x.fg)).toBe(false);
  for (let i = 0; i < 100 && !hl.done(); i++) await Bun.sleep(50);
  expect(came).toBeGreaterThan(0);
  const after = v.lines();
  const coloured = after.flatMap((l) => l.spans).filter((x) => x.fg);
  expect(coloured.length).toBeGreaterThan(5);
  expect(new Set(coloured.map((x) => x.fg)).size).toBeGreaterThan(2);
  // the words that changed in a pair of lines keep their mark under the colours
  expect(after.flatMap((l) => l.spans).some((x) => x.c?.includes("addw") && x.fg)).toBe(true);
}, 20_000);
