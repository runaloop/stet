import { effect, signal } from "@preact/signals";
import {
  codeFocus,
  codeLines,
  compareData,
  compareHandle,
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
import { moveStart, type Cursor, type Span } from "../src/ui/cursor.ts";
import { stepFile, stepThread, stepUnread } from "../src/ui/nav.ts";
import { commitPicker } from "./commits.ts";
import { gitOpen } from "./components/GitState.tsx";
import { edgeMsg, foldAllMsgs, foldMsg, halfPage, replyAtCursor, stepMsg } from "./msgs.ts";
import { clampStep, diffPair, missingThreadCode } from "../src/ui/timeline.ts";
import { openBlame } from "./components/Blame.tsx";
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
import { openFocusedCompareThread, stepCompareThread } from "./views/Compare.tsx";
import { jumpBack, jumpForward } from "./jumps.ts";
import { resetLayout, swapped, toggleSwap, type SwapPage } from "./layout.ts";
import { findUsages } from "./usages.ts";
import { transition } from "./transition.ts";
import { question } from "./components/Choice.tsx";
import { approveReview, submitReview } from "./views/Drafts.tsx";
import { openExternal, reopenCurrent, resolveCurrent, showThreadCode } from "./views/ThreadDetail.tsx";
import { openResolveWithMessage } from "./components/ResolveWithMessage.tsx";
import { moduleActions, moduleRows } from "./modules.tsx";
import { COUNT_SCOPES, KEYS, WEB_SCOPES, type KeyRow, type Mode, type Scope } from "../src/ui/keys/table.ts";
import { KeyMatcher, nextAfter, reads, rowFor, runRow, type Actions, type Next, type Reader } from "../src/ui/keys/match.ts";
import { keyToken } from "./keyinput.ts";

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

/** A jump to a far place in the code: the view fades over to it. */
function far(run: (count: number) => boolean): (count: number) => boolean {
  return (n) => {
    transition();
    return run(n);
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
  if (!step.path || !step.range) {
    const missing = missingThreadCode(d, step.index);
    notify(missing?.kind === "deleted" ? `the commented code was deleted at ${missing.at.label}` : `cannot locate the commented code at ${step.label}; deletion is not confirmed`);
  }
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

/** A preview a link opened goes back to where the reader was, as Ctrl+O does; another one just closes. */
function closePeek(): void {
  if (peek.value?.jumped) jumpBack();
  else peek.value = null;
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

/** The web's actions, by the ids of the shared key table (src/ui/keys/table.ts); the enabled modules' come after them. */
export const ACTIONS: Actions = {
  "diff.down": (n) => moveBy(n),
  "diff.up": (n) => moveBy(-n),
  "diff.first": () => move(cursorSpace.value.at(0)),
  "diff.last": () => move(cursorSpace.value.at(cursorSpace.value.total - 1)),
  "diff.pageDown": () => page(1),
  "diff.pageUp": () => page(-1),
  "diff.nextChange": (n) => repeat(n, 1, (c) => cursorSpace.value.nextChange(c, 1)),
  "diff.prevChange": (n) => repeat(n, -1, (c) => cursorSpace.value.nextChange(c, -1)),
  "diff.nextHunk": (n) => repeat(n, 1, (c) => cursorSpace.value.nextHunk(c, 1)),
  "diff.prevHunk": (n) => repeat(n, -1, (c) => cursorSpace.value.nextHunk(c, -1)),
  "diff.nextFile": far((n) => repeat(n, 1, (c) => cursorSpace.value.nextFile(c, 1))),
  "diff.prevFile": far((n) => repeat(n, -1, (c) => cursorSpace.value.nextFile(c, -1))),
  "diff.nextThread": far(() => toThread(1)),
  "diff.prevThread": far(() => toThread(-1)),
  "diff.toThread": far(backToThread),
  "unread.next": () => unread(1),
  "unread.prev": () => unread(-1),
  "match.next": () => stepHit(1) || true,
  "match.prev": () => stepHit(-1) || true,
  "diff.center": toggle(() => {
    const c = cursor.value;
    if (c && inCode()) linesNav()?.revealCursor(c, "center");
    else if (c) compareNav.current?.revealCursor(c, "center");
  }),
  "diff.open": () => fold(true),
  "diff.close": () => fold(false),
  "diff.toggle": () => fold("toggle"),
  "diff.openAll": () => foldAll(true),
  "diff.closeAll": () => foldAll(false),
  "visual.start": visual,
  "visual.swap": () => {
    const a = visualAnchor.value;
    if (!a) return false;
    visualAnchor.value = cursor.value;
    return move(a);
  },
  "visual.clear": toggle(() => (visualAnchor.value = null)),
  "thread.open": () => openFocusedCompareThread(),
  "comment.start": comment,
  "comment.cancel": toggle(() => linesNav()?.cancelComment()),
  "diff.enter": () => {
    const id = threadUnderCursor();
    if (id === null) return openFocusedCompareThread();
    navigate({ name: "thread", id });
    return true;
  },
  "range.toNext": () => shift("to", 1),
  "range.toPrev": () => shift("to", -1),
  "range.fromNext": () => shift("from", 1),
  "range.fromPrev": () => shift("from", -1),
  "search.diff": () => search("diff"),
  "search.files": () => search("files"),
  "search.word": () => findUsages(),
  "git.commits": toggle(() => (commitPicker.value = !commitPicker.value)),
  "git.link": copyLink,
  "git.blame": () => (onThread() ? blameThread() : blameHere()),
  "changes.back": toggle(() => compareHandle.current?.cancelPending()),
  "commits.close": toggle(() => (commitPicker.value = false)),
  "peek.hide": toggle(() => (peek.value = null)),
  "peek.close": toggle(closePeek),
  "guide.toggle": toggleGuide,

  "guide.next": far((n) => stepGuide(1, n)),
  "guide.prev": far((n) => stepGuide(-1, n)),
  "guide.open": openGuideStep,
  "guide.down": (n) => scrollGuide(n, 1),
  "guide.up": (n) => scrollGuide(n, -1),
  "guide.pageDown": () => scrollGuide("half", 1),
  "guide.pageUp": () => scrollGuide("half", -1),
  "guide.foldToggle": () => foldGuide("toggle"),
  "guide.unfold": () => foldGuide(true),
  "guide.fold": () => foldGuide(false),
  "guide.unfoldAll": () => foldAllGuide(true),
  "guide.foldAll": () => foldAllGuide(false),
  "code.visual": intoCode(visual),
  "code.comment": intoCode(comment),
  "code.leave": toggle(() => leaveCode()),

  "thread.next": () => go(stepThread(ordered.value, currentThreadId.value, 1)),
  "thread.prev": () => go(stepThread(ordered.value, currentThreadId.value, -1)),
  "thread.nextFile": () => go(stepFile(groups.value, currentThreadId.value, 1)),
  "thread.prevFile": () => go(stepFile(groups.value, currentThreadId.value, -1)),
  "timeline.next": () => stepTimeline(1),
  "timeline.prev": () => stepTimeline(-1),
  "code.view": toggle(() => (codeMode.value = codeMode.value === "diff" ? "then" : codeMode.value === "then" ? "now" : "diff")),
  "diff.base": toggle(() => (diffBase.value = diffBase.value === "then" ? "prev" : "then")),
  "msg.next": (n) => stepMsg(1, n),
  "msg.prev": (n) => stepMsg(-1, n),
  "msg.first": () => edgeMsg(false),
  "msg.last": () => edgeMsg(true),
  "conv.pageDown": () => halfPage(1),
  "conv.pageUp": () => halfPage(-1),
  "msg.foldToggle": () => foldMsg(detail.value, "toggle"),
  "msg.unfold": () => foldMsg(detail.value, true),
  "msg.fold": () => foldMsg(detail.value, false),
  "msg.unfoldAll": () => foldAllMsgs(detail.value, true),
  "msg.foldAll": () => foldAllMsgs(detail.value, false),
  "thread.reply": toggle(() => replyAtCursor() || composerFocus.value++),
  "thread.resolve": toggle(() => {
    const d = detail.value;
    if (d && d.thread.status === "open" && !d.thread.draft) void resolveCurrent(null);
  }),
  "thread.reopen": toggle(() => detail.value?.thread.status === "resolved" && void reopenCurrent()),
  "editor.open": toggle(() => void openExternal()),
  "thread.back": toggle(() => navigate(lastCompare.value ? { name: "compare", ...lastCompare.value } : { name: "home" })),
  "thread.code": showThreadCode,
  "review.resolveWith": () => openResolveWithMessage(detail.value),

  "review.changes": toggle(() => void submitReview()),
  "review.approve": toggle(() => void approveReview()),
  submit: reviewAction,

  help: toggle(() => (helpOpen.value = !helpOpen.value)),
  "help.close": toggle(() => (helpOpen.value = false)),
  "jump.back": jumpBack,
  "jump.forward": jumpForward,
  "tab.changes": toggle(() => navigate({ name: "compare", ...defaultCompare() })),
  "tab.drafts": toggle(() => navigate({ name: "drafts" })),
  "diff.wrap": toggle(() => (wrap.value = !wrap.value)),
  refresh: toggle(() => ((banner.value = null), void refreshNow())),
  "filter.files": toggle(() => {
    const input = document.getElementById("file-filter") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }),
  "save.nothing": toggle(() => notify("nothing to save here: text you type is kept as you type")),
  "find.file": toggle(() => (picker.value = "files")),
  "find.version": toggle(() => (picker.value = "versions")),
  "search.keys": toggle(() => (picker.value = "keys")),
  "git.state": toggle(() => (gitOpen.value = !gitOpen.value)),
  "side.threads": toggle(() => (sideTab.value = "threads")),
  "side.files": toggle(() => (sideTab.value = "files")),
  "filter.news": toggle(() => ((sideTab.value = "threads"), setFilters({ newOnly: true }))),
  "diff.layout": toggle(() => (diffStyle.value = diffStyle.value === "split" ? "unified" : "split")),
  "filter.resolved": toggle(() => (showResolved.value = !showResolved.value)),
  "diff.tests": toggle(() => (groupsOpen.value = { ...groupsOpen.value, tests: !groupsOpen.value.tests })),
  "layout.swap": () => swapColumns(onThread() ? "thread" : "compare"),
  "layout.reset": toggle(resetLayout),
};

/** The conditions the table's cascades name. */
export const CONDITIONS: Readonly<Record<string, () => boolean>> = {
  searching,
  visual: () => !!visualAnchor.value,
  commits: () => commitPicker.value,
  peek: () => !!peek.value,
  pending: () => !!pendingLines.value,
  drafts: () => drafts.value.length > 0,
};

const actions = (): Actions => ({ ...ACTIONS, ...moduleActions.value });
const reader: Reader = { ui: "web", has: (id) => id in ACTIONS || id in moduleActions.value };

/** The table with the enabled modules' rows after the core's. */
export const keyRows = (): KeyRow[] => [...KEYS, ...moduleRows()];

/** The rows the web runs: its own and the shared ones it has an action for. */
export const webRows = (): KeyRow[] => keyRows().filter((r) => WEB_SCOPES.has(r.scope) && reads(r, reader));

export const runKeyRow = (row: KeyRow, count = 1): boolean => runRow(row, count, actions(), CONDITIONS);

/** The browser's own keys: the page leaves them to it (Tab moves the focus, PageDown scrolls). */
const BROWSER_KEYS = new Set(["<Tab>", "<S-Tab>", "<PageUp>", "<PageDown>", "<Home>", "<End>", "<Left>", "<Right>", "<BS>", "<Del>", "<Insert>"]);

export function contexts(): Scope[] {
  const r = route.value.name;
  const code: Scope[] = codeFocus.value ? ["code"] : [];
  return r === "compare" ? (guideShown.value ? [...code, "guide", "global"] : ["changes", "global"]) : r === "thread" ? [...code, "thread", "global"] : r === "drafts" ? ["drafts", "global"] : ["global"];
}

const mode = (): Mode => (visualAnchor.value && (contexts().includes("changes") || inCode()) ? "visual" : "normal");
const scopesHere = (): Scope[] => (helpOpen.value ? ["help", ...contexts()] : contexts());

export function nextKeys(prefix: string[]): Next[] {
  return nextAfter(keyRows(), prefix, scopesHere(), reader, mode());
}

const matcher = new KeyMatcher(keyRows, reader, (row) => fire(row));
let count = "";

function reset(): void {
  matcher.reset();
  count = "";
  whichKey.value = null;
}

function fire(row: KeyRow): boolean {
  const n = Math.max(1, Number(count) || 1);
  reset();
  return runKeyRow(row, n);
}

export function handleKey(e: KeyboardEvent): boolean {
  const target = origin(e);
  const token = keyToken(e);
  if (token === null || BROWSER_KEYS.has(token)) return false;
  // the page's Ctrl+letters read the same with Shift held
  const t = token.replace(/^<C-S-([a-z])>$/, "<C-$1>");
  const always = rowFor(keyRows(), t, contexts(), reader, "insert");
  if (always) return fire(always);
  if (typing(target) || picker.value || question.value) return false;
  if (t === "<Esc>" && count && matcher.prefix.length === 0) {
    reset();
    return true;
  }
  if (matcher.prefix.length === 0 && COUNT_SCOPES.has(contexts()[0]!) && /^[0-9]$/.test(t) && (t !== "0" || count)) {
    count += t;
    return true;
  }
  const had = matcher.prefix.length > 0;
  const m = matcher.feed(t, scopesHere(), mode());
  if ("fire" in m) return fire(m.fire);
  if ("none" in m) {
    reset();
    return had ? handleKey(e) : false;
  }
  if (matcher.prefix.length === 0) {
    reset();
    return true;
  }
  whichKey.value = matcher.prefix[0] === "<Space>" ? [...matcher.prefix] : null;
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
