/**
 * The whole screen as rows, from the app's state: a pure function, so frames can be tested as text. Columns by width:
 * three from 150 cells (list, code, conversation), two from 100 (list, thread), else one with the list slid over it.
 */
import type { CommentDto, CompareDto, GitStateDto, ThreadDetail } from "../core/types.ts";
import type { CodeView, Scope as CodeScope, Wide } from "./code.ts";
import type { TokenSource } from "./diff/paint.ts";
import { DiffView, type Want } from "./diff/view.ts";
import { initialChanges, type ChangesState } from "./changes.ts";
import { changesHooks, diffPane, filesPane, filesWidth } from "./views/changes.ts";
import { bar, hcat, overlay, pane, type Pane, type Row } from "./grid.ts";
import { KEYS, keyLabel, type Scope } from "./keys/table.ts";
import { ordered, type Data, type ListFilter } from "./model.ts";
import { blank, key, line, plural, s, spansWidth, wrap, type Cls, type Line, type Span } from "./text.ts";
import { bannerLine, footerLine, headerLine, type Hint, type Tab, type Toast } from "./views/bars.ts";
import { fileCounts, fileOf, filesLines, listLines, listWidth, sideTitle, type Side } from "./views/list.ts";
import {
  CodePane,
  conversation,
  messagesNote,
  PREVIEW_HINT,
  rule,
  stripLines,
  THREAD_HINT,
  threadHead,
  threadTitle,
} from "./views/thread.ts";

export type Focus = "list" | "code" | "conv";

/** What the composer writes: a reply to a thread, a draft's new text, or the summary of the whole review. */
export type Writing = { kind: "reply"; thread: number } | { kind: "edit"; comment: number; thread: number } | { kind: "summary" };

export interface Choice {
  title: string;
  text: string;
  options: { value: string; label: string }[];
  at: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewState {
  data: Data;
  git: GitStateDto | null;
  /** A version the agent handed over that you have not looked at. */
  banner: number | null;
  tab: Tab;
  focus: Focus;
  /** The left column's tab. */
  side: Side;
  /** The review's changed files, once the Files tab asked for them. */
  files: CompareDto | null;
  fileSel: string | null;
  /** The file J or K just landed in: its header row is marked for a moment. */
  landed: string | null;
  /** The list scrolls to keep the selected thread in sight; the wheel scrolls it freely until the next move. */
  followList: boolean;
  filter: ListFilter;
  selected: number | null;
  /** The selected thread, once fetched. */
  detail: ThreadDetail | null;
  /** Messages that were unread when the thread was first shown: the NEW rule stays over them. */
  fresh: ReadonlySet<number>;
  view: CodeView | null;
  /** How much of the thread's file its code shows (`z`). */
  scope: CodeScope;
  /** The wider scope's code, once fetched. */
  wide: Wide | null;
  /** Syntax colours, and where the lines on screen are asked for. */
  hl: { tokens: TokenSource; want: (w: Want[]) => void };
  code: CodePane;
  draftCode: CodePane;
  changes: ChangesState;
  tops: { list: number; code: number; conv: number; thread: number; drafts: number; draft: number; help: number; clist: number };
  /** The tab a thread was opened from, for Esc to go back to it. */
  back: "changes" | null;
  /** Scroll the conversation to its NEW rule on the next frame. */
  toNews: boolean;
  draftSel: number | null;
  draftDetail: ThreadDetail | null;
  summary: string;
  guide: boolean;
  writing: Writing | null;
  composerText: string;
  /** A count typed before a move: `5` of `5j`. */
  count: string;
  /** Keys typed of a binding not complete yet: `<Space>` opens the menu. */
  prefix: string[];
  next: { key: string; desc: string; off?: "browser" | "later" }[];
  choice: Choice | null;
  help: Line[] | null;
  toast: Toast | null;
  connecting: string | null;
  now: number;
  /** Set by the last frame: where { and } go, and how many rows a page has. */
  geom: { starts: number[]; page: number; columns: 1 | 2 | 3; diff?: { x: number; y: number } };
}

export function initialView(): ViewState {
  const hl: ViewState["hl"] = { tokens: { line: () => undefined, style: () => undefined }, want: () => {} };
  const tokens: TokenSource = { line: (fd, side, i) => hl.tokens.line(fd, side, i), style: (id) => hl.tokens.style(id) };
  const want = (w: Want[]) => hl.want(w);
  const v: ViewState = {
    hl,
    code: new CodePane(tokens, want),
    draftCode: new CodePane(tokens, want),
    scope: "around",
    wide: null,
    data: { status: null, threads: [], drafts: [], now: null, online: true },
    git: null,
    banner: null,
    tab: "round",
    focus: "list",
    side: "threads",
    files: null,
    fileSel: null,
    landed: null,
    followList: true,
    filter: { status: "open", newOnly: false },
    selected: null,
    detail: null,
    fresh: new Set(),
    view: null,
    tops: { list: 0, code: 0, conv: 0, thread: 0, drafts: 0, draft: 0, help: 0, clist: 0 },
    toNews: false,
    back: null,
    draftSel: null,
    draftDetail: null,
    summary: "",
    guide: false,
    writing: null,
    composerText: "",
    prefix: [],
    next: [],
    count: "",
    choice: null,
    help: null,
    toast: null,
    connecting: null,
    now: Date.now(),
    geom: { starts: [], page: 10, columns: 2 },
    changes: null as unknown as ChangesState,
  };
  const diff = new DiffView(changesHooks(() => ({ d: v.data, c: v.changes })), tokens);
  diff.onWant = want;
  v.changes = initialChanges(diff);
  return v;
}

export const columnsFor = (w: number): 1 | 2 | 3 => (w >= 150 ? 3 : w >= 100 ? 2 : 1);

/** The scope keys go to: the focused column, the composer, a box over the screen. */
export type Place = "list" | "files" | "search" | "code" | "conv" | "thread" | "drafts" | "changes" | "cfiles" | "composer" | "choice" | "help" | "menu";

const listScope = (v: ViewState): "list" | "files" | "search" => (v.side === "threads" ? "list" : v.side);

export function scopeOf(v: ViewState): Place {
  if (v.help) return "help";
  if (v.choice) return "choice";
  if (v.writing) return "composer";
  if (v.prefix[0] === "<Space>") return "menu";
  return columnOf(v);
}

/** The column in focus, under any box over it. */
export function columnOf(v: ViewState): "list" | "files" | "search" | "code" | "conv" | "thread" | "drafts" | "changes" | "cfiles" {
  if (v.tab === "drafts") return "drafts";
  if (v.tab === "changes") return v.changes.focus === "list" ? "cfiles" : "changes";
  const cols = v.geom.columns;
  if (v.focus === "list") return listScope(v);
  return cols === 3 ? v.focus : "thread";
}

const CHIPS: Record<Place, string> = {
  list: "THREADS",
  files: "FILES",
  search: "SEARCH",
  code: "CODE",
  conv: "CONVERSATION",
  thread: "THREAD",
  drafts: "DRAFTS",
  changes: "CHANGES",
  cfiles: "FILES",
  composer: "REPLY",
  choice: "QUESTION",
  help: "KEYS",
  menu: "MENU",
};

const HINTS: Record<Place, Hint[]> = {
  list: [["j k", "thread"], ["J K", "file"], ["Enter", "l", "into the thread"], ["n", "unread"], ["Space e", "files"], ["Tab", "column"], ["Space", "menu"], ["?", "keys"], ["q", "quit"]],
  files: [["j k", "file"], ["Enter", "l", "into its first thread"], ["Space s t", "threads"], ["Tab", "column"], ["Space", "menu"], ["?", "keys"], ["q", "quit"]],
  search: [["Space s t", "threads"], ["Space e", "files"], ["?", "keys"], ["q", "quit"]],
  code: [["j k", "scroll"], ["] t", "[ t", "thread"], ["J K", "file"], ["n", "unread"], ["Tab", "next column"], ["h", "list"], ["r", "reply"], ["x", "resolve"], ["t", "diff / then / at"], ["Space", "menu"], ["?", "all keys"]],
  conv: [["j k", "scroll"], ["{ }", "message"], ["] t", "[ t", "thread"], ["J K", "file"], ["r", "reply"], ["x", "resolve"], ["h", "code"], ["Tab", "next column"], ["Space", "menu"], ["?", "all keys"]],
  thread: [["j k", "scroll"], ["] t", "[ t", "thread"], ["J K", "file"], ["n", "unread"], ["h", "list"], ["r", "reply"], ["x", "resolve"], ["t", "diff / then / at"], ["{ }", "message"], ["Space", "menu"], ["?", "keys"]],
  drafts: [["j k", "move"], ["Enter", "its thread"], ["e", "edit"], ["d d", "discard"], ["c", "summary"], ["S", "request changes"], ["A", "approve"], ["g", "guide"], ["Esc", "back"]],
  changes: [["j k", "line"], ["] t", "[ t", "thread"], ["] b", "[ b", "file"], ["Enter", "open"], ["m", "viewed"], ["z a", "fold"], ["] v", "[ v", "range"], ["h", "files"], ["Space", "menu"], ["?", "keys"]],
  cfiles: [["j k", "file"], ["Enter", "l", "into the diff"], ["m", "viewed"], ["z a", "fold"], ["Tab", "column"], ["Space", "menu"], ["?", "keys"], ["q", "round"]],
  composer: [["type the message"], ["Ctrl+S", "save as draft"], ["Ctrl+G", "send now"], ["Esc", "or"], ["j j", "leave, the text stays"], ["Ctrl+C", "quit"]],
  choice: [["j k", "choose"], ["Enter", "confirm"], ["Esc", "cancel"]],
  help: [["j k", "scroll"], ["Esc", "close"]],
  menu: [["press a key from the box"], ["Esc", "close"], ["Backspace", "up a level"]],
};

function composerHints(v: ViewState): Hint[] {
  if (v.writing?.kind === "edit") return [["type the message"], ["Ctrl+S", "save"], ["Esc", "or"], ["j j", "leave, the text stays"], ["Ctrl+C", "quit"]];
  if (v.writing?.kind === "summary") return [["type the summary"], ["Ctrl+S", "keep it"], ["Esc", "or"], ["j j", "leave, the text stays"], ["Ctrl+C", "quit"]];
  return HINTS.composer;
}

function footer(v: ViewState, w: number): Line {
  const scope = scopeOf(v);
  if (v.count) return footerLine(w, { chip: CHIPS[scope], hints: [[`${v.count} …`], ["j k", "] c", "] b", "move that many"], ["Esc", "forget it"]], toast: null });
  if (v.prefix.length && scope !== "menu") {
    const hints: Hint[] = [[`${keyLabel(v.prefix.join(""))} …`], ...v.next.map((n) => [keyLabel(n.key), n.desc] as Hint)];
    return footerLine(w, { chip: CHIPS[scope], hints, toast: null });
  }
  const chip = scope === "composer" ? (v.writing?.kind === "edit" ? "DRAFT" : v.writing?.kind === "summary" ? "SUMMARY" : "REPLY") : CHIPS[scope];
  const hints = scope === "composer" ? composerHints(v) : scope === "thread" && v.geom.columns === 1 ? NARROW_HINTS : HINTS[scope];
  return footerLine(w, { chip, hints, toast: v.toast });
}

const NARROW_HINTS: Hint[] = [["h", "list"], ["j k", "scroll"], ["] t", "[ t", "thread"], ["r", "reply"], ["x", "resolve"], ["?", "keys"]];

/** `lines` from `top`, `height` of them; the top is clamped so the window never runs past the end. */
function window(lines: Line[], top: number, height: number): { top: number; lines: Line[] } {
  const t = Math.max(0, Math.min(Math.max(0, lines.length - height), top));
  return { top: t, lines: lines.slice(t, t + height) };
}

/** The list's top so the selected thread's rows stay in sight, a row of margin around them. */
function follow(ids: (number | null)[], selected: number | null, top: number, height: number): number {
  const first = ids.indexOf(selected);
  return first === -1 ? top : followAt(first, first + 1, top, height);
}

function followAt(first: number, last: number, top: number, height: number): number {
  if (first - 1 < top) return Math.max(0, first - 2);
  if (last + 1 >= top + height) return last + 2 - height;
  return top;
}

// --- the composer box

function composerTitle(v: ViewState): Span[] {
  const w = v.writing!;
  if (w.kind === "reply") return [s(`Reply to #${w.thread} ·`, "cf"), s(" "), s("draft", "cft")];
  if (w.kind === "edit") return [s(`Edit the draft on #${w.thread}`, "cf")];
  return [s("Summary for the whole review", "cf")];
}

function composerBottom(v: ViewState): Span[] {
  const kept = [key("Esc"), s(" "), s("leave, text kept", "cf")];
  if (v.writing?.kind === "reply") return [key("Ctrl+S"), s(" "), s("save draft ·", "cf"), s(" "), key("Ctrl+G"), s(" "), s("send now ·", "cf"), s(" "), ...kept];
  return [key("Ctrl+S"), s(" "), s(v.writing?.kind === "summary" ? "keep ·" : "save ·", "cf"), s(" "), ...kept];
}

/** The box as lines of the pane it sits in, and where its text goes inside it. */
function composerBox(v: ViewState, inner: number): { lines: Line[]; text: { dx: number; dy: number; w: number; h: number } } {
  const boxW = Math.max(10, inner - 1);
  const textW = boxW - 4;
  const text = wrap(v.composerText, textW);
  const rows = Math.max(3, Math.min(8, text.length + 1));
  const box = pane({ w: boxW, title: composerTitle(v), bottom: composerBottom(v), lines: text.slice(0, rows).map((t) => line(s(` ${t}`))), border: "cf", focus: true }, rows + 2);
  return { lines: box.map((r) => ({ spans: [s(" "), ...r] })), text: { dx: 3, dy: 1, w: textW, h: rows } };
}

interface Placed {
  lines: Line[];
  box: { dx: number; dy: number; w: number; h: number } | null;
  top: number;
}

/**
 * A column's content in `height` rows from `top`, with a box (the composer) after it when there is room, else pinned
 * to the bottom while the content scrolls above it; `pinned` lines sit at the bottom when there is no box.
 */
function place(content: Line[], top: number, height: number, inner: number, v: ViewState, withBox: boolean, pinned: Line[] = []): Placed {
  if (withBox) {
    const b = composerBox(v, inner);
    const room = height - b.lines.length;
    const gap = content.length && content[content.length - 1]!.spans.length ? 1 : 0;
    if (content.length + gap <= room) {
      const lines = [...content, ...(gap ? [blank()] : []), ...b.lines];
      return { lines, box: { ...b.text, dy: b.text.dy + content.length + gap }, top: 0 };
    }
    const w = window(content, top, Math.max(1, room));
    return { lines: [...w.lines, ...Array(Math.max(0, room - w.lines.length)).fill(blank()), ...b.lines], box: { ...b.text, dy: b.text.dy + Math.max(1, room) }, top: w.top };
  }
  if (pinned.length) {
    const room = Math.max(1, height - pinned.length);
    const w = window(content, top, room);
    return { lines: [...w.lines, ...Array(Math.max(0, room - w.lines.length)).fill(blank()), ...pinned], box: null, top: w.top };
  }
  const w = window(content, top, height);
  return { lines: w.lines, box: null, top: w.top };
}

// --- the Round tab

function position(v: ViewState): Span[] {
  if (v.selected === null) return [];
  const list = ordered(v.data, v.filter, v.selected);
  const at = list.findIndex((t) => t.id === v.selected);
  return at === -1 ? [] : [s(`${at + 1} of ${list.length}`, "dim")];
}

function listPane(v: ViewState, w: number, height: number, focus: boolean): Pane {
  const base = { w, title: sideTitle(v.side), focus, hit: "focus:list" };
  if (v.side === "search") {
    return { ...base, lines: [blank(), line(s(" Search comes with the Changes run.", "dim")), blank(), line(s(" "), key("Space s t"), s(" threads · ", "dim"), key("Space e"), s(" files", "dim"))] };
  }
  let lines: Line[];
  let at: number;
  if (v.side === "files") {
    const f = filesLines(v.data, v.files, v.fileSel, focus, w - 2);
    lines = f.lines;
    at = f.paths.indexOf(v.fileSel);
    if (v.followList && at !== -1) v.tops.list = followAt(at, at, v.tops.list, height - 2);
  } else {
    const l = listLines(v.data, v.filter, v.selected, focus, w - 2, v.landed);
    lines = l.lines;
    if (v.followList) v.tops.list = follow(l.ids, v.selected, v.tops.list, height - 2);
  }
  const win = window(lines, v.tops.list, height - 2);
  v.tops.list = win.top;
  return { ...base, lines: win.lines };
}

function emptyPane(w: number, text: string, focus = false, title: Span[] = []): Pane {
  return { w, title, lines: [blank(), line(s(` ${text}`, "dim"))], focus };
}

interface ThreadPanes {
  panes: Pane[];
  box: { pane: number; dx: number; dy: number; w: number; h: number } | null;
}

function threadPanes(v: ViewState, cols: 1 | 2 | 3, widths: number[], height: number): ThreadPanes {
  const d = v.detail;
  const inner = height - 2;
  const focusThread = v.focus !== "list";
  const right = focusThread ? position(v) : [s("preview", "dim")];
  if (v.selected === null || !d || d.thread.id !== v.selected) {
    const text = v.selected === null ? (v.data.threads.length ? "No thread selected." : "No threads yet. Comment on code in the browser or with `stet comment add`.") : `loading thread #${v.selected}…`;
    return { panes: widths.map((w, i) => emptyPane(w, i === 0 ? text : "", false, i === 0 ? [s(v.selected === null ? "Thread" : `#${v.selected}`, "b")] : [s("Conversation")])), box: null };
  }
  if (v.side === "files" && v.focus === "list" && v.fileSel && !v.data.threads.some((x) => fileOf(x) === v.fileSel)) {
    const f = v.files?.files.find((x) => x.path === v.fileSel);
    const counts = f ? fileCounts(f) : [];
    const what = f ? (f.status === "A" ? "a new file" : f.status === "D" ? "deleted" : f.status === "R" ? `renamed from ${f.oldPath}` : "changed") : "";
    const lines = [blank(), line(s(" No threads in this file.")), blank(), line(s(` ${what}`, "dim"), ...(counts.length ? [s(" · ", "dim"), ...counts] : [])), blank(), line(s(" Its diff comes with the Changes run; ", "dim"), s("stet open --browser", "b"), s(" shows it now.", "dim"))];
    return { panes: widths.map((w, i) => (i === 0 ? { w, title: [s(v.fileSel!, "b")], right: [s("preview", "dim")], lines, hit: "focus:code" } : emptyPane(w, "", false, [s("Conversation")]))), box: null };
  }
  const writing = v.writing?.kind === "reply" && v.writing.thread === d.thread.id;
  if (cols === 3) {
    const [codeW, convW] = widths as [number, number];
    const part = v.code.lines(d, v.view, v.scope, v.wide, codeW - 2);
    const codeLinesAll = [...threadHead(d, part.view, part.scope, codeW - 2), ...part.lines];
    const code = place(codeLinesAll, v.tops.code, inner, codeW - 2, v, false);
    v.tops.code = code.top;
    const conv = conversation(d, v.fresh, convW - 2, v.now);
    const convAll = [blank(), ...conv.lines];
    if (v.toNews && conv.newAt !== null) v.tops.conv = conv.newAt;
    const c = place(convAll, v.tops.conv, inner, convW - 2, v, writing, v.focus === "conv" || v.focus === "code" ? [THREAD_HINT, blank()] : [PREVIEW_HINT, blank()]);
    v.tops.conv = c.top;
    if (v.focus === "conv") v.geom.starts = conv.starts.map((x) => x + 1);
    else v.geom.starts = [];
    return {
      panes: [
        { w: codeW, title: threadTitle(d), right, lines: code.lines, focus: v.focus === "code", hit: "focus:code" },
        { w: convW, title: [s("Conversation")], right: messagesNote(d, conv.fresh), lines: c.lines, focus: v.focus === "conv", hit: "focus:conv" },
      ],
      box: c.box ? { pane: 1, ...c.box } : null,
    };
  }
  const w = widths[0]!;
  const narrow = cols === 1;
  const part = v.code.lines(d, v.view, v.scope, v.wide, w - 2, narrow && v.scope === "around" ? 1 : null);
  const head = narrow ? stripLines(d, w - 2) : threadHead(d, part.view, part.scope, w - 2);
  const codeRows = narrow ? part.lines.slice(1) : part.lines;
  const conv = conversation(d, v.fresh, w - 2, v.now);
  const ruleText = `${narrow ? "" : "Conversation · "}${plural(d.comments.length, "message")}${conv.fresh ? ` · ${conv.fresh} new` : ""}`;
  const before = [...head, ...codeRows, blank(), rule(ruleText, w - 2)];
  const all = [...before, ...conv.lines];
  if (v.toNews && conv.newAt !== null) v.tops.thread = before.length + conv.newAt;
  const hint = focusThread ? [blank(), narrow ? blank() : THREAD_HINT] : [blank(), PREVIEW_HINT];
  const t = place(writing ? all : [...all, ...hint], v.tops.thread, inner, w - 2, v, writing);
  v.tops.thread = t.top;
  v.geom.starts = conv.starts.map((x) => x + before.length);
  return { panes: [{ w, title: threadTitle(d, !narrow), right, lines: t.lines, focus: focusThread, hit: "focus:code" }], box: t.box ? { pane: 0, ...t.box } : null };
}

function roundTab(v: ViewState, w: number, height: number, top: number): { rows: Row[]; box: Rect | null } {
  const cols = columnsFor(w);
  v.geom.columns = cols;
  const listW = Math.min(w - 40, Math.max(40, Math.min(Math.floor(w * 0.3), listWidth(v.data, v.filter))));
  if (cols === 1) {
    const t = threadPanes(v, 1, [w], height);
    let rows = pane(t.panes[0]!, height);
    const box = t.box ? { x: 1 + t.box.dx, y: top + 1 + t.box.dy, w: t.box.w, h: t.box.h } : null;
    // On a narrow screen the list in focus slides in over the thread.
    if (v.focus === "list") rows = overlay(rows, pane(listPane(v, Math.min(w - 4, Math.max(40, Math.floor(w * 0.58))), height, true), height), 0, 0);
    return { rows, box: v.focus === "list" ? null : box };
  }
  const list = listPane(v, listW, height, v.focus === "list");
  const rest = w - listW;
  const widths = cols === 3 ? [Math.round(rest * 0.57), rest - Math.round(rest * 0.57)] : [rest];
  const t = threadPanes(v, cols, widths, height);
  const all = [list, ...t.panes];
  const xs = all.map((_, i) => all.slice(0, i).reduce((n, p) => n + p.w, 0));
  const box = t.box ? { x: xs[t.box.pane + 1]! + 1 + t.box.dx, y: top + 1 + t.box.dy, w: t.box.w, h: t.box.h } : null;
  return { rows: hcat(all.map((p) => pane(p, height))), box };
}

// --- the Changes tab

const listWidthOf = (c: ChangesState, w: number) => Math.min(w - 60, Math.max(40, Math.min(Math.floor(w * 0.3), filesWidth(c))));

function changesTab(v: ViewState, w: number, height: number, top0: number): { rows: Row[]; box: Rect | null } {
  const c = v.changes;
  const shown = (c.data?.placements ?? []).filter((p) => v.filter.status === "all" || v.data.threads.find((t) => t.id === p.threadId)?.status !== "resolved").length;
  const top = { value: v.tops.clist };
  // the diff's lines start under the pane's border and its three lines of range, strip and threads
  v.geom.diff = { x: (w < 100 ? 0 : listWidthOf(c, w)) + 1, y: top0 + 4 };
  if (w < 100) {
    let rows = pane(diffPane(v.data, c, w, height, shown), height);
    if (c.focus === "list") rows = overlay(rows, pane(filesPane(v.data, c, Math.min(w - 4, Math.max(40, Math.floor(w * 0.58))), height, top), height), 0, 0);
    v.tops.clist = top.value;
    return { rows, box: null };
  }
  const listW = listWidthOf(c, w);
  const list = filesPane(v.data, c, listW, height, top);
  v.tops.clist = top.value;
  return { rows: hcat([pane(list, height), pane(diffPane(v.data, c, w - listW, height, shown), height)]), box: null };
}

// --- the Drafts tab

function draftHead(c: CommentDto, d: Data): Span[] {
  const t = d.threads.find((x) => x.id === c.threadId);
  const at = t ? (t.region ? `${t.path} · area` : `${t.anchor.path ?? t.path}:${(t.anchor.range ?? t.range).start}`) : "";
  return [s(" "), s(`#${c.threadId}`, "b"), s(" "), s(at, "dim"), s(" "), s(c.parentId === null ? " new thread " : " reply ", "tdr"), ...(c.resolves ? [s(" ✓ resolves", "ok")] : [])];
}

function draftsLeft(v: ViewState, w: number): { lines: Line[]; ids: (number | null)[] } {
  const d = v.data;
  const latest = d.status?.versions ?? 0;
  const lines: Line[] = [line(s(" The agent sees drafts only when you send them.", "dim")), blank()];
  const ids: (number | null)[] = [null, null];
  if (!d.drafts.length) {
    lines.push(line(s(" No drafts.", "dim")), blank());
    ids.push(null, null);
  }
  for (const c of d.drafts) {
    const fill = c.id === v.draftSel ? { fill: ["sel" as const] } : {};
    const hit = `draft:${c.id}`;
    lines.push({ spans: draftHead(c, d), hit, ...fill }, { spans: [s("   "), s(c.body.split("\n")[0] || (c.restore ? "asks to restore lines" : ""), "dim")], hit, ...fill });
    ids.push(c.id, c.id);
  }
  lines.push(blank(), line(s(" Summary", "dim"), s(" "), key("c")));
  ids.push(null, null);
  for (const part of v.summary.trim() ? wrap(v.summary, w - 4) : ["(none)"]) {
    lines.push(line(s("   "), s(part, ...(v.summary.trim() ? [] : (["dim"] as const)))));
    ids.push(null);
  }
  const n = d.drafts.length;
  lines.push(
    blank(),
    n ? line(s(" "), key("S"), s(" "), s("Request changes", "b"), s(` · send ${plural(n, "comment")}`, "dim")) : line(s(" "), key("S"), s(" "), s("Request changes · no drafts", "dim")),
    line(s(" "), key("A"), s(" "), s(`✓ Approve${latest ? ` v${latest}` : ""}`, "ok")),
    line(s(` [${v.guide ? "x" : " "}] `), s(`ask the agent for a guide to v${latest + 1}`, n ? "dim" : "bd"), s(" "), key("g")),
  );
  ids.push(null, null, null, null);
  return { lines, ids };
}

function draftRight(v: ViewState, w: number): { title: Span[]; lines: Line[] } {
  const c = v.data.drafts.find((x) => x.id === v.draftSel);
  if (!c) return { title: [s("Draft", "b")], lines: [] };
  const d = v.draftDetail;
  if (!d || d.thread.id !== c.threadId) return { title: [s(`#${c.threadId}`, "b")], lines: [blank(), line(s(` loading thread #${c.threadId}…`, "dim"))] };
  const rows = v.draftCode.lines(d, null, "around", null, w, 1, false).lines.slice(1);
  const msg = conversation({ ...d, comments: [c], events: [] }, new Set(), w, v.now).lines;
  return { title: threadTitle(d, false), lines: [blank(), ...rows, blank(), ...msg] };
}

function draftsTab(v: ViewState, w: number, height: number, top: number): { rows: Row[]; box: Rect | null } {
  const inner = height - 2;
  const narrow = w < 100;
  const leftW = narrow ? w : Math.max(40, Math.min(60, Math.floor(w * 0.38)));
  const left = draftsLeft(v, leftW - 2);
  v.tops.drafts = follow(left.ids, v.draftSel, v.tops.drafts, inner);
  const summaryBox = v.writing?.kind === "summary" || (narrow && v.writing?.kind === "edit");
  const l = place(left.lines, v.tops.drafts, inner, leftW - 2, v, summaryBox);
  v.tops.drafts = l.top;
  const n = v.data.drafts.length;
  const panes: Pane[] = [{ w: leftW, title: [s("Your review", "b"), s(` · ${plural(n, "draft")}`, "dim")], lines: l.lines, focus: true, hit: "focus:drafts" }];
  let box: Rect | null = l.box ? { x: 1 + l.box.dx, y: top + 1 + l.box.dy, w: l.box.w, h: l.box.h } : null;
  if (!narrow) {
    const rw = w - leftW;
    const r = draftRight(v, rw - 2);
    const editing = v.writing?.kind === "edit";
    const p = place(r.lines, v.tops.draft, inner, rw - 2, v, editing);
    v.tops.draft = p.top;
    const right = n ? [key("e"), s(" edit · ", "dim"), key("d d"), s(" discard", "dim")] : [];
    panes.push({ w: rw, title: r.title, right, lines: p.lines, hit: "focus:draft" });
    if (p.box) box = { x: leftW + 1 + p.box.dx, y: top + 1 + p.box.dy, w: p.box.w, h: p.box.h };
  }
  return { rows: hcat(panes.map((p) => pane(p, height))), box };
}

// --- boxes over the screen

// the order of the approved mockup, read row by row: the groups first, then the keys of their own
const MENU_ORDER = ["f", "r", "s", "g", "u", "e", "<Space>", "/", "n", "?"];
const menuRank = (k: string) => (MENU_ORDER.includes(k) ? MENU_ORDER.indexOf(k) : MENU_ORDER.length);

function menuBox(v: ViewState, w: number): Row[] {
  const entries = v.prefix.length === 1 ? [...v.next].sort((a, b) => menuRank(a.key) - menuRank(b.key)) : v.next;
  const colW = 23;
  const half = Math.ceil(entries.length / 2);
  const cell = (e: ViewState["next"][number] | undefined): Span[] => {
    if (!e) return [];
    const k = keyLabel(e.key);
    const group = e.desc.startsWith("+");
    const mark = e.off === "browser" ? " ↗" : "";
    const room = Math.max(1, colW - k.length - 2 - mark.length);
    const desc = (e.desc.length > room ? `${e.desc.slice(0, room - 1)}…` : e.desc) + mark;
    const hit = `key:${[...v.prefix, e.key].join("")}`;
    const look: Cls[] = group ? ["wg"] : e.off === "later" ? ["bd"] : [];
    return [s(" "), { ...s(k, ...(e.off === "later" ? (["bdt"] as Cls[]) : (["wk"] as Cls[]))), hit }, { ...s(" "), hit }, { ...s(desc, ...look), hit }];
  };
  const lines: Line[] = [];
  for (let i = 0; i < half; i++) {
    const a = cell(entries[2 * i]);
    lines.push(line(...a, s(" ".repeat(Math.max(1, colW + 1 - spansWidth(a)))), ...cell(entries[2 * i + 1])));
  }
  lines.push(blank());
  if (entries.some((e) => e.off)) lines.push(line(s(" ↗ opens in the browser · grey: comes later", "dim")));
  lines.push(line(s(" a key runs it or opens its group · Esc closes", "dim")));
  const title = v.prefix.map((t) => keyLabel(t)).join(" ");
  return pane({ w: Math.min(w - 2, 50), title: [s(title, "b")], lines, focus: true }, lines.length + 2);
}

function choiceBox(c: Choice, w: number): Row[] {
  const bw = Math.min(w - 4, 66);
  const lines: Line[] = wrap(c.text, bw - 4).map((t) => line(s(` ${t}`)));
  lines.push(blank());
  c.options.forEach((o, i) => {
    const parts = wrap(o.label, bw - 9);
    const fill = i === c.at ? { fill: ["sel" as const] } : {};
    parts.forEach((p, k) => lines.push({ spans: k ? [s(`      ${p}`)] : [s(" "), s(String(i + 1), "b"), s(`  ${p}`)], hit: `key:${i + 1}`, ...fill }));
  });
  lines.push(blank(), line(s(" "), key("j k"), s(" "), ...c.options.slice(0, 9).flatMap((_, i) => [key(String(i + 1)), s(" ")]), s("choose · "), key("Enter"), s(" confirm · "), key("Esc"), s(" cancel")));
  return pane({ w: bw, title: [s(c.title, "b")], lines, focus: true }, lines.length + 2);
}

function helpBox(v: ViewState, w: number, height: number): Row[] {
  const lines = v.help ?? [];
  const bw = Math.min(w - 4, Math.max(40, ...lines.map((l) => spansWidth(l.spans) + 3)));
  const rows = Math.min(height, lines.length + 2);
  v.tops.help = Math.max(0, Math.min(v.tops.help, lines.length - (rows - 2)));
  const more = lines.length - v.tops.help - (rows - 2);
  return pane({ w: bw, title: [s("Keys", "b")], right: more > 0 ? [s(`${more} more ↓`, "dim")] : [], lines: lines.slice(v.tops.help), focus: true, hit: "focus:help" }, rows);
}

// --- the screen

export interface Frame {
  rows: Row[];
  /** Where the composer's text field goes, when one is open. */
  box: Rect | null;
}

export function render(v: ViewState, w: number, h: number): Frame {
  const head: Row[] = [bar(headerLine(v.data, v.git, v.tab, w, v.connecting), w)];
  if (v.banner !== null && w >= 100 && v.data.status) head.push(bar(bannerLine(v.banner, w), w));
  const height = Math.max(3, h - head.length - 1);
  v.geom.page = Math.max(1, height - 2);
  let body: { rows: Row[]; box: Rect | null };
  if (!v.data.status) body = { rows: pane(emptyPane(w, v.connecting ?? "loading…"), height), box: null };
  else if (v.tab === "drafts") body = draftsTab(v, w, height, head.length);
  else if (v.tab === "changes") body = changesTab(v, w, height, head.length);
  else body = roundTab(v, w, height, head.length);
  v.toNews = false;
  let rows = [...head, ...body.rows, bar(footer(v, w), w)];
  if (v.prefix[0] === "<Space>" && !v.writing) {
    const m = menuBox(v, w);
    rows = overlay(rows, m, Math.max(head.length, head.length + height - m.length - 1), Math.max(0, w - (m[0] ? spansWidth(m[0]) : 0) - 1));
  }
  if (v.choice) {
    const c = choiceBox(v.choice, w);
    rows = overlay(rows, c, head.length + Math.max(0, Math.floor((height - c.length) * 0.45)), Math.max(0, Math.floor((w - spansWidth(c[0]!)) / 2)));
  }
  if (v.help) {
    const b = helpBox(v, w, height);
    rows = overlay(rows, b, head.length + Math.max(0, Math.floor((height - b.length) / 3)), Math.max(0, Math.floor((w - spansWidth(b[0]!)) / 2)));
  }
  return { rows: rows.slice(0, h), box: v.choice || v.help ? null : body.box };
}

const MOVING: { keys: string; desc: string }[] = [
  { keys: "h  l  Tab", desc: "columns: h left, l right, Tab cycles them; or click a column" },
  { keys: "Space e  Space s t", desc: "the left column's tabs: Files, Threads; or click a tab in its border" },
  { keys: "s  Space r v", desc: "the Drafts and Changes tabs at the top; Esc back to the round; or click them" },
  { keys: "j  k", desc: "in the list: the next / previous thread; in the code and the conversation: scroll" },
  { keys: "J  K", desc: "the first thread of the next / previous file, wherever you are" },
  { keys: "]t  [t", desc: "the next / previous thread from the code or the conversation" },
  { keys: "n  N", desc: "the next / previous unread thread" },
  { keys: "mouse", desc: "click a row, a tab, a column or a key chip; the wheel scrolls the column under the pointer" },
  { keys: "Shift+drag", desc: "selects text in most terminals while the mouse is on (Option+drag in iTerm2)" },
];

const PLACE_NAMES: Record<string, string> = {
  list: "The thread list",
  files: "The files",
  search: "Search",
  code: "The code",
  conv: "The conversation",
  thread: "The thread",
  drafts: "Drafts",
  changes: "Changes",
  cfiles: "The files of the changes",
};

/** `?`: the keys of the place in focus, how to move around, and the keys that work everywhere. */
export function helpFor(scope: Scope): Line[] {
  const group = (sc: Scope) => {
    const byId = new Map<string, { keys: string[]; desc: string }>();
    for (const r of KEYS.filter((x) => x.scope === sc)) {
      const had = byId.get(r.id);
      if (had) had.keys.push(...r.keys);
      else byId.set(r.id, { keys: [...r.keys], desc: r.off === "browser" ? `${r.desc} · opens in the browser` : r.off === "later" ? `${r.desc} · not in the terminal yet` : r.desc });
    }
    return [...byId.values()];
  };
  const out: Line[] = [];
  const section = (title: string, rows: { keys: string; desc: string }[]) => {
    if (out.length) out.push(blank());
    out.push(line(s(` ${title}`, "b")));
    for (const r of rows) out.push(line(s(`  ${r.keys.padEnd(20)}`, "wk"), s(` ${r.desc}`)));
  };
  const keys = (sc: Scope) => group(sc).map((r) => ({ keys: r.keys.map(keyLabel).join("  "), desc: r.desc }));
  section(PLACE_NAMES[scope] ?? scope, keys(scope));
  section("Moving around", MOVING);
  section("Everywhere", keys("global"));
  out.push(blank(), line(s("  Ctrl+C quits from anywhere", "dim")));
  return out;
}
