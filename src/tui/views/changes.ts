/**
 * The Changes tab as the approved mockup draws it: the Files tab on the left in reading order with viewed boxes,
 * −/+ and threads; on the right the range in words, the strip of versions with the presets, and the diff with its
 * file sections, fold groups and thread cards.
 */
import { foldLabel, sectionTitle, type FileRow } from "../../ui/compare.ts";
import { nowDirty } from "../../ui/state.ts";
import { foldRuns, keptSteps } from "../../ui/versions.ts";
import { isViewedIn } from "../../ui/viewed.ts";
import { fileCounts, isCollapsed, presetsOf, rangeTitle, refsOf, threadOf, viewedIdx, type ChangesState } from "../changes.ts";
import type { Hooks } from "../diff/paint.ts";
import { pane, type Pane } from "../grid.ts";
import type { Data } from "../model.ts";
import { blank, key, line, plural, s, spread, wrap, type Cls, type Line, type Span } from "../text.ts";
import { sideTitle } from "./list.ts";
import { tags } from "./thread.ts";

function countSpans(add: number, del: number): Span[] {
  const out: Span[] = [];
  if (del) out.push(s(`−${del}`, "delc"));
  if (add) out.push(...(out.length ? [s(" ")] : []), s(`+${add}`, "addc"));
  return out;
}

function pathSpans(path: string, cls: Cls = "fh"): Span[] {
  const slash = path.lastIndexOf("/");
  return [s(path.slice(0, slash + 1), "dim"), s(path.slice(slash + 1), cls)];
}

/** What the diff of the Changes tab draws itself: file headers, fold groups, thread cards, notes. */
export function changesHooks(get: () => { d: Data; c: ChangesState }): Hooks {
  const cur = (at: boolean): Cls[] => (at ? [get().c.focus === "diff" ? "sel" : "seli"] : []);
  return {
    header(f, w, at) {
      const { c } = get();
      const row = c.rows.find((r) => r.fd.name === f.key);
      const n = fileCounts(row?.fd ?? f.fd);
      const seen = row ? isViewedIn(viewedIdx(c), row.fd) : false;
      const left: Span[] = [s(" "), s(f.collapsed ? "▸ " : "▾ ", "acc"), ...pathSpans(f.key)];
      if (f.fd.prevName && f.fd.prevName !== f.key) left.push(s(` ← ${f.fd.prevName}`, "dim"));
      if (row?.keptBecause) left.push(s(`  ⚠ ${row.keptBecause}`, "warn"));
      const right: Span[] = [...countSpans(n.add, n.del), s("  "), s(`[${seen ? "x" : " "}] viewed`, seen ? "ok" : "dim")];
      return { spans: spread(left, right, w), fill: [...cur(at), "hdr"] as Cls[], hit: `cfile:${f.key}` };
    },
    group(g, w, at) {
      const { c } = get();
      const which = g.key === "group:tests" ? "tests" : "generated";
      const list = c.rows.filter((r) => r.group === which);
      const add = list.reduce((a, r) => a + fileCounts(r.fd).add, 0);
      const del = list.reduce((a, r) => a + fileCounts(r.fd).del, 0);
      const left: Span[] = [s(" "), s(foldLabel(which, list.length, g.open), "acc")];
      return { spans: spread(left, countSpans(add, del), w), fill: [...cur(at), "hdr"] as Cls[], hit: `cgroup:${which}` };
    },
    card(_f, p, w, open, indent, at) {
      const { d } = get();
      const t = threadOf(d, p.threadId);
      const pad = s(" ".repeat(indent));
      const head: Span[] = [s(`▲ #${p.threadId}`, "acc"), ...(t ? [s("  "), ...tags(t)] : [])];
      const title = t?.title.split("\n")[0] ?? "";
      if (!open) {
        const l: Line = { spans: [pad, ...head, s("  "), s(title, "dim")], hit: `cthread:${p.threadId}` };
        return [at ? { ...l, fill: cur(true) } : l];
      }
      const inner = Math.max(10, w - indent - 4);
      const body: Line[] = wrap(t?.title ?? "", inner).slice(0, 4).map((x) => line(s(` ${x}`)));
      if (t?.last && t.commentCount > 1) {
        const who = t.last.role === "reviewer" ? "you" : t.last.name;
        body.push(line(s(` ${who}${t.last.intent ? ` · ${t.last.intent}` : ""}: `, t.last.role === "reviewer" ? "you" : "agentc"), s(t.last.preview.split("\n")[0] ?? "", "dim")));
      }
      const box = pane({ w: w - indent, title: head, right: [s(plural(t?.commentCount ?? 0, "message"), "dim")], bottom: [key("Enter"), s(" opens the thread · ", "dim"), key("z a"), s(" closes", "dim")], lines: body, focus: at, border: at ? "bf" : "bd" }, body.length + 2);
      return box.map((r) => ({ spans: [pad, ...r], hit: `cthread:${p.threadId}` }));
    },
    note(f, w, at) {
      return { spans: [s(`      ${f.note ?? ""}`.slice(0, w), "dim")], ...(at ? { fill: cur(true) } : {}) };
    },
  };
}

/** The strip of versions with the range lit, "now", and the presets with the key that steps through them. */
export function stripLine(d: Data, c: ChangesState): Line {
  const refs = refsOf(d);
  const dirty = nowDirty(refs);
  const steps = [
    { ref: "base", label: `base ${d.status?.review.baseRef ?? ""}`.trim(), kind: "base" },
    ...refs.versions.map((v) => ({ ref: String(v.number), label: `v${v.number}`, kind: "version" })),
    ...(dirty ? [{ ref: "now", label: "now", kind: "now" }] : []),
  ];
  const fi = steps.findIndex((x) => x.ref === c.from);
  const ti = steps.findIndex((x) => x.ref === c.to);
  const keep = keptSteps(steps, [fi, ti]);
  const spans: Span[] = [s(" ")];
  for (const item of foldRuns(steps.length, (i) => keep.has(i))) {
    if (spans.length > 1) spans.push(s(" ──▶ ", "dim"));
    if (item.kind === "fold") {
      spans.push(s(`${steps[item.from]!.label}…${steps[item.to]!.label}`, "dim"));
      continue;
    }
    const i = item.i;
    const inside = fi !== -1 && ti !== -1 && i >= Math.min(fi, ti) && i <= Math.max(fi, ti);
    spans.push(s(` ${steps[i]!.label} `, i === fi || i === ti ? "chips" : inside ? "chip" : "dim"));
  }
  if (!dirty && refs.versions.length) spans.push(s(`   now = v${refs.versions.length}`, "dim"));
  // the preset `p` goes to next, as the web's chips name it
  const ps = presetsOf(d, c);
  const at = ps.findIndex((p) => p.from === c.from && p.to === c.to);
  const next = ps.length > 1 || at === -1 ? ps[(at + 1) % ps.length] : undefined;
  if (next) spans.push(s("     "), s(next.label, "dim"), s(" "), key("p"));
  return { spans };
}

/** "5 threads on this diff · 1 elsewhere" and the keys that move through them and the range. */
export function infoLine(c: ChangesState, shown: number): Line {
  const outside = c.data?.outside.length ?? 0;
  return line(
    s(` ${plural(shown, "thread")} on this diff${outside ? ` · ${outside} elsewhere` : ""} ·`, "dim"),
    s(" "),
    key("] t"),
    key("[ t"),
    s(" step · ", "dim"),
    key("Enter"),
    s(" opens", "dim"),
  );
}

/** One line of the Files tab: a section's title, or a file with its viewed box, −/+ and threads. */
type Entry = { kind: "section"; title: string; n: number } | { kind: "file"; row: FileRow };

function entries(c: ChangesState): Entry[] {
  const out: Entry[] = [];
  const starts = c.rows.flatMap((r, i) => (r.section !== null ? [i] : []));
  if (!starts.length && c.rows.length) out.push({ kind: "section", title: sectionTitle(c.rows[0]!), n: c.rows.length });
  c.rows.forEach((r, i) => {
    if (r.section !== null) out.push({ kind: "section", title: r.section, n: (starts.find((x) => x > i) ?? c.rows.length) - i });
    out.push({ kind: "file", row: r });
  });
  return out;
}

/** The cells the Files tab wants, its border included. */
export function filesWidth(c: ChangesState): number {
  let most = 30;
  for (const r of c.rows) {
    const n = fileCounts(r.fd);
    most = Math.max(most, Bun.stringWidth(r.fd.name) + 6 + `−${n.del} +${n.add}`.length + 5);
  }
  return most + 2;
}

/** The Files tab: a window of its lines from `top`, the selected file filled. */
export function filesLines(d: Data, c: ChangesState, focus: boolean, w: number, top: number, height: number): { lines: Line[]; at: number; total: number } {
  if (!c.data || !c.base) return { lines: [blank(), line(s(c.error ? ` ${c.error}` : " loading the files…", "dim"))], at: -1, total: 2 };
  const idx = viewedIdx(c);
  const seen = c.rows.filter((r) => !r.hidden && isViewedIn(idx, r.fd)).length;
  const shown = c.rows.filter((r) => !r.hidden).length;
  const hidden = c.rows.length - shown;
  const head: Line[] = [line(s(` ${plural(c.rows.length, "file")} · ${seen} of ${shown} viewed${hidden ? ` · ${hidden} hidden` : ""}`, "dim")), blank()];
  const list = entries(c);
  const total = head.length + list.length;
  const at = head.length + list.findIndex((e) => e.kind === "file" && e.row.fd.name === c.sel);
  const out: Line[] = [];
  for (let y = top; y < Math.min(total, top + height); y++) {
    if (y < head.length) {
      out.push(head[y]!);
      continue;
    }
    const e = list[y - head.length]!;
    if (e.kind === "section") {
      out.push(line(s(` ${e.title.toUpperCase()} (${e.n})`, "b")));
      continue;
    }
    const r = e.row;
    const n = fileCounts(r.fd);
    const threads = d.threads.filter((t) => (t.anchor.path ?? t.path) === r.fd.name);
    const placed = (c.data.placements ?? []).filter((p) => p.path === r.fd.name).length;
    const unread = threads.some((t) => t.unread);
    const box = isViewedIn(idx, r.fd) ? "[x]" : "[ ]";
    const right: Span[] = [...countSpans(n.add, n.del), s(" "), unread ? s(`●${placed || threads.length}`, "new") : s(placed ? ` ${placed}` : "  ", "dim")];
    const left: Span[] = [s(` ${box} `, isViewedIn(idx, r.fd) ? "ok" : "dim"), ...pathSpans(r.fd.name, r.hidden ? "dim" : "b")];
    const fill = r.fd.name === c.sel ? { fill: [focus ? "sel" : "seli"] as Cls[] } : {};
    out.push({ spans: spread(left, right, w), hit: `cfile:${r.fd.name}`, ...fill });
  }
  return { lines: out, at: at < head.length ? -1 : at, total };
}

/** The diff's pane: the range in its border, the strip and the info lines over the widget's lines. */
export function diffPane(d: Data, c: ChangesState, w: number, height: number, shown: number): Pane {
  const inner = height - 2;
  const title: Span[] = [s(rangeTitle(d, c), "b"), ...(c.data ? [s(` · ${plural(c.data.files.length, "file")}`, "dim")] : [])];
  const right = [s(`${c.diff.split ? "split" : "unified"}${c.layout === "auto" ? "" : " (fixed)"} · ${c.wrap ? "wrap" : "no wrap"}`, "dim")];
  const head = [stripLine(d, c), infoLine(c, shown), blank()];
  let body: Line[];
  if (c.error && !c.base) body = [line(s(` ${c.error}`, "bad"))];
  else if (!c.data || !c.base) body = [line(s(` ${c.loading ?? "loading the changes…"}`, "dim"))];
  else if (!c.rows.length) body = [line(s(" No changes between these two.", "dim"))];
  else {
    c.diff.setSize(w - 2, Math.max(1, inner - head.length));
    c.diff.focus = c.focus === "diff";
    body = c.diff.lines();
  }
  return { w, title, right, lines: [...head, ...body], focus: c.focus === "diff", hit: "focus:cdiff" };
}

export function filesPane(d: Data, c: ChangesState, w: number, height: number, top: { value: number }): Pane {
  const focus = c.focus === "list";
  const inner = height - 2;
  if (c.side !== "files") {
    return { w, title: sideTitle(c.side), lines: [blank(), line(s(c.side === "search" ? " Search comes later; the browser has it." : " The threads are on the Round tab.", "dim"))], focus, hit: "focus:clist" };
  }
  const all = filesLines(d, c, focus, w - 2, 0, 0);
  if (all.at !== -1) {
    if (all.at - 1 < top.value) top.value = Math.max(0, all.at - 2);
    else if (all.at + 1 >= top.value + inner) top.value = all.at + 2 - inner;
  }
  top.value = Math.max(0, Math.min(top.value, Math.max(0, all.total - inner)));
  const f = filesLines(d, c, focus, w - 2, top.value, inner);
  return { w, title: sideTitle(c.side), lines: f.lines, focus, hit: "focus:clist" };
}

/** Whether the file under the list's cursor is folded, for its hint. */
export function selFolded(c: ChangesState): boolean {
  const r = c.rows.find((x) => x.fd.name === c.sel);
  return !!r && isCollapsed(c, r.fd);
}

