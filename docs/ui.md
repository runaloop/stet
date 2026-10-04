# Web UI

The reference for the pages, panels and keys. For a tour with screenshots, see the [guide](guide/README.md).

## Changes page

The **Changes** page says in plain words which code it shows ("Changes after v3, not saved as a version
yet", "What changed in v3", "Since you last looked"). A strip of versions `base · v1 · v2 · now` marks the
range: **from** and **to** under a step set that end of the diff exactly (the code of the "from" step is the
old side, of the "to" step the new side), a click on a step shows only what changed in it, and a drag
across steps picks both ends. Presets sit next to it. "✓ Done up to vN" (or marking the last file viewed)
remembers your pass per review, and next time `v` opens "since I last looked". The header says what "now"
is: `now = v3`, or `now: 30 files after v3` when the agent changed code without a new version. A long
branch stays usable: the strip folds the versions far from the range (`v1…v38`), the header shows the last
six, and `Space f v` lists every version newest first, grouped by the review it answers, with search by
number or label ([guide](guide/README.md#many-versions)).

## Git state and fresh data

The header also says where the branch is in git (`pushed`, `↑2 not pushed`, `not pushed` when no remote has it)
and how many files are staged, not staged and new; in a review of the index, how many are not in the review
because they are not staged. A click (or `Space g s`) lists them, and each file in the Files tab and on its
header is marked (`not staged`, `partly staged`, `new`, `↑` for commits not pushed). The page keeps itself
current: replies and versions arrive as they happen, and the server looks at the worktree every few seconds.
When the agent changed code without a new version, **↻ N files changed** appears next to "now"; nothing
redraws under you until `R`. If the server stops, the header says **offline · retrying**, and a restarted
server takes the same port, so the tab picks it up again ([guide](guide/README.md#git-state-and-fresh-data)).

## Commits

Commits work too. **commits…** next to the presets (or `Space g c`) lists the branch's commits, newest first,
with "now" on top and a line where the branch leaves `main`: a click on a message shows that commit alone,
**first** and **last** pick the oldest and the newest commit to show (both included, as on GitHub; the strip
above then shows the two code states the diff runs between), and a field
takes any range such as `main..HEAD`. To keep commits as versions with thread timelines across them, make
each one a version: `stet version create --at <commit>`. Screenshots:
[guide](guide/README.md#compare-commits).

## Images

Images (png, jpg, gif, webp, bmp, ico, avif, svg) show as pictures, not as "binary file": an added or deleted one as
it is, a changed one side by side, with a swipe divider, one over the other (onion skin), or as the pixels that
differ, with the size and bytes before and after. Icons are enlarged without blur. An SVG has a button on its header to
switch between the picture and its code. A drag on an image frames an
area, and the thread is on that area the way other threads are on lines: drafts, submit, replies, a timeline
that shows the area at every version (`changed` when the image changed, `outdated` when it is gone). The agent
gets the image with the area framed and the area at full size as PNG files (`stet thread show`)
([guide](guide/README.md#images)).

## Keys

Vim-style, modelled on [LazyVim](https://www.lazyvim.org). `?` shows every key with a filter box; `Space s k`
searches the keys like LazyVim's keymaps picker and runs the one you pick; `Space` is the leader and shows
what can follow it. Counts work (`5j`), and so do non-Latin keyboard layouts (keys are matched by their
physical position). A tour with screenshots: [guide](guide/README.md#navigation).

On the Changes page a cursor moves over the diff (a click on a line puts it there):

| Key | Action |
|---|---|
| `j` / `k`, `gg` / `G`, `Ctrl+d` / `Ctrl+u` | cursor by line, to the ends, by half a page |
| `]c` / `[c`, `]h` / `[h` | next / previous change, hunk |
| `]b` / `[b` or `L` / `H` | next / previous file |
| `]t` / `[t` · `Enter` | next / previous thread on the diff · open the thread under the cursor |
| `]u` / `[u` · `n` / `N` | next / previous unread thread · next / previous search match (unread when there is no search) |
| `V` then `j` / `k`, `o` | select lines, jump to the other end of the selection |
| `i` · `a` · `c` · `gcc` | comment on the cursor line or the selection |
| `zo` / `zc` / `za`, `zR` / `zM` | open / close the file under the cursor, all files |
| `/` · `Space /` | search the diff · search all files of the version |
| `*` · `Space s w` · double-click | find where the selected word (or the double-clicked name) is used, in all files |
| `]v` / `[v`, `}` / `{` | move "to", move "from" one version |
| `Space Space` | find a file of the diff (fuzzy) |
| `Space f v` | find a version by number or label: `Enter` what changed in it, `Shift+Enter` / `Ctrl+Enter` make it from / to |
| `Space s k` | search the keys by what they do, `Enter` runs the key |
| `Space e` · `Space st` · `Space n` | Files tab · Threads tab · threads with news |
| `Space uw` · `Space ud` · `Space ur` · `Space ut` | wrap · split/unified · resolved threads · folded tests |
| `Space rd` · `Space rs` · `Space rv` · `Space rr` | drafts · submit · changes since you last looked · re-read "now" |
| `Esc` | close the preview, the selection, then the comment box |

In a thread: `j` / `k` next / previous thread, `n` / `N` unread, `[` / `]` timeline step, `t` diff / then /
at step, `p` diff base, `r` reply, `x` / `X` resolve / reopen, `e` editor, `/` search all
files at the step shown, `*` find the selected word, `Esc` close the preview, then back to the changes.
In its messages: `}` / `{` next / previous message, `gg` / `G` first / last, `Ctrl+d` / `Ctrl+u` half a
page, `za` fold or unfold the message under the cursor (`zR` / `zM` all of them), and `r` replies to the
message under the cursor once you moved it there (with these keys or a click), otherwise to the thread.
Everywhere: `v` changes since you last looked, `s` drafts, `S` drafts then submit, `w` wrap, `R` re-read
"now", `Space g s` git state (pushed, staged, not staged, new), `Ctrl+O` / `Ctrl+I` jump back / forward (pages, search hits, file jumps). Only text fields take
keys: after a click on a checkbox, a select or a button the keys keep working.

In a comment box, `Ctrl+Enter` or `Ctrl+S` adds to your review (draft), `Ctrl+Shift+Enter` sends at once,
and `Esc` or `jj` leaves the box without losing the text.

## Side panel

The left column has three tabs on the Changes page and on a thread:

- **Threads**: the thread tree with filters.
- **Files**: every file of the diff with `+`/`−` counts and thread counts. The file under the cursor (or,
  without a cursor, the one you are scrolled to) is highlighted. Tick "viewed" (here or in the file
  header) to collapse a file until its content changes; the marks are kept in the review database.
  On a thread page a click shows the file over the thread's code.
- **Search**: "in the diff" searches every line of the diff (added, removed, context), also in files the
  page has not drawn yet; "in all files" runs `git grep` on the version, changed files or not, and opens
  a match outside the diff in a preview where you can comment too. Matches next to each other merge
  into one block with a line of context. Capital letters make it case-sensitive, `.*` switches to a
  regular expression.
  On a thread page Search looks through every file at the step shown next to the thread; a hit opens
  over the thread's code while the conversation and the reply box stay on screen, and ❝ quotes the line
  into your reply.
  Double-clicking a name in code finds its uses, on the Changes page, in a preview, in a thread's code and
  in `code` in a reply; the whole name, even when a wrapped line breaks it in two.

## Thread page

The compare highlights every line of each thread; hovering a thread card highlights its lines stronger.

A thread page shows the code around the thread the same way in Diff, Then and At step: the commented
lines with a few lines around them, the ⋯ bars expand more, and "whole file" / "all changes in this
file" switch the scope; a line above the code says what is shown. Selecting lines there starts a new
thread or quotes them into the reply. A strip under the header says whose turn it is ("the agent asked
you a question", "the agent says it fixed this", with a warning when the commented lines did not change),
or that the thread is resolved, by whom and when; `#12` or "thread 12" in a message links to that thread
with a preview on hover. The agent's and your messages have their own colours.

On a wide screen the thread page is three columns: threads | code | messages, each scrolling on its own.
Drag the border next to the side panel or the messages (double-click resets it); widths are kept per page.

A thread opens at the first message you have not read, under a "new" line, or at the last message with
the reply box when nothing is new; the header of the messages counts them ("7 messages · 2 new", a click
goes to the first new one). Long messages you have already read fold to a few lines
([screenshots](guide/README.md#long-conversations)).

## Links

Every thread, version, file and search hit is a real link: a middle click or `Ctrl+click` opens it in a
new tab, and the link carries the file and line (and the review when there are several). A new tab of
the same browser needs no token in the link: the first visit sets an `HttpOnly`, `SameSite=Strict`
session cookie from which the page gets the token.

## Folded test files

Test files that only add code (a new test file, or tests appended, with no removed line and no skip
marker such as `@Ignore`, `@Disabled`, `.skip(`) fold into one group at the end of the compare. A test
file that removes or changes lines, skips a test or is deleted stays in the list with a warning, so an
agent cannot quietly weaken a test. Lock files fold the same way. The header of the Changes page counts
both and shows the folded ones on a click ([screenshots](guide/README.md#test-files-that-only-add-code-are-folded)).

## File order

Files are ordered by kind, then by path: code; resources, build and config (JSON, YAML, TOML, properties,
XML and Android `res/`, Gradle); tests that change or remove lines; docs; then the folded groups. The diff,
the Files tab (a section per kind), search results, `]b` and `]t` follow this order, and so does the
thread tree ([screenshot](guide/README.md#files-are-ordered-by-kind)).
