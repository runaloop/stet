/**
 * The terminal UI's keys as data: the LazyVim-like subset of web/keys.ts that its pages need. Each row is one action;
 * the app runs it by id. A later branch replaces this with the table shared with the web in src/ui.
 */

/** Where a key works: a page, the composer, a dialog, or every page (`global`, after the page's own keys). */
export type Scope = "threads" | "thread" | "drafts" | "composer" | "choice" | "help" | "global";

export interface KeyRow {
  id: string;
  /** Vim notation: `gg`, `]t`, `<C-d>`, `<Space>ur`. */
  keys: string[];
  scope: Scope;
  desc: string;
  /** Shown in the footer, in table order. */
  hint?: string;
}

export const KEYS: KeyRow[] = [
  { id: "list.down", keys: ["j", "<Down>"], scope: "threads", desc: "next thread", hint: "j/k move" },
  { id: "list.up", keys: ["k", "<Up>"], scope: "threads", desc: "previous thread" },
  { id: "list.open", keys: ["<CR>", "l", "o"], scope: "threads", desc: "open the thread", hint: "⏎ open" },
  { id: "list.first", keys: ["gg"], scope: "threads", desc: "first thread" },
  { id: "list.last", keys: ["G"], scope: "threads", desc: "last thread" },
  { id: "list.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "threads", desc: "half a page down" },
  { id: "list.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "threads", desc: "half a page up" },
  { id: "list.nextFile", keys: ["J"], scope: "threads", desc: "first thread of the next file" },
  { id: "list.prevFile", keys: ["K"], scope: "threads", desc: "first thread of the previous file" },
  { id: "list.down", keys: ["]t"], scope: "threads", desc: "next thread" },
  { id: "list.up", keys: ["[t"], scope: "threads", desc: "previous thread" },
  { id: "unread.next", keys: ["n"], scope: "threads", desc: "open the next unread thread", hint: "n unread" },
  { id: "unread.prev", keys: ["N"], scope: "threads", desc: "open the previous unread thread" },
  { id: "filter.resolved", keys: ["<Space>ur"], scope: "threads", desc: "show / hide resolved threads", hint: "␣ur resolved" },
  { id: "filter.news", keys: ["<Space>n"], scope: "threads", desc: "only threads with news" },
  { id: "quit", keys: ["q"], scope: "threads", desc: "quit", hint: "q quit" },

  { id: "thread.next", keys: ["j", "]t"], scope: "thread", desc: "next thread", hint: "j/k thread" },
  { id: "thread.prev", keys: ["k", "[t"], scope: "thread", desc: "previous thread" },
  { id: "thread.nextFile", keys: ["J"], scope: "thread", desc: "first thread of the next file" },
  { id: "thread.prevFile", keys: ["K"], scope: "thread", desc: "first thread of the previous file" },
  { id: "unread.next", keys: ["n"], scope: "thread", desc: "next unread thread" },
  { id: "unread.prev", keys: ["N"], scope: "thread", desc: "previous unread thread" },
  { id: "scroll.down", keys: ["<Down>", "<C-e>"], scope: "thread", desc: "scroll down a line", hint: "↑↓ ^d ^u scroll" },
  { id: "scroll.up", keys: ["<Up>", "<C-y>"], scope: "thread", desc: "scroll up a line" },
  { id: "scroll.pageDown", keys: ["<C-d>", "<PageDown>"], scope: "thread", desc: "half a page down" },
  { id: "scroll.pageUp", keys: ["<C-u>", "<PageUp>"], scope: "thread", desc: "half a page up" },
  { id: "scroll.top", keys: ["gg"], scope: "thread", desc: "top of the page" },
  { id: "scroll.bottom", keys: ["G"], scope: "thread", desc: "end of the conversation" },
  { id: "thread.reply", keys: ["r"], scope: "thread", desc: "reply to the thread", hint: "r reply" },
  { id: "thread.resolve", keys: ["x"], scope: "thread", desc: "resolve", hint: "x resolve" },
  { id: "thread.reopen", keys: ["X"], scope: "thread", desc: "reopen" },
  { id: "back", keys: ["<Esc>", "q"], scope: "thread", desc: "back to the threads", hint: "esc back" },

  { id: "drafts.down", keys: ["j", "<Down>"], scope: "drafts", desc: "next draft", hint: "j/k move" },
  { id: "drafts.up", keys: ["k", "<Up>"], scope: "drafts", desc: "previous draft" },
  { id: "drafts.open", keys: ["<CR>", "o"], scope: "drafts", desc: "open its thread", hint: "⏎ open" },
  { id: "drafts.edit", keys: ["e"], scope: "drafts", desc: "edit the draft", hint: "e edit" },
  { id: "drafts.discard", keys: ["dd"], scope: "drafts", desc: "discard the draft", hint: "dd discard" },
  { id: "drafts.summary", keys: ["c"], scope: "drafts", desc: "write the summary for the whole review", hint: "c summary" },
  { id: "drafts.approve", keys: ["A"], scope: "drafts", desc: "approve the latest version (drafts go along as nits)", hint: "A approve" },
  { id: "back", keys: ["<Esc>", "q"], scope: "drafts", desc: "back", hint: "esc back" },

  { id: "composer.draft", keys: ["<C-s>", "<C-CR>"], scope: "composer", desc: "save as a draft: the agent sees it after you submit the review", hint: "^S save draft" },
  { id: "composer.now", keys: ["<C-g>", "<C-S-CR>"], scope: "composer", desc: "send now", hint: "^G send now" },
  { id: "composer.leave", keys: ["<Esc>"], scope: "composer", desc: "leave; the text is kept for next time (jj too)", hint: "esc leave, text kept" },

  { id: "choice.down", keys: ["j", "<Down>", "<Tab>"], scope: "choice", desc: "next option", hint: "j/k move" },
  { id: "choice.up", keys: ["k", "<Up>", "<S-Tab>"], scope: "choice", desc: "previous option" },
  { id: "choice.pick", keys: ["<CR>"], scope: "choice", desc: "pick the option", hint: "⏎ or 1–9 pick" },
  { id: "choice.cancel", keys: ["<Esc>", "q"], scope: "choice", desc: "cancel", hint: "esc cancel" },

  { id: "help.down", keys: ["j", "<Down>"], scope: "help", desc: "scroll down", hint: "j/k scroll" },
  { id: "help.up", keys: ["k", "<Up>"], scope: "help", desc: "scroll up" },
  { id: "help.close", keys: ["<Esc>", "?", "q"], scope: "help", desc: "close", hint: "esc close" },

  { id: "submit", keys: ["S", "<Space>rs"], scope: "global", desc: "drafts, then S again submits: request changes (approve when there are no drafts)", hint: "S submit" },
  { id: "drafts", keys: ["s", "<Space>rd"], scope: "global", desc: "your drafts", hint: "s drafts" },
  { id: "refresh", keys: ["R", "<Space>rr"], scope: "global", desc: "re-read “now” from the working tree" },
  { id: "help", keys: ["?", "<Space>?"], scope: "global", desc: "all keys of this page", hint: "? keys" },
];

export const LEADER_GROUPS: Record<string, string> = {
  "<Space>u": "ui toggles",
  "<Space>r": "review",
};

export function tokens(keys: string): string[] {
  return keys.match(/<[^>]+>|./g) ?? [];
}

/** How a key looks in the footer and the help: `<C-d>` as `^d`, `<CR>` as `⏎`, `<Space>` as `␣`. */
export function keyLabel(keys: string): string {
  return tokens(keys)
    .map((t) => {
      const named: Record<string, string> = { "<CR>": "⏎", "<Space>": "␣", "<Esc>": "esc", "<Down>": "↓", "<Up>": "↑", "<Tab>": "tab", "<S-Tab>": "S-tab", "<lt>": "<" };
      if (named[t]) return named[t];
      const ctrl = /^<C-(.)>$/.exec(t);
      if (ctrl) return `^${ctrl[1]!.toUpperCase()}`;
      return t.replace(/^<(.*)>$/, "$1");
    })
    .join("");
}
