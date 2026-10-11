/**
 * The terminal UI's keys as data: the LazyVim-like subset of web/keys.ts that its columns need. Each row is one action;
 * the app runs it by id. A later branch replaces this with the table shared with the web in src/ui.
 */

/**
 * Where a key works: a column of the Round tab (the list, the code, the conversation, or the thread column that holds
 * both when they share one), the Drafts tab, the Changes tab's files and diff, the reply box, a question, the keys list, or everywhere
 * (`global`, after the focused place's own keys).
 */
export type Scope = "list" | "files" | "search" | "code" | "conv" | "thread" | "drafts" | "changes" | "cfiles" | "composer" | "choice" | "help" | "global";

export interface KeyRow {
  id: string;
  /** Vim notation: `gg`, `]t`, `<C-d>`, `<Space>ur`. */
  keys: string[];
  scope: Scope;
  desc: string;
  /** What the Space menu says, when `desc` is too long for it. */
  short?: string;
  /** Not in the terminal yet: `browser` opens the same place in the browser, `later` is greyed in the menu. */
  off?: "browser" | "later";
  /** Takes a count typed before it: `5j`. */
  count?: true;
}

const inThread = (scope: "code" | "conv" | "thread"): KeyRow[] => [
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
  ...(scope === "code" ? [{ id: "focus.right", keys: ["l"], scope, desc: "the conversation" }] : []),
  { id: "focus.left", keys: ["h", "<Esc>", "q"], scope, desc: scope === "conv" ? "the code" : "the list" },
];

export const KEYS: KeyRow[] = [
  { id: "list.down", keys: ["j", "<Down>", "]t"], scope: "list", desc: "next thread" },
  { id: "list.up", keys: ["k", "<Up>", "[t"], scope: "list", desc: "previous thread" },
  { id: "list.open", keys: ["<CR>", "l", "o"], scope: "list", desc: "into the thread" },
  { id: "list.first", keys: ["gg"], scope: "list", desc: "first thread" },
  { id: "list.last", keys: ["G"], scope: "list", desc: "last thread" },
  { id: "list.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "list", desc: "half a page down" },
  { id: "list.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "list", desc: "half a page up" },
  { id: "list.nextFile", keys: ["J"], scope: "list", desc: "first thread of the next file" },
  { id: "list.prevFile", keys: ["K"], scope: "list", desc: "first thread of the previous file" },
  { id: "unread.next", keys: ["n"], scope: "list", desc: "next unread thread" },
  { id: "unread.prev", keys: ["N"], scope: "list", desc: "previous unread thread" },
  { id: "list.reply", keys: ["r"], scope: "list", desc: "reply to the thread" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "list", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "list", desc: "quit" },

  { id: "files.down", keys: ["j", "<Down>"], scope: "files", desc: "next file" },
  { id: "files.up", keys: ["k", "<Up>"], scope: "files", desc: "previous file" },
  { id: "files.open", keys: ["<CR>", "l", "o"], scope: "files", desc: "into the file's first thread" },
  { id: "files.first", keys: ["gg"], scope: "files", desc: "first file" },
  { id: "files.last", keys: ["G"], scope: "files", desc: "last file" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "files", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "files", desc: "quit" },

  { id: "list.close", keys: ["<Esc>", "h"], scope: "search", desc: "hide the list (narrow screens)" },
  { id: "quit", keys: ["q"], scope: "search", desc: "quit" },

  ...inThread("code"),
  ...inThread("conv"),
  ...inThread("thread"),

  { id: "drafts.down", keys: ["j", "<Down>"], scope: "drafts", desc: "next draft" },
  { id: "drafts.up", keys: ["k", "<Up>"], scope: "drafts", desc: "previous draft" },
  { id: "drafts.open", keys: ["<CR>", "o"], scope: "drafts", desc: "its thread" },
  { id: "drafts.edit", keys: ["e"], scope: "drafts", desc: "edit the draft" },
  { id: "drafts.discard", keys: ["dd"], scope: "drafts", desc: "discard the draft" },
  { id: "drafts.summary", keys: ["c"], scope: "drafts", desc: "the summary for the whole review" },
  { id: "drafts.changes", keys: ["S"], scope: "drafts", desc: "request changes: send the drafts (no drafts: approve)" },
  { id: "drafts.approve", keys: ["A"], scope: "drafts", desc: "approve the latest version (drafts go along as nits)" },
  { id: "drafts.guide", keys: ["g"], scope: "drafts", desc: "ask the agent for a guide to the next version" },
  { id: "tab.round", keys: ["<Esc>", "q"], scope: "drafts", desc: "back to the round" },

  { id: "diff.down", keys: ["j", "<Down>"], scope: "changes", desc: "cursor down (5j: five lines)", count: true },
  { id: "diff.up", keys: ["k", "<Up>"], scope: "changes", desc: "cursor up", count: true },
  { id: "diff.first", keys: ["gg"], scope: "changes", desc: "first line of the diff" },
  { id: "diff.last", keys: ["G"], scope: "changes", desc: "last line of the diff" },
  { id: "diff.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "changes", desc: "half a page down" },
  { id: "diff.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "changes", desc: "half a page up" },
  { id: "diff.nextChange", keys: ["]c"], scope: "changes", desc: "next change", count: true },
  { id: "diff.prevChange", keys: ["[c"], scope: "changes", desc: "previous change", count: true },
  { id: "diff.nextHunk", keys: ["]h"], scope: "changes", desc: "next hunk", count: true },
  { id: "diff.prevHunk", keys: ["[h"], scope: "changes", desc: "previous hunk", count: true },
  { id: "diff.nextFile", keys: ["]b", "L"], scope: "changes", desc: "next file", count: true },
  { id: "diff.prevFile", keys: ["[b", "H"], scope: "changes", desc: "previous file", count: true },
  { id: "diff.nextThread", keys: ["]t"], scope: "changes", desc: "next thread on this diff" },
  { id: "diff.prevThread", keys: ["[t"], scope: "changes", desc: "previous thread on this diff" },
  { id: "unread.next", keys: ["]u", "n"], scope: "changes", desc: "next unread thread" },
  { id: "unread.prev", keys: ["[u", "N"], scope: "changes", desc: "previous unread thread" },
  { id: "diff.center", keys: ["zz"], scope: "changes", desc: "center the cursor line" },
  { id: "diff.open", keys: ["zo"], scope: "changes", desc: "open the file (or the thread's card) under the cursor" },
  { id: "diff.close", keys: ["zc"], scope: "changes", desc: "close the file (or the thread's card) under the cursor" },
  { id: "diff.toggle", keys: ["za"], scope: "changes", desc: "open / close the file (or the thread's card) under the cursor" },
  { id: "diff.openAll", keys: ["zR"], scope: "changes", desc: "open all files" },
  { id: "diff.closeAll", keys: ["zM"], scope: "changes", desc: "close all files" },
  { id: "diff.right", keys: ["zl"], scope: "changes", desc: "scroll right (without wrap)", count: true },
  { id: "diff.left", keys: ["zh"], scope: "changes", desc: "scroll left (without wrap)", count: true },
  { id: "diff.enter", keys: ["<CR>", "o"], scope: "changes", desc: "open the thread under the cursor; on a bar, its lines; on a file's header, open or fold it" },
  { id: "diff.viewed", keys: ["m"], scope: "changes", desc: "mark the file under the cursor viewed, or not: a viewed file folds until it changes" },
  { id: "range.toNext", keys: ["]v"], scope: "changes", desc: "“to” one version later" },
  { id: "range.toPrev", keys: ["[v"], scope: "changes", desc: "“to” one version earlier" },
  { id: "range.fromNext", keys: ["}"], scope: "changes", desc: "“from” one version later" },
  { id: "range.fromPrev", keys: ["{"], scope: "changes", desc: "“from” one version earlier" },
  { id: "range.preset", keys: ["p"], scope: "changes", desc: "next preset: the whole branch, what changed in the last version, since you last looked" },
  { id: "changes.files", keys: ["h"], scope: "changes", desc: "the files" },
  { id: "tab.round", keys: ["<Esc>", "q"], scope: "changes", desc: "back to the round" },

  { id: "cfiles.down", keys: ["j", "<Down>"], scope: "cfiles", desc: "next file, the diff goes along", count: true },
  { id: "cfiles.up", keys: ["k", "<Up>"], scope: "cfiles", desc: "previous file", count: true },
  { id: "cfiles.first", keys: ["gg"], scope: "cfiles", desc: "first file" },
  { id: "cfiles.last", keys: ["G"], scope: "cfiles", desc: "last file" },
  { id: "cfiles.open", keys: ["<CR>", "l", "o"], scope: "cfiles", desc: "into the diff, at the file" },
  { id: "diff.viewed", keys: ["m"], scope: "cfiles", desc: "mark the file viewed, or not" },
  { id: "diff.toggle", keys: ["za"], scope: "cfiles", desc: "open / close the file in the diff" },
  { id: "list.close", keys: ["<Esc>", "h"], scope: "cfiles", desc: "hide the list (narrow screens)" },
  { id: "tab.round", keys: ["q"], scope: "cfiles", desc: "back to the round" },
  { id: "composer.draft", keys: ["<C-s>", "<C-CR>"], scope: "composer", desc: "save as a draft: the agent sees it after you submit the review" },
  { id: "composer.now", keys: ["<C-g>", "<C-S-CR>"], scope: "composer", desc: "send now" },
  { id: "composer.leave", keys: ["<Esc>"], scope: "composer", desc: "leave; the text is kept for next time (jj too)" },

  { id: "choice.down", keys: ["j", "<Down>", "<Tab>"], scope: "choice", desc: "next option" },
  { id: "choice.up", keys: ["k", "<Up>", "<S-Tab>"], scope: "choice", desc: "previous option" },
  { id: "choice.pick", keys: ["<CR>"], scope: "choice", desc: "confirm" },
  { id: "choice.cancel", keys: ["<Esc>", "q"], scope: "choice", desc: "cancel" },

  { id: "help.down", keys: ["j", "<Down>"], scope: "help", desc: "scroll down" },
  { id: "help.up", keys: ["k", "<Up>"], scope: "help", desc: "scroll up" },
  { id: "help.close", keys: ["<Esc>", "?", "q"], scope: "help", desc: "close" },

  { id: "side.files", keys: ["<Space>e"], scope: "global", desc: "the changed files, in the left column", short: "files of the review" },
  { id: "side.threads", keys: ["<Space>st"], scope: "global", desc: "the threads, in the left column", short: "threads" },
  { id: "focus.next", keys: ["<Tab>"], scope: "global", desc: "next column" },
  { id: "focus.prev", keys: ["<S-Tab>"], scope: "global", desc: "previous column" },
  { id: "submit", keys: ["S", "<Space>rs"], scope: "global", desc: "drafts, then S again submits: request changes (approve when there are no drafts)", short: "submit the review" },
  { id: "tab.drafts", keys: ["s", "<Space>rd"], scope: "global", desc: "your drafts" },
  { id: "tab.changes", keys: ["<Space>rv"], scope: "global", desc: "changes since you last looked", short: "changes since last look" },
  { id: "refresh", keys: ["R", "<Space>rr"], scope: "global", desc: "re-read “now” from the working tree", short: "re-read “now”" },
  { id: "filter.resolved", keys: ["<Space>ur"], scope: "global", desc: "show / hide resolved threads", short: "resolved threads" },
  { id: "filter.news", keys: ["<Space>n"], scope: "global", desc: "threads with news" },
  { id: "help", keys: ["?", "<Space>?"], scope: "global", desc: "all keys" },
  { id: "diff.wrap", keys: ["w", "<Space>uw"], scope: "global", desc: "wrap long lines" },
  { id: "diff.layout", keys: ["<Space>ud"], scope: "global", desc: "split / unified diff (auto splits on a wide screen)", short: "split / unified" },
  { id: "diff.tests", keys: ["<Space>ut"], scope: "global", desc: "show / hide test files that only add code", short: "tests with only new code" },

  { id: "find.file", keys: ["<Space><Space>", "<Space>ff"], scope: "global", desc: "find a file of the diff", short: "find a file", off: "later" },
  { id: "find.version", keys: ["<Space>fv"], scope: "global", desc: "find a version: what changed in it, or make it from / to", short: "find a version", off: "later" },
  { id: "search.files", keys: ["<Space>/", "<Space>sg"], scope: "global", desc: "search all files (grep)", short: "search all files", off: "browser" },
  { id: "search.word", keys: ["<Space>sw"], scope: "global", desc: "find the selected word in all files", short: "the word in all files", off: "browser" },
  { id: "search.diff", keys: ["<Space>sd"], scope: "global", desc: "search the diff", off: "later" },
  { id: "search.keys", keys: ["<Space>sk"], scope: "global", desc: "search keys and run one", short: "search keys", off: "later" },
  { id: "git.state", keys: ["<Space>gs"], scope: "global", desc: "git state: pushed or not, staged, not staged, new files", short: "git state", off: "later" },
  { id: "git.commits", keys: ["<Space>gc"], scope: "global", desc: "commits: pick the two ends of the compare", short: "commits", off: "browser" },
  { id: "git.link", keys: ["<Space>gY"], scope: "global", desc: "copy a link to the cursor line", short: "copy a link", off: "later" },
  { id: "git.blame", keys: ["<Space>gb"], scope: "global", desc: "blame: the version, round and threads that brought the cursor line", short: "blame", off: "browser" },
];

/** The names of the `<Space>` groups, as web/keys.ts has them. */
export const LEADER_GROUPS: Record<string, string> = {
  "<Space>f": "find",
  "<Space>s": "search",
  "<Space>u": "ui toggles",
  "<Space>r": "review",
  "<Space>g": "git",
};

export function tokens(keys: string): string[] {
  return keys.match(/<[^>]+>|./g) ?? [];
}

/** How a key looks in the footer and the help: `<C-d>` as `Ctrl+D`, `<CR>` as `Enter`, `]t` as `] t`. */
export function keyLabel(keys: string): string {
  const named: Record<string, string> = {
    "<CR>": "Enter", "<Space>": "Space", "<Esc>": "Esc", "<Down>": "↓", "<Up>": "↑", "<Tab>": "Tab", "<S-Tab>": "Shift+Tab",
    "<lt>": "<", "<BS>": "Backspace", "<PageDown>": "PgDn", "<PageUp>": "PgUp",
  };
  return tokens(keys)
    .map((t) => {
      if (named[t]) return named[t];
      const m = /^<C-(S-)?(.+)>$/.exec(t);
      if (m) return `Ctrl+${m[1] ? "Shift+" : ""}${m[2] === "CR" ? "Enter" : m[2]!.toUpperCase()}`;
      return t.replace(/^<(.*)>$/, "$1");
    })
    .join(" ");
}
