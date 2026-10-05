import { signal } from "@preact/signals";
import {
  compareData,
  compareNav,
  copyLinesUrl,
  cursor,
  cursorSpace,
  fileOpen,
  fileRows,
  grepHits,
  groupsOpen,
  isCollapsed,
  openSearch,
  peek,
  searchHits,
  searchScope,
  setCursor,
  sideTab,
  stepHit,
  visualAnchor,
} from "./compare.ts";
import type { Cursor, Span } from "./lib/cursor.ts";
import { stepFile, stepThread, stepUnread } from "./lib/nav.ts";
import { commitPicker } from "./commits.ts";
import { gitOpen } from "./components/GitState.tsx";
import { edgeMsg, foldAllMsgs, foldMsg, halfPage, replyAtCursor, stepMsg } from "./msgs.ts";
import { clampStep, diffPair } from "./lib/timeline.ts";
import { openBlame } from "./components/Blame.tsx";
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
import { openExternal, reopenCurrent, resolveCurrent } from "./views/ThreadDetail.tsx";

export type Where = "compare" | "thread" | "drafts" | "everywhere";

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

function move(to: Cursor | null): boolean {
  if (to) setCursor(to);
  return true;
}

function startCursor(): Cursor | null {
  const space = cursorSpace.value;
  const focus = compareHandle.current?.order.find((p) => p.threadId === compareFocus.value);
  if (focus) {
    const at = space.locate(focus.path, focus.side, focus.range.start);
    if (at) return at;
  }
  return space.normalize(null);
}

function moveBy(delta: number): boolean {
  if (!cursor.value) return move(startCursor());
  return move(cursorSpace.value.move(cursor.value, delta));
}

function page(dir: 1 | -1): boolean {
  const c = cursor.value;
  const to = c ? compareNav.current?.pageFrom(c, dir) : null;
  return to ? move(to) : moveBy(dir * (compareNav.current?.pageRows() ?? 15));
}

function repeat(n: number, step: (c: Cursor | null) => Cursor | null): boolean {
  let c: Cursor | null = cursor.value ?? startCursor();
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
  const box = document.querySelector<HTMLTextAreaElement>(".codeview-host .new-thread textarea");
  if (!box) return false;
  box.focus();
  return true;
}

function comment(): boolean {
  const nav = compareNav.current;
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
  else void copyLinesUrl(range);
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
  { keys: "]c", desc: "next change", where: "compare", visual: true, run: (n) => repeat(n, (c) => cursorSpace.value.nextChange(c, 1)) },
  { keys: "[c", desc: "previous change", where: "compare", visual: true, run: (n) => repeat(n, (c) => cursorSpace.value.nextChange(c, -1)) },
  { keys: "]h", desc: "next hunk", where: "compare", visual: true, run: (n) => repeat(n, (c) => cursorSpace.value.nextHunk(c, 1)) },
  { keys: "[h", desc: "previous hunk", where: "compare", visual: true, run: (n) => repeat(n, (c) => cursorSpace.value.nextHunk(c, -1)) },
  { keys: "]b", desc: "next file", where: "compare", run: (n) => repeat(n, (c) => cursorSpace.value.nextFile(c, 1)) },
  { keys: "[b", desc: "previous file", where: "compare", run: (n) => repeat(n, (c) => cursorSpace.value.nextFile(c, -1)) },
  { keys: "L", desc: "next file", where: "compare", run: (n) => repeat(n, (c) => cursorSpace.value.nextFile(c, 1)) },
  { keys: "H", desc: "previous file", where: "compare", run: (n) => repeat(n, (c) => cursorSpace.value.nextFile(c, -1)) },
  { keys: "]t", desc: "next thread on this diff", where: "compare", run: () => toThread(1) },
  { keys: "[t", desc: "previous thread on this diff", where: "compare", run: () => toThread(-1) },
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
  return r === "compare" ? ["compare", "everywhere"] : r === "thread" ? ["thread", "everywhere"] : r === "drafts" ? ["drafts", "everywhere"] : ["everywhere"];
}

function candidates(prefix: string[]): Binding[] {
  const where = contexts();
  const visualMode = !!visualAnchor.value && onCompare();
  const seen = new Set<string>();
  return BINDINGS.filter((b) => {
    if (!where.includes(b.where) || (visualMode && !b.visual) || seen.has(b.keys)) return false;
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
  if (buffer.length === 0 && onCompare() && /^[0-9]$/.test(t) && (t !== "0" || count)) {
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
