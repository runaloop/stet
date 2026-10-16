/**
 * The keys of both UIs as data. Each row binds keys in one place to one action id; each UI registers the actions it
 * runs by id and reads only the rows it has an action for, so a row the terminal does not run yet stays out of its
 * menus and help until it registers the id.
 */

/**
 * Where a key works. Both UIs: everywhere, the diff of the Changes page, the Drafts page, the reply box, a question,
 * a finder (files, versions, keys), the search box and the list of keys. The web: the Guide tab, a thread's page, the
 * code of a thread or of the guide once it has the focus (V or i), the blame popover. The terminal: the columns of the
 * Round tab and the files of the Changes tab.
 */
export type Scope =
  | "global"
  | "changes"
  | "drafts"
  | "composer"
  | "choice"
  | "picker"
  | "search"
  | "help"
  | "guide"
  | "thread"
  | "code"
  | "blame"
  | "round.list"
  | "round.files"
  | "round.search"
  | "round.code"
  | "round.conv"
  | "round.thread"
  | "changes.files";

/** `visual`: lines are being selected (V); a row without `modes` works in normal mode only. */
export type Mode = "normal" | "visual" | "insert";

/** A step tried before the row's own action: it runs when its condition holds (a UI's own test, by name) and the UI has it. */
export interface Step {
  if?: string;
  run: string;
}

export interface KeyRow {
  id: string;
  /** Vim notation, one spelling: `gg`, `]t`, `<C-d>`, `<C-S-CR>`, `<Space>ur`. */
  keys: string[];
  scope: Scope;
  desc: string;
  /** What the terminal's Space menu says, when `desc` is too long for it. */
  short?: string;
  modes?: Mode[];
  /** Takes a count typed before it: `5j`. */
  count?: true;
  /**
   * Conditions as data: steps tried in order before `id`; the first that runs and does not answer `false` is what the
   * key did. `n` is the next search match while a search has hits, else the next unread thread.
   */
  before?: Step[];
  /** Read by one UI only, where the two differ in the same place. */
  ui?: "web" | "tui";
  /** Keys only a terminal reads, standing in for this row's keys a terminal may never deliver (`<Tab>` for `<C-i>`). */
  fallback?: string[];
}

/** The names of the `<Space>` groups in which-key. */
export const LEADER_GROUPS: Record<string, string> = {
  "<Space>f": "find",
  "<Space>s": "search",
  "<Space>u": "ui toggles",
  "<Space>r": "review",
  "<Space>g": "git",
  "<Space>w": "columns",
};

/** A key that starts a longer binding fires on its own after this long without the next key. */
export const PREFIX_TIMEOUT_MS = 600;

/** The places where digits typed first are a count: `5j`, `3]c`. */
export const COUNT_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["changes", "guide", "code", "changes.files"]);

const V: Mode[] = ["normal", "visual"];

const changes: KeyRow[] = [
  { id: "diff.down", keys: ["j", "<Down>"], scope: "changes", modes: V, count: true, desc: "cursor down (5j: five lines)" },
  { id: "diff.up", keys: ["k", "<Up>"], scope: "changes", modes: V, count: true, desc: "cursor up" },
  { id: "diff.first", keys: ["gg"], scope: "changes", modes: V, desc: "first line of the diff" },
  { id: "diff.last", keys: ["G"], scope: "changes", modes: V, desc: "last line of the diff" },
  { id: "diff.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "changes", modes: V, desc: "half a page down" },
  { id: "diff.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "changes", modes: V, desc: "half a page up" },
  { id: "diff.nextChange", keys: ["]c"], scope: "changes", modes: V, count: true, desc: "next change" },
  { id: "diff.prevChange", keys: ["[c"], scope: "changes", modes: V, count: true, desc: "previous change" },
  { id: "diff.nextHunk", keys: ["]h"], scope: "changes", modes: V, count: true, desc: "next hunk" },
  { id: "diff.prevHunk", keys: ["[h"], scope: "changes", modes: V, count: true, desc: "previous hunk" },
  { id: "diff.nextFile", keys: ["]b", "L"], scope: "changes", count: true, desc: "next file" },
  { id: "diff.prevFile", keys: ["[b", "H"], scope: "changes", count: true, desc: "previous file" },
  { id: "diff.nextThread", keys: ["]t"], scope: "changes", desc: "next thread on this diff" },
  { id: "diff.prevThread", keys: ["[t"], scope: "changes", desc: "previous thread on this diff" },
  { id: "diff.toThread", keys: ["gt"], scope: "changes", desc: "back to the thread last opened or stepped to, marked in the code" },
  { id: "unread.next", keys: ["]u"], scope: "changes", desc: "next unread thread" },
  { id: "unread.prev", keys: ["[u"], scope: "changes", desc: "previous unread thread" },
  { id: "unread.next", keys: ["n"], scope: "changes", before: [{ if: "searching", run: "match.next" }], desc: "next search match (no search: next unread thread)" },
  { id: "unread.prev", keys: ["N"], scope: "changes", before: [{ if: "searching", run: "match.prev" }], desc: "previous search match (no search: previous unread)" },
  { id: "diff.center", keys: ["zz"], scope: "changes", desc: "center the cursor line" },
  { id: "diff.open", keys: ["zo"], scope: "changes", ui: "web", desc: "open the file under the cursor" },
  { id: "diff.close", keys: ["zc"], scope: "changes", ui: "web", desc: "close the file under the cursor" },
  { id: "diff.toggle", keys: ["za"], scope: "changes", ui: "web", desc: "open / close the file under the cursor" },
  { id: "diff.open", keys: ["zo"], scope: "changes", ui: "tui", desc: "open the file (or the thread's card) under the cursor" },
  { id: "diff.close", keys: ["zc"], scope: "changes", ui: "tui", desc: "close the file (or the thread's card) under the cursor" },
  { id: "diff.toggle", keys: ["za"], scope: "changes", ui: "tui", desc: "open / close the file (or the thread's card) under the cursor" },
  { id: "diff.openAll", keys: ["zR"], scope: "changes", desc: "open all files" },
  { id: "diff.closeAll", keys: ["zM"], scope: "changes", desc: "close all files" },
  { id: "diff.right", keys: ["zl"], scope: "changes", count: true, desc: "scroll right (without wrap)" },
  { id: "diff.left", keys: ["zh"], scope: "changes", count: true, desc: "scroll left (without wrap)" },
  { id: "visual.start", keys: ["V", "v"], scope: "changes", desc: "select lines (visual mode)" },
  { id: "thread.open", keys: ["o"], scope: "changes", modes: V, ui: "web", before: [{ if: "visual", run: "visual.swap" }], desc: "other end of the selection" },
  { id: "comment.start", keys: ["i", "a", "c"], scope: "changes", modes: V, desc: "comment on the cursor line or the selection" },
  { id: "comment.start", keys: ["gc"], scope: "changes", modes: V, desc: "comment on the selection" },
  { id: "comment.start", keys: ["gcc"], scope: "changes", desc: "comment on the cursor line" },
  { id: "diff.enter", keys: ["<CR>"], scope: "changes", ui: "web", desc: "open the thread under the cursor" },
  { id: "diff.enter", keys: ["<CR>", "o"], scope: "changes", ui: "tui", desc: "open the thread under the cursor; on a bar, its lines; on a file's header, open or fold it" },
  { id: "diff.viewed", keys: ["m"], scope: "changes", desc: "mark the file under the cursor viewed, or not: a viewed file folds until it changes" },
  { id: "range.toNext", keys: ["]v"], scope: "changes", desc: "“to” one version later" },
  { id: "range.toPrev", keys: ["[v"], scope: "changes", desc: "“to” one version earlier" },
  { id: "range.fromNext", keys: ["}"], scope: "changes", desc: "“from” one version later" },
  { id: "range.fromPrev", keys: ["{"], scope: "changes", desc: "“from” one version earlier" },
  { id: "range.preset", keys: ["p"], scope: "changes", desc: "next preset: the whole branch, what changed in the last version, since you last looked" },
  { id: "search.diff", keys: ["/", "<Space>sd"], scope: "changes", desc: "search the diff" },
  { id: "search.diff", keys: ["<C-f>"], scope: "changes", modes: ["normal", "visual", "insert"], ui: "web", desc: "search the diff" },
  { id: "search.word", keys: ["*"], scope: "changes", desc: "find where the selected word is used (all files)" },
  { id: "match.next", keys: ["<F3>"], scope: "changes", desc: "next search match" },
  { id: "match.prev", keys: ["<S-F3>"], scope: "changes", fallback: ["N"], desc: "previous search match" },
  { id: "git.commits", keys: ["<Space>gc"], scope: "changes", ui: "web", desc: "commits: pick the two ends of the compare" },
  { id: "git.link", keys: ["<Space>gY"], scope: "changes", modes: V, ui: "web", desc: "copy a link to the cursor line or the selection" },
  { id: "git.blame", keys: ["<Space>gb"], scope: "changes", modes: V, ui: "web", desc: "blame: the version, round and threads that brought the cursor line or the selection" },
  {
    id: "changes.back",
    keys: ["<Esc>"],
    scope: "changes",
    modes: V,
    ui: "web",
    before: [
      { if: "commits", run: "commits.close" },
      { if: "peek", run: "peek.hide" },
      { if: "visual", run: "visual.clear" },
    ],
    desc: "close the commits or the preview, the selection, then the comment box",
  },
  { id: "changes.back", keys: ["<Esc>"], scope: "changes", modes: V, ui: "tui", before: [{ if: "visual", run: "visual.clear" }], desc: "back to the round" },
  { id: "tab.round", keys: ["q"], scope: "changes", desc: "back to the round" },
  { id: "changes.files", keys: ["h"], scope: "changes", desc: "the files" },
  { id: "guide.toggle", keys: ["<Space>ug"], scope: "changes", modes: V, desc: "the agent's guide to the version on the right, or back to the diff (experimental)" },
  { id: "find.file", keys: ["<Space><Space>", "<Space>ff"], scope: "changes", ui: "web", desc: "find a file of the diff" },
  { id: "search.files", keys: ["<Space>/"], scope: "changes", ui: "web", desc: "search all files" },
  { id: "search.files", keys: ["<Space>sg"], scope: "changes", ui: "web", desc: "search all files (grep)" },
  { id: "search.word", keys: ["<Space>sw"], scope: "changes", ui: "web", desc: "find the selected word in all files" },
  { id: "side.threads", keys: ["<Space>st"], scope: "changes", ui: "web", desc: "threads" },
  { id: "side.files", keys: ["<Space>e"], scope: "changes", ui: "web", desc: "files of the diff" },
  { id: "diff.tests", keys: ["<Space>ut"], scope: "changes", desc: "show / hide test files that only add code", short: "tests with only new code" },
  { id: "layout.swap", keys: ["<Space>ul"], scope: "changes", desc: "side panel left / right of the diff" },
];

const guide: KeyRow[] = [
  { id: "guide.toggle", keys: ["<Space>ug", "<Esc>"], scope: "guide", desc: "back to the diff" },
  { id: "search.diff", keys: ["<C-f>"], scope: "guide", modes: ["normal", "visual", "insert"], desc: "search the diff" },
  { id: "guide.next", keys: ["}"], scope: "guide", count: true, desc: "next step (3}: three steps)" },
  { id: "guide.prev", keys: ["{"], scope: "guide", count: true, desc: "previous step" },
  { id: "guide.open", keys: ["<CR>"], scope: "guide", desc: "open the step in the diff, at its first lines" },
  { id: "guide.down", keys: ["j"], scope: "guide", count: true, desc: "scroll down" },
  { id: "guide.up", keys: ["k"], scope: "guide", count: true, desc: "scroll up" },
  { id: "guide.pageDown", keys: ["<C-d>"], scope: "guide", desc: "half a page down" },
  { id: "guide.pageUp", keys: ["<C-u>"], scope: "guide", desc: "half a page up" },
  { id: "guide.foldToggle", keys: ["za"], scope: "guide", desc: "fold / unfold the file diff in view (a long one starts folded)" },
  { id: "guide.unfold", keys: ["zo"], scope: "guide", desc: "unfold the file diff in view" },
  { id: "guide.fold", keys: ["zc"], scope: "guide", desc: "fold the file diff in view" },
  { id: "guide.unfoldAll", keys: ["zR"], scope: "guide", desc: "unfold every file diff of the guide" },
  { id: "guide.foldAll", keys: ["zM"], scope: "guide", desc: "fold every file diff of the guide" },
  { id: "code.visual", keys: ["V"], scope: "guide", desc: "into the code: select lines from the cursor, at first on the step's lines in view" },
  { id: "code.comment", keys: ["i", "a", "c"], scope: "guide", desc: "into the code: comment on the cursor line, at first the first line of the step in view" },
  { id: "code.comment", keys: ["gcc"], scope: "guide", desc: "into the code: comment on the cursor line" },
];

const thread: KeyRow[] = [
  { id: "thread.next", keys: ["j"], scope: "thread", desc: "next thread" },
  { id: "thread.prev", keys: ["k"], scope: "thread", desc: "previous thread" },
  { id: "thread.nextFile", keys: ["J"], scope: "thread", desc: "first thread of the next file" },
  { id: "thread.prevFile", keys: ["K"], scope: "thread", desc: "first thread of the previous file" },
  { id: "unread.next", keys: ["n"], scope: "thread", desc: "next unread thread" },
  { id: "unread.prev", keys: ["N"], scope: "thread", desc: "previous unread thread" },
  { id: "timeline.next", keys: ["]"], scope: "thread", desc: "next timeline step" },
  { id: "timeline.prev", keys: ["["], scope: "thread", desc: "previous timeline step" },
  { id: "search.files", keys: ["/"], scope: "thread", desc: "search all files at the step shown" },
  { id: "search.files", keys: ["<C-f>"], scope: "thread", modes: ["normal", "visual", "insert"], desc: "search all files at the step shown" },
  { id: "search.word", keys: ["*"], scope: "thread", desc: "find where the selected word is used, at the step shown" },
  { id: "code.view", keys: ["t"], scope: "thread", desc: "code: diff → then → at step" },
  { id: "diff.base", keys: ["p"], scope: "thread", desc: "diff against then / the previous step" },
  { id: "msg.next", keys: ["}"], scope: "thread", desc: "next message (3}: three messages)" },
  { id: "msg.prev", keys: ["{"], scope: "thread", desc: "previous message" },
  { id: "msg.first", keys: ["gg"], scope: "thread", desc: "first message" },
  { id: "msg.last", keys: ["G"], scope: "thread", desc: "last message and the reply box" },
  { id: "conv.pageDown", keys: ["<C-d>"], scope: "thread", desc: "half a page down the conversation" },
  { id: "conv.pageUp", keys: ["<C-u>"], scope: "thread", desc: "half a page up the conversation" },
  { id: "msg.foldToggle", keys: ["za"], scope: "thread", desc: "fold / unfold the long message under the cursor" },
  { id: "msg.unfold", keys: ["zo"], scope: "thread", desc: "unfold the message under the cursor" },
  { id: "msg.fold", keys: ["zc"], scope: "thread", desc: "fold the message under the cursor" },
  { id: "msg.unfoldAll", keys: ["zR"], scope: "thread", desc: "unfold all messages" },
  { id: "msg.foldAll", keys: ["zM"], scope: "thread", desc: "fold all long messages" },
  { id: "thread.reply", keys: ["r"], scope: "thread", desc: "reply to the message under the cursor (moved with { } or a click), else to the thread" },
  { id: "thread.resolve", keys: ["x"], scope: "thread", desc: "resolve (a reason can be picked afterwards)" },
  { id: "thread.reopen", keys: ["X"], scope: "thread", desc: "reopen" },
  { id: "editor.open", keys: ["e"], scope: "thread", desc: "open in the editor (STET_EDITOR)" },
  { id: "thread.back", keys: ["<Esc>"], scope: "thread", before: [{ if: "peek", run: "peek.close" }], desc: "close the preview, then back to the changes, at this thread" },
  { id: "thread.code", keys: ["gt"], scope: "thread", desc: "back to the thread's lines in the code, marked" },
  { id: "code.visual", keys: ["V"], scope: "thread", desc: "into the code: select lines from the cursor, at first on the thread's lines" },
  { id: "code.comment", keys: ["i", "a", "c"], scope: "thread", desc: "into the code: comment on the cursor line, at first the thread's first line" },
  { id: "code.comment", keys: ["gcc"], scope: "thread", desc: "into the code: comment on the cursor line" },
  { id: "git.blame", keys: ["<Space>gb"], scope: "thread", desc: "blame: the version, round and threads that brought the thread's lines in the code shown" },
  { id: "find.file", keys: ["<Space><Space>", "<Space>ff"], scope: "thread", desc: "find a file of the branch's diff and open it on the Changes page" },
  { id: "search.files", keys: ["<Space>/", "<Space>sg"], scope: "thread", desc: "search all files at the step shown" },
  { id: "search.word", keys: ["<Space>sw"], scope: "thread", desc: "find the selected word, at the step shown" },
  { id: "side.threads", keys: ["<Space>st"], scope: "thread", desc: "threads" },
  { id: "side.files", keys: ["<Space>e"], scope: "thread", desc: "files of the last diff" },
  { id: "layout.swap", keys: ["<Space>ul"], scope: "thread", desc: "conversation left / right of the code" },
  { id: "review.resolveWith", keys: ["<Space>rx"], scope: "thread", desc: "resolve with a message: the agent does as it says (a draft, sent with the review)" },
];

const code: KeyRow[] = [
  { id: "diff.down", keys: ["j", "<Down>"], scope: "code", modes: V, count: true, desc: "cursor down (5j: five lines)" },
  { id: "diff.up", keys: ["k", "<Up>"], scope: "code", modes: V, count: true, desc: "cursor up" },
  { id: "diff.first", keys: ["gg"], scope: "code", modes: V, desc: "first line of the code shown" },
  { id: "diff.last", keys: ["G"], scope: "code", modes: V, desc: "last line of the code shown" },
  { id: "diff.pageDown", keys: ["<C-d>"], scope: "code", modes: V, desc: "half a page down" },
  { id: "diff.pageUp", keys: ["<C-u>"], scope: "code", modes: V, desc: "half a page up" },
  { id: "diff.nextChange", keys: ["]c"], scope: "code", modes: V, count: true, desc: "next change" },
  { id: "diff.prevChange", keys: ["[c"], scope: "code", modes: V, count: true, desc: "previous change" },
  { id: "diff.nextHunk", keys: ["]h"], scope: "code", modes: V, count: true, desc: "next hunk" },
  { id: "diff.prevHunk", keys: ["[h"], scope: "code", modes: V, count: true, desc: "previous hunk" },
  { id: "diff.center", keys: ["zz"], scope: "code", desc: "center the cursor line" },
  { id: "visual.start", keys: ["V", "v"], scope: "code", desc: "select lines (visual mode)" },
  { id: "visual.swap", keys: ["o"], scope: "code", modes: V, desc: "other end of the selection" },
  { id: "comment.start", keys: ["i", "a", "c"], scope: "code", modes: V, desc: "comment on the cursor line or the selection: a new thread, or quote it in the reply" },
  { id: "comment.start", keys: ["gc"], scope: "code", modes: V, desc: "comment on the selection" },
  { id: "comment.start", keys: ["gcc"], scope: "code", desc: "comment on the cursor line" },
  { id: "git.link", keys: ["<Space>gY"], scope: "code", modes: V, desc: "copy a link to the cursor line or the selection, on the Changes page of the versions shown" },
  {
    id: "code.leave",
    keys: ["<Esc>"],
    scope: "code",
    modes: V,
    before: [
      { if: "peek", run: "peek.close" },
      { if: "visual", run: "visual.clear" },
      { if: "pending", run: "comment.cancel" },
    ],
    desc: "close the preview, the selection, the comment box, then leave the code: the page's keys again",
  },
];

const drafts: KeyRow[] = [
  { id: "review.approve", keys: ["S"], scope: "drafts", before: [{ if: "drafts", run: "review.changes" }], desc: "request changes: send the drafts (no drafts: approve)" },
  { id: "review.approve", keys: ["<Space>rs"], scope: "drafts", before: [{ if: "drafts", run: "review.changes" }], desc: "submit the review from the drafts page (approve when there are no drafts)", short: "submit the review" },
  { id: "drafts.down", keys: ["j", "<Down>"], scope: "drafts", desc: "next draft" },
  { id: "drafts.up", keys: ["k", "<Up>"], scope: "drafts", desc: "previous draft" },
  { id: "drafts.open", keys: ["<CR>", "o"], scope: "drafts", desc: "its thread" },
  { id: "drafts.edit", keys: ["e"], scope: "drafts", desc: "edit the draft" },
  { id: "drafts.discard", keys: ["dd"], scope: "drafts", desc: "discard the draft" },
  { id: "drafts.summary", keys: ["c"], scope: "drafts", desc: "the summary for the whole review" },
  { id: "review.approve", keys: ["A"], scope: "drafts", desc: "approve the latest version (drafts go along as nits)" },
  { id: "drafts.guide", keys: ["g"], scope: "drafts", desc: "ask the agent for a guide to the next version" },
  { id: "tab.round", keys: ["<Esc>", "q"], scope: "drafts", desc: "back to the round" },
];

const global: KeyRow[] = [
  { id: "help", keys: ["?", "<Space>?"], scope: "global", desc: "all keys" },
  { id: "jump.back", keys: ["<C-o>"], scope: "global", desc: "jump back (page, search hit, file jump)" },
  { id: "jump.forward", keys: ["<C-i>"], scope: "global", fallback: ["<Tab>"], desc: "jump forward" },
  { id: "tab.changes", keys: ["v", "<Space>rv"], scope: "global", desc: "changes since you last looked", short: "changes since last look" },
  { id: "tab.drafts", keys: ["s"], scope: "global", desc: "your drafts" },
  { id: "tab.drafts", keys: ["<Space>rd"], scope: "global", desc: "drafts" },
  { id: "submit", keys: ["S"], scope: "global", desc: "drafts, then S again submits (approves when there are no drafts)" },
  { id: "submit", keys: ["<Space>rs"], scope: "global", desc: "submit the review from the drafts page (approve when there are no drafts)", short: "submit the review" },
  { id: "diff.wrap", keys: ["w", "<Space>uw"], scope: "global", desc: "wrap long lines" },
  { id: "refresh", keys: ["R"], scope: "global", desc: "re-read “now” from the working tree" },
  { id: "refresh", keys: ["<Space>rr"], scope: "global", desc: "re-read “now”" },
  { id: "filter.files", keys: ["/"], scope: "global", desc: "filter threads by file" },
  { id: "help.close", keys: ["<Esc>"], scope: "global", ui: "web", desc: "close" },
  { id: "save.nothing", keys: ["<C-s>"], scope: "global", ui: "web", desc: "nothing to save here: text you type is kept as you type" },
  { id: "git.state", keys: ["<Space>gs"], scope: "global", desc: "git state: pushed or not, staged, not staged, new files", short: "git state" },
  { id: "find.version", keys: ["<Space>fv"], scope: "global", desc: "find a version: what changed in it, or make it from / to", short: "find a version" },
  { id: "search.keys", keys: ["<Space>sk"], scope: "global", desc: "search keys and run one", short: "search keys" },
  { id: "filter.news", keys: ["<Space>n"], scope: "global", desc: "only threads with news", short: "threads with news" },
  { id: "diff.layout", keys: ["<Space>ud"], scope: "global", desc: "split / unified diff", short: "split / unified" },
  { id: "filter.resolved", keys: ["<Space>ur"], scope: "global", desc: "show / hide resolved threads", short: "resolved threads" },
  { id: "layout.reset", keys: ["<Space>uL"], scope: "global", desc: "reset the layout of this page: column order and widths" },
  // The terminal has no page per place: these work wherever its columns are.
  { id: "side.files", keys: ["<Space>e"], scope: "global", ui: "tui", desc: "the changed files, in the left column", short: "files of the review" },
  { id: "side.threads", keys: ["<Space>st"], scope: "global", ui: "tui", desc: "the threads, in the left column", short: "threads" },
  { id: "focus.next", keys: ["<Tab>", "<C-w>w", "<Space>ww"], scope: "global", desc: "next column", short: "next column" },
  { id: "focus.prev", keys: ["<S-Tab>", "<C-w>W", "<Space>wW"], scope: "global", desc: "previous column", short: "previous column" },
  { id: "diff.tests", keys: ["<Space>ut"], scope: "global", ui: "tui", desc: "show / hide test files that only add code", short: "tests with only new code" },
  { id: "find.file", keys: ["<Space><Space>", "<Space>ff"], scope: "global", ui: "tui", desc: "find a file of the diff", short: "find a file" },
  { id: "search.files", keys: ["<Space>/", "<Space>sg"], scope: "global", ui: "tui", desc: "search all files (grep)", short: "search all files" },
  { id: "search.word", keys: ["<Space>sw"], scope: "global", ui: "tui", desc: "find the selected word in all files", short: "the word in all files" },
  { id: "search.diff", keys: ["<Space>sd"], scope: "global", ui: "tui", desc: "search the diff" },
  { id: "git.commits", keys: ["<Space>gc"], scope: "global", ui: "tui", desc: "commits: pick the two ends of the compare", short: "commits" },
  { id: "git.link", keys: ["<Space>gY"], scope: "global", ui: "tui", desc: "copy a link to the cursor line", short: "copy a link" },
  { id: "git.blame", keys: ["<Space>gb"], scope: "global", ui: "tui", desc: "blame: the version, round and threads that brought the cursor line", short: "blame" },
];

/** The text fields and boxes: Enter with Shift or Ctrl is lost in many terminals, so each has a key that is not. */
const boxes: KeyRow[] = [
  { id: "composer.draft", keys: ["<C-s>", "<C-CR>"], scope: "composer", desc: "save as a draft: the agent sees it after you submit the review" },
  { id: "composer.now", keys: ["<C-S-CR>"], scope: "composer", fallback: ["<C-g>"], desc: "send now" },
  { id: "composer.leave", keys: ["<Esc>"], scope: "composer", desc: "leave; the text is kept for next time (jj too)" },

  { id: "choice.down", keys: ["j", "<Down>", "<Tab>"], scope: "choice", desc: "next option" },
  { id: "choice.up", keys: ["k", "<Up>", "<S-Tab>"], scope: "choice", desc: "previous option" },
  { id: "choice.pick", keys: ["<CR>", "<Space>"], scope: "choice", desc: "confirm" },
  { id: "choice.cancel", keys: ["<Esc>", "q"], scope: "choice", desc: "cancel" },

  { id: "picker.down", keys: ["<Down>", "<C-j>", "<C-n>"], scope: "picker", desc: "next" },
  { id: "picker.up", keys: ["<Up>", "<C-k>", "<C-p>"], scope: "picker", desc: "previous" },
  { id: "picker.pick", keys: ["<CR>"], scope: "picker", desc: "choose" },
  { id: "picker.from", keys: ["<S-CR>"], scope: "picker", fallback: ["<C-f>", "<C-r>"], desc: "make the version “from”" },
  { id: "picker.to", keys: ["<C-CR>"], scope: "picker", fallback: ["<C-t>"], desc: "make the version “to”" },
  { id: "picker.close", keys: ["<Esc>"], scope: "picker", desc: "close" },

  { id: "search.next", keys: ["<CR>"], scope: "search", fallback: ["<Down>", "<C-n>"], desc: "next match" },
  { id: "search.prev", keys: ["<S-CR>"], scope: "search", fallback: ["<Up>", "<C-p>"], desc: "previous match" },
  { id: "search.leave", keys: ["<Esc>"], scope: "search", before: [{ if: "peek", run: "peek.hide" }], desc: "close the preview, then leave the box" },

  { id: "help.down", keys: ["j", "<Down>"], scope: "help", desc: "scroll down" },
  { id: "help.up", keys: ["k", "<Up>"], scope: "help", desc: "scroll up" },
  { id: "help.close", keys: ["<Esc>", "?", "q"], scope: "help", desc: "close" },

  { id: "blame.down", keys: ["j", "<Down>"], scope: "blame", desc: "next version or thread" },
  { id: "blame.up", keys: ["k", "<Up>"], scope: "blame", desc: "previous version or thread" },
  { id: "blame.open", keys: ["<CR>"], scope: "blame", desc: "open it" },
  { id: "blame.close", keys: ["<Esc>"], scope: "blame", desc: "close" },
];

/** The thread column of the terminal's Round tab: with three columns the code and the conversation are two of them. */
const inThread = (scope: "round.code" | "round.conv" | "round.thread"): KeyRow[] => [
  { id: "scroll.down", keys: ["j", "<Down>", "<C-e>"], scope, desc: "scroll down a line" },
  { id: "scroll.up", keys: ["k", "<Up>", "<C-y>"], scope, desc: "scroll up a line" },
  { id: "scroll.pageDown", keys: ["<C-d>", "<PageDown>"], scope, desc: "half a page down" },
  { id: "scroll.pageUp", keys: ["<C-u>", "<PageUp>"], scope, desc: "half a page up" },
  { id: "scroll.top", keys: ["gg"], scope, desc: "top" },
  { id: "scroll.bottom", keys: ["G"], scope, desc: "bottom" },
  { id: "thread.next", keys: ["]t"], scope, desc: "next thread" },
  { id: "thread.prev", keys: ["[t"], scope, desc: "previous thread" },
  { id: "thread.nextFile", keys: ["J"], scope, desc: "first thread of the next file" },
  { id: "thread.prevFile", keys: ["K"], scope, desc: "first thread of the previous file" },
  { id: "unread.next", keys: ["n"], scope, desc: "next unread thread" },
  { id: "unread.prev", keys: ["N"], scope, desc: "previous unread thread" },
  { id: "thread.reply", keys: ["r"], scope, desc: "reply to the thread" },
  { id: "thread.resolve", keys: ["x"], scope, desc: "resolve" },
  { id: "thread.reopen", keys: ["X"], scope, desc: "reopen" },
  { id: "code.view", keys: ["t"], scope, desc: "the code: diff / then / at the last step" },
  { id: "code.more", keys: ["z"], scope, desc: "how much of the file: around the thread, all changes, the whole file" },
  { id: "msg.prev", keys: ["{"], scope, desc: "previous message" },
  { id: "msg.next", keys: ["}"], scope, desc: "next message" },
  ...(scope === "round.code" ? [{ id: "focus.right", keys: ["l"], scope, desc: "the conversation" }] : []),
  { id: "focus.left", keys: ["h", "<Esc>", "q"], scope, desc: scope === "round.conv" ? "the code" : "the list" },
];

const round: KeyRow[] = [
  { id: "list.down", keys: ["j", "<Down>", "]t"], scope: "round.list", desc: "next thread" },
  { id: "list.up", keys: ["k", "<Up>", "[t"], scope: "round.list", desc: "previous thread" },
  { id: "list.open", keys: ["<CR>", "l", "o"], scope: "round.list", desc: "into the thread" },
  { id: "list.first", keys: ["gg"], scope: "round.list", desc: "first thread" },
  { id: "list.last", keys: ["G"], scope: "round.list", desc: "last thread" },
  { id: "list.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "round.list", desc: "half a page down" },
  { id: "list.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "round.list", desc: "half a page up" },
  { id: "thread.nextFile", keys: ["J"], scope: "round.list", desc: "first thread of the next file" },
  { id: "thread.prevFile", keys: ["K"], scope: "round.list", desc: "first thread of the previous file" },
  { id: "unread.next", keys: ["n"], scope: "round.list", desc: "next unread thread" },
  { id: "unread.prev", keys: ["N"], scope: "round.list", desc: "previous unread thread" },
  { id: "list.reply", keys: ["r"], scope: "round.list", desc: "reply to the thread" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "round.list", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "round.list", desc: "quit" },

  { id: "files.down", keys: ["j", "<Down>"], scope: "round.files", desc: "next file" },
  { id: "files.up", keys: ["k", "<Up>"], scope: "round.files", desc: "previous file" },
  { id: "files.open", keys: ["<CR>", "l", "o"], scope: "round.files", desc: "into the file's first thread" },
  { id: "files.first", keys: ["gg"], scope: "round.files", desc: "first file" },
  { id: "files.last", keys: ["G"], scope: "round.files", desc: "last file" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "round.files", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "round.files", desc: "quit" },

  { id: "list.close", keys: ["<Esc>", "h"], scope: "round.search", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "round.search", desc: "quit" },

  ...inThread("round.code"),
  ...inThread("round.conv"),
  ...inThread("round.thread"),

  { id: "cfiles.down", keys: ["j", "<Down>"], scope: "changes.files", count: true, desc: "next file, the diff goes along" },
  { id: "cfiles.up", keys: ["k", "<Up>"], scope: "changes.files", count: true, desc: "previous file" },
  { id: "cfiles.first", keys: ["gg"], scope: "changes.files", desc: "first file" },
  { id: "cfiles.last", keys: ["G"], scope: "changes.files", desc: "last file" },
  { id: "cfiles.open", keys: ["<CR>", "l", "o"], scope: "changes.files", desc: "into the diff, at the file" },
  { id: "diff.viewed", keys: ["m"], scope: "changes.files", desc: "mark the file viewed, or not" },
  { id: "diff.toggle", keys: ["za"], scope: "changes.files", desc: "open / close the file in the diff" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "changes.files", desc: "hide the list (narrow screens)" },
  { id: "tab.round", keys: ["q"], scope: "changes.files", desc: "back to the round" },
];

export const KEYS: readonly KeyRow[] = [...changes, ...guide, ...thread, ...code, ...drafts, ...boxes, ...round, ...global];
