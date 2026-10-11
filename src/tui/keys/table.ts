/**
 * The terminal UI's keys as data: the LazyVim-like subset of web/keys.ts that its columns need. Each row is one action;
 * the app runs it by id. A later branch replaces this with the table shared with the web in src/ui.
 */

/**
 * Where a key works: a column of the Round tab (the list, the code, the conversation, or the thread column that holds
 * both when they share one), the Drafts and Changes tabs, the reply box, a question, the keys list, or everywhere
 * (`global`, after the focused place's own keys).
 */
export type Scope = "list" | "files" | "search" | "code" | "conv" | "thread" | "drafts" | "changes" | "composer" | "choice" | "help" | "global";

export interface KeyRow {
  id: string;
  /** Vim notation: `gg`, `]t`, `<C-d>`, `<Space>ur`. */
  keys: string[];
  scope: Scope;
  desc: string;
  /** What the Space menu says, when `desc` is too long for it. */
  short?: string;
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
  { id: "code.more", keys: ["z"], scope, desc: "all changes or the whole file (with the diff widget)" },
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

  { id: "tab.round", keys: ["<Esc>", "q"], scope: "changes", desc: "back to the round" },

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
