import { effect, signal } from "@preact/signals";
import {
  codeFocus,
  codeLines,
  compareData,
  compareNav,
  copyLinesUrl,
  cursor,
  cursorSpace,
  fileOpen,
  fileRows,
  grepHits,
  groupsOpen,
  guideKeys,
  isCollapsed,
  leaveCode,
  linesNav,
  openSearch,
  peek,
  pendingLines,
  searchHits,
  searchScope,
  setCursor,
  sideTab,
  spotThread,
  stepHit,
  threadCode,
  visualAnchor,
} from "./compare.ts";
import { moveStart, type Cursor, type Span } from "./lib/cursor.ts";
import { stepFile, stepThread, stepUnread } from "./lib/nav.ts";
import { commitPicker } from "./commits.ts";
import { gitOpen } from "./components/GitState.tsx";
import { edgeMsg, foldAllMsgs, foldMsg, halfPage, replyAtCursor, stepMsg } from "./msgs.ts";
import { clampStep, diffPair } from "./lib/timeline.ts";
import { openBlame } from "./components/Blame.tsx";
import { zoomKey } from "./components/ImageZoom.tsx";
import { foldAllGuide, foldGuide, guideCursor, openGuideStep, scrollGuide, stepGuide } from "./components/Guide.tsx";
import { guideAt, guideShown, toggleGuide } from "./guide.ts";
import {
  banner,
  codeMode,
  compareFocus,
  composerFocus,
  currentThreadId,
  defaultCompare,
  detail,
  diffBase,
  diffStyle,
  drafts,
  groups,
  helpOpen,
  lastCompare,
  navigate,
  notify,
  ordered,
  refreshNow,
  route,
  selectedStep,
  setFilters,
  shiftRef,
  showResolved,
  status,
  wrap,
} from "./state.ts";
import { compareHandle, openFocusedCompareThread, stepCompareThread } from "./views/Compare.tsx";
import { jumpBack, jumpForward } from "./jumps.ts";
import { resetLayout, swapped, toggleSwap, type SwapPage } from "./layout.ts";
import { findUsages } from "./usages.ts";
import { question } from "./components/Choice.tsx";
import { approveReview, submitReview } from "./views/Drafts.tsx";
import { openExternal, reopenCurrent, resolveCurrent, showThreadCode } from "./views/ThreadDetail.tsx";

/** `code`: a thread's code or the Guide tab's lines while they have the focus; there these come before the page's own keys. */
export type Where = "compare" | "guide" | "thread" | "code" | "drafts" | "everywhere";

export interface Binding {
  keys: string;
  desc: string;
  where: Where;
  visual?: boolean;
  run: (count: number) => boolean | void;
}

export const LEADER_GROUPS: Record<string, string> = {
  "<Space>f": "find",
  "<Space>s": "search",
  "<Space>u": "ui toggles",
  "<Space>r": "review",
  "<Space>g": "git",
};

export const picker = signal<"files" | "keys" | "versions" | null>(null);
export const whichKey = signal<string[] | null>(null);

const TEXT_INPUTS = new Set(["", "text", "search", "email", "url", "password", "number", "tel"]);

export function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || el.isContentEditable) return true;
  return tag === "INPUT" && TEXT_INPUTS.has(((el as HTMLInputElement).getAttribute("type") ?? "").toLowerCase());
}

function origin(e: KeyboardEvent): EventTarget | null {
  return (typeof e.composedPath === "function" ? e.composedPath()[0] : null) ?? e.target;
}

function go(id: number | null): void {
  if (id !== null) navigate({ name: "thread", id });
}

const onCompare = () => route.value.name === "compare";
const onThread = () => route.value.name === "thread";
const inGuide = () => onCompare() && guideShown.value;
const inCode = () => (onThread() || inGuide()) && codeFocus.value;

/**
 * From a thread's page into its code, or from the Guide tab into a step's lines, with the cursor where it was or on
 * the thread's first line (the step's in view).
 */
function intoCode(then: () => boolean): () => boolean {
  return () => {
    if (inGuide() ? cursorSpace.value.total === 0 : !threadCode.value) {
      notify(inGuide() ? "the guide shows no lines yet" : "this thread has no lines of code to comment on here");
      return true;
    }
    codeFocus.value = true;
    if (!cursor.value) setCursor(startCursor());
    return then();
  };
}

function move(to: Cursor | null): boolean {
  if (to) setCursor(to);
  return true;
}

function startCursor(): Cursor | null {
  if (inGuide()) return guideCursor(guideAt.value ?? guideKeys.value[0]);
  const space = cursorSpace.value;
  const code = onThread() ? threadCode.value : null;
  if (code) return space.locate(code.file.fd.name, "additions", code.start) ?? space.normalize(null);
  const focus = compareHandle.current?.order.find((p) => p.threadId === compareFocus.value);
  if (focus) {
    const at = space.locate(focus.path, focus.side, focus.range.start);
    if (at) return at;
  }
  return space.normalize(null);
}

// Set when the reader scrolls with the wheel or the mouse, cleared when the cursor moves.
let scrolled = false;
effect(() => {
  cursor.value;
  scrolled = false;
});

/** The cursor, or where a move starts once the reader scrolled it off screen: the first place on screen going down, the last going up. */
function from(dir: 1 | -1): Cursor | null {
  const c = cursor.value;
  return c && scrolled ? moveStart(cursorSpace.value, c, linesNav()?.inSight() ?? [], dir) : c;
}

function moveBy(delta: number, c = from(delta < 0 ? -1 : 1)): boolean {
  return move(c ? cursorSpace.value.move(c, delta) : startCursor());
}

function page(dir: 1 | -1): boolean {
  const c = from(dir);
  const to = c ? linesNav()?.pageFrom(c, dir) : null;
  return to ? move(to) : moveBy(dir * (linesNav()?.pageRows() ?? 15), c);
}

function repeat(n: number, dir: 1 | -1, step: (c: Cursor | null) => Cursor | null): boolean {
  let c: Cursor | null = from(dir) ?? startCursor();
  for (let i = 0; i < n; i++) {
    const next = step(c);
    if (!next) break;
    c = next;
  }
  return move(c);
}

function threadUnderCursor(): number | null {
  const c = cursor.value;
  const r = c ? cursorSpace.value.row(c) : null;
  if (!c || !r) return null;
  const block = cursorSpace.value.block(c);
  if (block) {
    const meets = (s: Span | null, p: { start: number; end: number }) => !!s && s.start <= p.end && p.start <= s.end;
    return compareHandle.current?.order.find((p) => p.path === c.path && meets(p.side === "additions" ? block.new : block.old, p.range))?.threadId ?? null;
  }
  const inRange = (n: number | null, a: number, b: number) => n !== null && n >= a && n <= b;
  const hit = compareHandle.current?.order.find(
    (p) =>
      p.path === c.path &&
      (p.side === "additions" ? r.kind !== "del" && inRange(r.new, p.range.start, p.range.end) : r.kind !== "add" && inRange(r.old, p.range.start, p.range.end)),
  );
  return hit?.threadId ?? null;
}

function focusPendingBox(): boolean {
  const box = document.querySelector<HTMLTextAreaElement>(inGuide() ? ".guide .new-thread textarea" : ":is(.codeview-host, .code-area) .new-thread textarea");
  if (!box) return false;
  box.focus();
  return true;
}

function comment(): boolean {
  const nav = linesNav();
  const c = cursor.value ?? startCursor();
  if (!nav || !c) return true;
  if (!visualAnchor.value && focusPendingBox()) return true;
  const range = cursorSpace.value.range(visualAnchor.value ?? c, c);
  visualAnchor.value = null;
  if (!range) {
    notify("put the cursor on a line of code or a rendered block (a collapsed file or a picture has none)");
    return true;
  }
  nav.startComment(range);
  return true;
}

function copyLink(): boolean {
  const c = cursor.value ?? startCursor();
  if (!c) return true;
  const range = cursorSpace.value.range(visualAnchor.value ?? c, c);
  visualAnchor.value = null;
  if (!range) notify("put the cursor on a line of code or a rendered block (a collapsed file or a picture has none)");
  else void copyLinesUrl(codeLines(range));
  return true;
}

function blameHere(): boolean {
  const c = cursor.value ?? startCursor();
  const d = compareData.value;
  if (!c || !d) return true;
  const range = cursorSpace.value.range(visualAnchor.value ?? c, c);
  visualAnchor.value = null;
  if (!range) {
    notify("put the cursor on a line of code or a rendered block (a collapsed file or a picture has none)");
    return true;
  }
  const old = range.side === "deletions";
  const fd = fileRows.value.find((r) => r.fd.name === range.path)?.fd;
  const end = old ? d.from : d.to;
  openBlame({
    path: old ? (fd?.prevName ?? range.path) : range.path,
    start: range.start,
    end: range.end,
    at: end.ref,
    label: end.label,
    place: () => compareNav.current?.cursorElement(c)?.getBoundingClientRect() ?? null,
  });
  return true;
}

/** The thread's lines in the code shown on its page: at the step on the right of the diff, or at "then" / the step. */
function blameThread(): boolean {
  const d = detail.value;
  if (!d || d.thread.region) return true;
  const sel = clampStep(d, selectedStep.value);
  const pair = diffPair(d, sel, diffBase.value);
  const step = codeMode.value === "diff" && pair ? pair.to : codeMode.value === "now" ? d.timeline[sel]! : d.timeline[0]!;
  const exact = step.version !== null && step.label === `v${step.version}`;
  const at = step.kind === "now" || step.sha === status.value?.pinnedNow ? "now" : exact ? String(step.version) : null;
  if (!step.path || !step.range) notify(`the thread's code is gone at ${step.label}`);
  else if (!at) notify(`the thread was written on code between versions (${step.label}): blame goes over versions, pick a later step`);
  else
    openBlame({
      path: step.path,
      start: step.range.start,
      end: step.range.end,
      at,
      label: step.label,
      place: () => document.querySelector(".thread-code .code-label")?.getBoundingClientRect() ?? null,
    });
  return true;
}

function visual(): boolean {
  const c = cursor.value ?? startCursor();
  if (!c) return true;
  setCursor(c);
  visualAnchor.value = c;
  return true;
}

function fold(open: boolean | "toggle"): boolean {
  const path = cursor.value?.path;
  const row = fileRows.value.find((r) => r.fd.name === path);
  if (!row) return true;
  const m = new Map(fileOpen.value);
  const next = open === "toggle" ? isCollapsed(row.fd) : open;
  m.set(row.fd.name, next);
  fileOpen.value = m;
  setCursor({ path: row.fd.name, row: next ? 0 : -1 });
  return true;
}

function foldAll(open: boolean): boolean {
  const m = new Map<string, boolean>();
  for (const r of fileRows.value) m.set(r.fd.name, open);
  fileOpen.value = m;
  if (cursor.value) setCursor({ path: cursor.value.path, row: open ? 0 : -1 });
  return true;
}

function unread(dir: 1 | -1): boolean {
  const id = stepUnread(ordered.value, currentThreadId.value, dir);
  if (id === null) notify("no unread threads");
  else go(id);
  return true;
}

function toThread(dir: 1 | -1): boolean {
  stepCompareThread(dir);
  const p = compareHandle.current?.order.find((x) => x.threadId === compareFocus.value);
  const at = p ? cursorSpace.value.locate(p.path, p.side, p.range.start) : null;
  if (at) cursor.value = at;
  return true;
}

function backToThread(): boolean {
  const id = compareFocus.value;
  if (id === null || !compareHandle.current?.scrollToThread(id)) {
    notify("no thread to go back to: open one, or step to one with ]t");
    return true;
  }
  spotThread(id);
  const p = compareHandle.current.order.find((x) => x.threadId === id);
  const at = p ? cursorSpace.value.locate(p.path, p.side, p.range.start) : null;
  if (at) cursor.value = at;
  return true;
}

function reviewAction(): boolean {
  if (route.value.name !== "drafts") navigate({ name: "drafts" });
  else if (drafts.value.length > 0) void submitReview();
  else void approveReview();
  return true;
}

function shift(which: "from" | "to", dir: 1 | -1): boolean {
  const r = route.value;
  if (r.name === "compare") navigate({ name: "compare", from: which === "from" ? shiftRef(r.from, dir) : r.from, to: which === "to" ? shiftRef(r.to, dir) : r.to });
  return true;
}

function stepTimeline(dir: 1 | -1): boolean {
  const d = detail.value;
  if (d) selectedStep.value = clampStep(d, clampStep(d, selectedStep.value) + dir);
  return true;
}

function search(scope: "diff" | "files"): boolean {
  searchScope.value = scope;
  openSearch();
  return true;
}

function swapColumns(page: SwapPage): boolean {
  toggleSwap(page);
  const handle = document.querySelector<HTMLElement>(page === "compare" ? ".side-splitter" : ".msgs-splitter");
  if (!handle || getComputedStyle(handle).display !== "none") return true;
  const on = swapped(page);
  const where = page === "compare" ? `the side panel on the ${on ? "right" : "left"}` : `the conversation ${on ? "left" : "right"} of the code`;
  notify(`${where} once the window is wide enough for the columns to stand side by side`);
  return true;
}

const searching = () => (searchScope.value === "files" ? grepHits.value.length : searchHits.value.length) > 0;
const toggle = (fn: () => void) => () => {
  fn();
  return true;
};

export const BINDINGS: Binding[] = [
  { keys: "j", desc: "cursor down (5j: five lines)", where: "compare", visual: true, run: (n) => moveBy(n) },
  { keys: "k", desc: "cursor up", where: "compare", visual: true, run: (n) => moveBy(-n) },
  { keys: "<Down>", desc: "cursor down", where: "compare", visual: true, run: (n) => moveBy(n) },
  { keys: "<Up>", desc: "cursor up", where: "compare", visual: true, run: (n) => moveBy(-n) },
  { keys: "gg", desc: "first line of the diff", where: "compare", visual: true, run: () => move(cursorSpace.value.at(0)) },
  { keys: "G", desc: "last line of the diff", where: "compare", visual: true, run: () => move(cursorSpace.value.at(cursorSpace.value.total - 1)) },
  { keys: "<C-d>", desc: "half a page down", where: "compare", visual: true, run: () => page(1) },
  { keys: "<C-u>", desc: "half a page up", where: "compare", visual: true, run: () => page(-1) },
  { keys: "]c", desc: "next change", where: "compare", visual: true, run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextChange(c, 1)) },
  { keys: "[c", desc: "previous change", where: "compare", visual: true, run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextChange(c, -1)) },
  { keys: "]h", desc: "next hunk", where: "compare", visual: true, run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextHunk(c, 1)) },
  { keys: "[h", desc: "previous hunk", where: "compare", visual: true, run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextHunk(c, -1)) },
  { keys: "]b", desc: "next file", where: "compare", run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextFile(c, 1)) },
  { keys: "[b", desc: "previous file", where: "compare", run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextFile(c, -1)) },
  { keys: "L", desc: "next file", where: "compare", run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextFile(c, 1)) },
  { keys: "H", desc: "previous file", where: "compare", run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextFile(c, -1)) },
  { keys: "]t", desc: "next thread on this diff", where: "compare", run: () => toThread(1) },
  { keys: "[t", desc: "previous thread on this diff", where: "compare", run: () => toThread(-1) },
  { keys: "gt", desc: "back to the thread last opened or stepped to, marked in the code", where: "compare", run: backToThread },
  { keys: "]u", desc: "next unread thread", where: "compare", run: () => unread(1) },
  { keys: "[u", desc: "previous unread thread", where: "compare", run: () => unread(-1) },
  { keys: "n", desc: "next search match (no search: next unread thread)", where: "compare", run: () => (searching() ? stepHit(1) || true : unread(1)) },
  { keys: "N", desc: "previous search match (no search: previous unread)", where: "compare", run: () => (searching() ? stepHit(-1) || true : unread(-1)) },
  { keys: "zz", desc: "center the cursor line", where: "compare", run: toggle(() => cursor.value && compareNav.current?.revealCursor(cursor.value, "center")) },
  { keys: "zo", desc: "open the file under the cursor", where: "compare", run: () => fold(true) },
  { keys: "zc", desc: "close the file under the cursor", where: "compare", run: () => fold(false) },
  { keys: "za", desc: "open / close the file under the cursor", where: "compare", run: () => fold("toggle") },
  { keys: "zR", desc: "open all files", where: "compare", run: () => foldAll(true) },
  { keys: "zM", desc: "close all files", where: "compare", run: () => foldAll(false) },
  { keys: "V", desc: "select lines (visual mode)", where: "compare", run: visual },
  { keys: "v", desc: "select lines (visual mode)", where: "compare", run: visual },
  { keys: "o", desc: "other end of the selection", where: "compare", visual: true, run: () => {
    const a = visualAnchor.value;
    if (!a) return openFocusedCompareThread();
    visualAnchor.value = cursor.value;
    return move(a);
  } },
  { keys: "i", desc: "comment on the cursor line or the selection", where: "compare", visual: true, run: comment },
  { keys: "a", desc: "comment (same as i)", where: "compare", visual: true, run: comment },
  { keys: "c", desc: "comment (same as i)", where: "compare", visual: true, run: comment },
  { keys: "gc", desc: "comment on the selection", where: "compare", visual: true, run: comment },
  { keys: "gcc", desc: "comment on the cursor line", where: "compare", run: comment },
  { keys: "<CR>", desc: "open the thread under the cursor", where: "compare", run: () => {
    const id = threadUnderCursor();
    if (id === null) return openFocusedCompareThread();
    navigate({ name: "thread", id });
    return true;
  } },
  { keys: "]v", desc: "“to” one version later", where: "compare", run: () => shift("to", 1) },
  { keys: "[v", desc: "“to” one version earlier", where: "compare", run: () => shift("to", -1) },
  { keys: "}", desc: "“from” one version later", where: "compare", run: () => shift("from", 1) },
  { keys: "{", desc: "“from” one version earlier", where: "compare", run: () => shift("from", -1) },
  { keys: "/", desc: "search the diff", where: "compare", run: () => search("diff") },
  { keys: "*", desc: "find where the selected word is used (all files)", where: "compare", run: () => findUsages() },
  { keys: "<F3>", desc: "next search match", where: "compare", run: () => stepHit(1) || true },
  { keys: "<S-F3>", desc: "previous search match", where: "compare", run: () => stepHit(-1) || true },
  { keys: "<Space>gc", desc: "commits: pick the two ends of the compare", where: "compare", run: toggle(() => (commitPicker.value = !commitPicker.value)) },
  { keys: "<Space>gY", desc: "copy a link to the cursor line or the selection", where: "compare", visual: true, run: copyLink },
  { keys: "<Space>gb", desc: "blame: the version, round and threads that brought the cursor line or the selection", where: "compare", visual: true, run: blameHere },
  { keys: "<Space>gb", desc: "blame: the version, round and threads that brought the thread's lines in the code shown", where: "thread", run: blameThread },
  { keys: "<Esc>", desc: "close the commits or the preview, the selection, then the comment box", where: "compare", visual: true, run: toggle(() => {
    if (commitPicker.value) commitPicker.value = false;
    else if (peek.value) peek.value = null;
    else if (visualAnchor.value) visualAnchor.value = null;
    else compareHandle.current?.cancelPending();
  }) },
  { keys: "<Space>ug", desc: "the agent's guide to the version on the right, or back to the diff (experimental)", where: "compare", visual: true, run: toggleGuide },
  { keys: "+", desc: "zoom in on the picture under the mouse (or the one in sight)", where: "compare", run: () => zoomKey(1) },
  { keys: "=", desc: "zoom in on the picture (same as +)", where: "compare", run: () => zoomKey(1) },
  { keys: "-", desc: "zoom out of the picture", where: "compare", run: () => zoomKey(-1) },
  { keys: "0", desc: "fit the picture in its place again", where: "compare", run: () => zoomKey(0) },

  { keys: "<Space>ug", desc: "back to the diff", where: "guide", run: toggleGuide },
  { keys: "<Esc>", desc: "back to the diff", where: "guide", run: toggleGuide },
  { keys: "}", desc: "next step (3}: three steps)", where: "guide", run: (n) => stepGuide(1, n) },
  { keys: "{", desc: "previous step", where: "guide", run: (n) => stepGuide(-1, n) },
  { keys: "<CR>", desc: "open the step in the diff, at its first lines", where: "guide", run: openGuideStep },
  { keys: "j", desc: "scroll down", where: "guide", run: (n) => scrollGuide(n, 1) },
  { keys: "k", desc: "scroll up", where: "guide", run: (n) => scrollGuide(n, -1) },
  { keys: "<C-d>", desc: "half a page down", where: "guide", run: () => scrollGuide("half", 1) },
  { keys: "<C-u>", desc: "half a page up", where: "guide", run: () => scrollGuide("half", -1) },
  { keys: "za", desc: "fold / unfold the file diff in view (a long one starts folded)", where: "guide", run: () => foldGuide("toggle") },
  { keys: "zo", desc: "unfold the file diff in view", where: "guide", run: () => foldGuide(true) },
  { keys: "zc", desc: "fold the file diff in view", where: "guide", run: () => foldGuide(false) },
  { keys: "zR", desc: "unfold every file diff of the guide", where: "guide", run: () => foldAllGuide(true) },
  { keys: "zM", desc: "fold every file diff of the guide", where: "guide", run: () => foldAllGuide(false) },
  { keys: "V", desc: "into the code: select lines from the cursor, at first on the step's lines in view", where: "guide", run: intoCode(visual) },
  { keys: "i", desc: "into the code: comment on the cursor line, at first the first line of the step in view", where: "guide", run: intoCode(comment) },
  { keys: "a", desc: "into the code: comment (same as i)", where: "guide", run: intoCode(comment) },
  { keys: "c", desc: "into the code: comment (same as i)", where: "guide", run: intoCode(comment) },
  { keys: "gcc", desc: "into the code: comment on the cursor line", where: "guide", run: intoCode(comment) },

  { keys: "j", desc: "next thread", where: "thread", run: () => go(stepThread(ordered.value, currentThreadId.value, 1)) },
  { keys: "k", desc: "previous thread", where: "thread", run: () => go(stepThread(ordered.value, currentThreadId.value, -1)) },
  { keys: "J", desc: "first thread of the next file", where: "thread", run: () => go(stepFile(groups.value, currentThreadId.value, 1)) },
  { keys: "K", desc: "first thread of the previous file", where: "thread", run: () => go(stepFile(groups.value, currentThreadId.value, -1)) },
  { keys: "n", desc: "next unread thread", where: "thread", run: () => unread(1) },
  { keys: "N", desc: "previous unread thread", where: "thread", run: () => unread(-1) },
  { keys: "]", desc: "next timeline step", where: "thread", run: () => stepTimeline(1) },
  { keys: "[", desc: "previous timeline step", where: "thread", run: () => stepTimeline(-1) },
  { keys: "/", desc: "search all files at the step shown", where: "thread", run: () => search("files") },
  { keys: "*", desc: "find where the selected word is used, at the step shown", where: "thread", run: () => findUsages() },
  { keys: "t", desc: "code: diff → then → at step", where: "thread", run: toggle(() => (codeMode.value = codeMode.value === "diff" ? "then" : codeMode.value === "then" ? "now" : "diff")) },
  { keys: "p", desc: "diff against then / the previous step", where: "thread", run: toggle(() => (diffBase.value = diffBase.value === "then" ? "prev" : "then")) },
  { keys: "}", desc: "next message (3}: three messages)", where: "thread", run: (n) => stepMsg(1, n) },
  { keys: "{", desc: "previous message", where: "thread", run: (n) => stepMsg(-1, n) },
  { keys: "gg", desc: "first message", where: "thread", run: () => edgeMsg(false) },
  { keys: "G", desc: "last message and the reply box", where: "thread", run: () => edgeMsg(true) },
  { keys: "<C-d>", desc: "half a page down the conversation", where: "thread", run: () => halfPage(1) },
  { keys: "<C-u>", desc: "half a page up the conversation", where: "thread", run: () => halfPage(-1) },
  { keys: "za", desc: "fold / unfold the long message under the cursor", where: "thread", run: () => foldMsg(detail.value, "toggle") },
  { keys: "zo", desc: "unfold the message under the cursor", where: "thread", run: () => foldMsg(detail.value, true) },
  { keys: "zc", desc: "fold the message under the cursor", where: "thread", run: () => foldMsg(detail.value, false) },
  { keys: "zR", desc: "unfold all messages", where: "thread", run: () => foldAllMsgs(detail.value, true) },
  { keys: "zM", desc: "fold all long messages", where: "thread", run: () => foldAllMsgs(detail.value, false) },
  { keys: "r", desc: "reply to the message under the cursor (moved with { } or a click), else to the thread", where: "thread", run: toggle(() => replyAtCursor() || composerFocus.value++) },
  { keys: "x", desc: "resolve (a reason can be picked afterwards)", where: "thread", run: toggle(() => {
    const d = detail.value;
    if (d && d.thread.status === "open" && !d.thread.draft) void resolveCurrent(null);
  }) },
  { keys: "X", desc: "reopen", where: "thread", run: toggle(() => detail.value?.thread.status === "resolved" && void reopenCurrent()) },
  { keys: "e", desc: "open in the editor (STET_EDITOR)", where: "thread", run: toggle(() => void openExternal()) },
  { keys: "<Esc>", desc: "close the preview, then back to the changes, at this thread", where: "thread", run: toggle(() => {
    if (peek.value) peek.value = null;
    else navigate(lastCompare.value ? { name: "compare", ...lastCompare.value } : { name: "home" });
  }) },
  { keys: "gt", desc: "back to the thread's lines in the code, marked", where: "thread", run: showThreadCode },
  { keys: "V", desc: "into the code: select lines from the cursor, at first on the thread's lines", where: "thread", run: intoCode(visual) },
  { keys: "i", desc: "into the code: comment on the cursor line, at first the thread's first line", where: "thread", run: intoCode(comment) },
  { keys: "a", desc: "into the code: comment (same as i)", where: "thread", run: intoCode(comment) },
  { keys: "c", desc: "into the code: comment (same as i)", where: "thread", run: intoCode(comment) },
  { keys: "gcc", desc: "into the code: comment on the cursor line", where: "thread", run: intoCode(comment) },
  { keys: "+", desc: "zoom in on the picture under the mouse (or the one in sight)", where: "thread", run: () => zoomKey(1) },
  { keys: "=", desc: "zoom in on the picture (same as +)", where: "thread", run: () => zoomKey(1) },
  { keys: "-", desc: "zoom out of the picture", where: "thread", run: () => zoomKey(-1) },
  { keys: "0", desc: "fit the picture in its place again", where: "thread", run: () => zoomKey(0) },

  { keys: "j", desc: "cursor down (5j: five lines)", where: "code", visual: true, run: (n) => moveBy(n) },
  { keys: "k", desc: "cursor up", where: "code", visual: true, run: (n) => moveBy(-n) },
  { keys: "<Down>", desc: "cursor down", where: "code", visual: true, run: (n) => moveBy(n) },
  { keys: "<Up>", desc: "cursor up", where: "code", visual: true, run: (n) => moveBy(-n) },
  { keys: "gg", desc: "first line of the code shown", where: "code", visual: true, run: () => move(cursorSpace.value.at(0)) },
  { keys: "G", desc: "last line of the code shown", where: "code", visual: true, run: () => move(cursorSpace.value.at(cursorSpace.value.total - 1)) },
  { keys: "<C-d>", desc: "half a page down", where: "code", visual: true, run: () => page(1) },
  { keys: "<C-u>", desc: "half a page up", where: "code", visual: true, run: () => page(-1) },
  { keys: "]c", desc: "next change", where: "code", visual: true, run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextChange(c, 1)) },
  { keys: "[c", desc: "previous change", where: "code", visual: true, run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextChange(c, -1)) },
  { keys: "]h", desc: "next hunk", where: "code", visual: true, run: (n) => repeat(n, 1, (c) => cursorSpace.value.nextHunk(c, 1)) },
  { keys: "[h", desc: "previous hunk", where: "code", visual: true, run: (n) => repeat(n, -1, (c) => cursorSpace.value.nextHunk(c, -1)) },
  { keys: "zz", desc: "center the cursor line", where: "code", run: toggle(() => cursor.value && linesNav()?.revealCursor(cursor.value, "center")) },
  { keys: "V", desc: "select lines (visual mode)", where: "code", run: visual },
  { keys: "v", desc: "select lines (visual mode)", where: "code", run: visual },
  { keys: "o", desc: "other end of the selection", where: "code", visual: true, run: () => {
    const a = visualAnchor.value;
    if (!a) return false;
    visualAnchor.value = cursor.value;
    return move(a);
  } },
  { keys: "i", desc: "comment on the cursor line or the selection: a new thread, or quote it in the reply", where: "code", visual: true, run: comment },
  { keys: "a", desc: "comment (same as i)", where: "code", visual: true, run: comment },
  { keys: "c", desc: "comment (same as i)", where: "code", visual: true, run: comment },
  { keys: "gc", desc: "comment on the selection", where: "code", visual: true, run: comment },
  { keys: "gcc", desc: "comment on the cursor line", where: "code", run: comment },
  { keys: "<Space>gY", desc: "copy a link to the cursor line or the selection, on the Changes page of the versions shown", where: "code", visual: true, run: copyLink },
  { keys: "<Esc>", desc: "close the preview, the selection, the comment box, then leave the code: the page's keys again", where: "code", visual: true, run: toggle(() => {
    if (peek.value) peek.value = null;
    else if (visualAnchor.value) visualAnchor.value = null;
    else if (pendingLines.value) linesNav()?.cancelComment();
    else leaveCode();
  }) },

  { keys: "S", desc: "request changes: send the drafts (no drafts: approve)", where: "drafts", run: reviewAction },

  { keys: "?", desc: "all keys", where: "everywhere", run: toggle(() => (helpOpen.value = !helpOpen.value)) },
  { keys: "<C-o>", desc: "jump back (page, search hit, file jump)", where: "everywhere", run: jumpBack },
  { keys: "<C-i>", desc: "jump forward", where: "everywhere", run: jumpForward },
  { keys: "v", desc: "changes since you last looked", where: "everywhere", run: toggle(() => navigate({ name: "compare", ...defaultCompare() })) },
  { keys: "s", desc: "your drafts", where: "everywhere", run: toggle(() => navigate({ name: "drafts" })) },
  { keys: "S", desc: "drafts, then S again submits (approves when there are no drafts)", where: "everywhere", run: reviewAction },
  { keys: "w", desc: "wrap long lines", where: "everywhere", run: toggle(() => (wrap.value = !wrap.value)) },
  { keys: "R", desc: "re-read “now” from the working tree", where: "everywhere", run: toggle(() => ((banner.value = null), void refreshNow())) },
  { keys: "/", desc: "filter threads by file", where: "everywhere", run: toggle(() => {
    const input = document.getElementById("file-filter") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }) },
  { keys: "<Esc>", desc: "close", where: "everywhere", run: toggle(() => (helpOpen.value = false)) },

  { keys: "<Space><Space>", desc: "find a file of the diff", where: "compare", run: toggle(() => (picker.value = "files")) },
  { keys: "<Space>ff", desc: "find a file of the diff", where: "compare", run: toggle(() => (picker.value = "files")) },
  { keys: "<Space>gs", desc: "git state: pushed or not, staged, not staged, new files", where: "everywhere", run: toggle(() => (gitOpen.value = !gitOpen.value)) },
  { keys: "<Space>fv", desc: "find a version: what changed in it, or make it from / to", where: "everywhere", run: toggle(() => (picker.value = "versions")) },
  { keys: "<Space>/", desc: "search all files", where: "compare", run: () => search("files") },
  { keys: "<Space>sg", desc: "search all files (grep)", where: "compare", run: () => search("files") },
  { keys: "<Space>sw", desc: "find the selected word in all files", where: "compare", run: () => findUsages() },
  { keys: "<Space>/", desc: "search all files at the step shown", where: "thread", run: () => search("files") },
  { keys: "<Space>sg", desc: "search all files at the step shown", where: "thread", run: () => search("files") },
  { keys: "<Space>sw", desc: "find the selected word, at the step shown", where: "thread", run: () => findUsages() },
  { keys: "<Space>st", desc: "threads", where: "thread", run: toggle(() => (sideTab.value = "threads")) },
  { keys: "<Space>e", desc: "files of the last diff", where: "thread", run: toggle(() => (sideTab.value = "files")) },
  { keys: "<Space>sd", desc: "search the diff", where: "compare", run: () => search("diff") },
  { keys: "<Space>sk", desc: "search keys and run one", where: "everywhere", run: toggle(() => (picker.value = "keys")) },
  { keys: "<Space>st", desc: "threads", where: "compare", run: toggle(() => (sideTab.value = "threads")) },
  { keys: "<Space>e", desc: "files of the diff", where: "compare", run: toggle(() => (sideTab.value = "files")) },
  { keys: "<Space>n", desc: "only threads with news", where: "everywhere", run: toggle(() => ((sideTab.value = "threads"), setFilters({ newOnly: true }))) },
  { keys: "<Space>uw", desc: "wrap long lines", where: "everywhere", run: toggle(() => (wrap.value = !wrap.value)) },
  { keys: "<Space>ud", desc: "split / unified diff", where: "everywhere", run: toggle(() => (diffStyle.value = diffStyle.value === "split" ? "unified" : "split")) },
  { keys: "<Space>ur", desc: "show / hide resolved threads", where: "everywhere", run: toggle(() => (showResolved.value = !showResolved.value)) },
  { keys: "<Space>ut", desc: "show / hide test files that only add code", where: "compare", run: toggle(() => (groupsOpen.value = { ...groupsOpen.value, tests: !groupsOpen.value.tests })) },
  { keys: "<Space>ul", desc: "side panel left / right of the diff", where: "compare", run: () => swapColumns("compare") },
  { keys: "<Space>ul", desc: "conversation left / right of the code", where: "thread", run: () => swapColumns("thread") },
  { keys: "<Space>uL", desc: "reset the layout of this page: column order and widths", where: "everywhere", run: toggle(resetLayout) },
  { keys: "<Space>rd", desc: "drafts", where: "everywhere", run: toggle(() => navigate({ name: "drafts" })) },
  { keys: "<Space>rs", desc: "submit the review from the drafts page (approve when there are no drafts)", where: "everywhere", run: reviewAction },
  { keys: "<Space>rv", desc: "changes since you last looked", where: "everywhere", run: toggle(() => navigate({ name: "compare", ...defaultCompare() })) },
  { keys: "<Space>rr", desc: "re-read “now”", where: "everywhere", run: toggle(() => ((banner.value = null), void refreshNow())) },
  { keys: "<Space>?", desc: "all keys", where: "everywhere", run: toggle(() => (helpOpen.value = true)) },
];

export function tokens(keys: string): string[] {
  return keys.match(/<[^>]+>|./g) ?? [];
}

const LATIN: Record<string, [string, string]> = {
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Slash: ["/", "?"],
  Semicolon: [";", ":"],
  Quote: ["'", "\""],
  Comma: [",", "<"],
  Period: [".", ">"],
};

export function keyToken(e: KeyboardEvent): string | null {
  const k = e.key;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"].includes(k)) return null;
  const code = e.code ?? "";
  if (e.ctrlKey || e.metaKey) return code.startsWith("Key") ? `<C-${code.slice(3).toLowerCase()}>` : null;
  if (e.altKey) return null;
  if (k === " ") return "<Space>";
  if (k === "Enter") return e.shiftKey ? "<S-CR>" : "<CR>";
  if (k === "Escape") return "<Esc>";
  if (k === "ArrowDown") return "<Down>";
  if (k === "ArrowUp") return "<Up>";
  if (/^F\d+$/.test(k)) return e.shiftKey ? `<S-${k}>` : `<${k}>`;
  if (k.length !== 1) return null;
  if (k.charCodeAt(0) > 127) {
    if (code.startsWith("Key")) return e.shiftKey ? code.slice(3) : code.slice(3).toLowerCase();
    if (LATIN[code]) return LATIN[code]![e.shiftKey ? 1 : 0];
  }
  const own = LATIN[code];
  if (own && !own.includes(k) && Object.values(LATIN).some((pair) => pair.includes(k))) return own[e.shiftKey ? 1 : 0];
  return k;
}

export function contexts(): Where[] {
  const r = route.value.name;
  return r === "compare"
    ? guideShown.value
      ? [...(codeFocus.value ? (["code"] as Where[]) : []), "guide", "everywhere"]
      : ["compare", "everywhere"]
    : r === "thread"
      ? [...(codeFocus.value ? (["code"] as Where[]) : []), "thread", "everywhere"]
      : r === "drafts"
        ? ["drafts", "everywhere"]
        : ["everywhere"];
}

/** The bindings of this page, the first context's first: a key bound twice does what the first one says. */
export function bindingsHere(): Binding[] {
  const where = contexts();
  return BINDINGS.filter((b) => where.includes(b.where)).sort((a, b) => where.indexOf(a.where) - where.indexOf(b.where));
}

function candidates(prefix: string[]): Binding[] {
  const visualMode = !!visualAnchor.value && (contexts().includes("compare") || inCode());
  const seen = new Set<string>();
  return bindingsHere().filter((b) => {
    if ((visualMode && !b.visual) || seen.has(b.keys)) return false;
    const t = tokens(b.keys);
    if (t.length < prefix.length || prefix.some((k, i) => t[i] !== k)) return false;
    seen.add(b.keys);
    return true;
  });
}

export function nextKeys(prefix: string[]): { key: string; desc: string }[] {
  const out = new Map<string, string>();
  for (const b of candidates(prefix)) {
    const t = tokens(b.keys);
    const key = t[prefix.length]!;
    if (out.has(key)) continue;
    out.set(key, t.length === prefix.length + 1 ? b.desc : `+${LEADER_GROUPS[[...prefix, key].join("")] ?? "more"}`);
  }
  return [...out.entries()].map(([key, desc]) => ({ key, desc }));
}

let buffer: string[] = [];
let count = "";
let timer: ReturnType<typeof setTimeout> | undefined;

function reset(): void {
  buffer = [];
  count = "";
  whichKey.value = null;
  clearTimeout(timer);
}

function fire(b: Binding): boolean {
  const n = Math.max(1, Number(count) || 1);
  reset();
  return b.run(n) !== false;
}

export function handleKey(e: KeyboardEvent): boolean {
  const target = origin(e);
  if (e.code === "KeyS" && (e.ctrlKey || e.metaKey) && !typing(target)) {
    notify("nothing to save here: text you type is kept as you type");
    return true;
  }
  if ((onCompare() || onThread()) && e.code === "KeyF" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) return search(onThread() ? "files" : "diff");
  if (typing(target) || picker.value || question.value) return false;
  const t = keyToken(e);
  if (t === null) return false;
  if (t === "<Esc>" && helpOpen.value) {
    helpOpen.value = false;
    return true;
  }
  if (t === "<Esc>" && (buffer.length > 0 || count)) {
    reset();
    return true;
  }
  if (buffer.length === 0 && (onCompare() || inCode()) && /^[0-9]$/.test(t) && (t !== "0" || count)) {
    count += t;
    return true;
  }
  const prefix = [...buffer, t];
  const list = candidates(prefix);
  if (list.length === 0) {
    const had = buffer.length > 0;
    reset();
    return had ? handleKey(e) : false;
  }
  const exact = list.find((b) => tokens(b.keys).length === prefix.length);
  const longer = list.some((b) => tokens(b.keys).length > prefix.length);
  if (exact && !longer) return fire(exact);
  buffer = prefix;
  clearTimeout(timer);
  if (buffer[0] === "<Space>") whichKey.value = [...buffer];
  if (exact) timer = setTimeout(() => fire(exact), 600);
  return true;
}

const CONTROLS = new Set(["BUTTON", "SELECT", "INPUT", "A", "SUMMARY"]);

export function installKeys(): void {
  let held = false;
  const opts = { capture: true, passive: true };
  window.addEventListener("wheel", () => (scrolled = true), opts);
  window.addEventListener("pointerdown", () => (held = true), opts);
  for (const ev of ["pointerup", "pointercancel"]) window.addEventListener(ev, () => (held = false), opts);
  // a drag on a scrollbar, or a selection that scrolls the code
  window.addEventListener("scroll", () => held && (scrolled = true), opts);
  window.addEventListener("keydown", (e) => {
    const target = origin(e);
    const handled = handleKey(e);
    if (handled) {
      e.preventDefault();
      const el = document.activeElement as HTMLElement | null;
      if (el && CONTROLS.has(el.tagName) && !typing(el)) el.blur();
    } else if (e.key === " " && !typing(target) && !picker.value) {
      e.preventDefault();
    }
  });
}
