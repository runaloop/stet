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

## Markdown

A Markdown file shows rendered. Like its code, it shows what changed with the text around it (the blocks the code's
hunks touch) and folds the rest into bars: whole blocks, and in a long list or table the items or rows, with the
table's header again below a bar. **show above** and **show below** on a bar open about 20 more lines of it, in whole
blocks, from its top or its bottom, and **show all N** opens all of it. The bars of the code open lines the same way,
and the two views share what is open: lines opened in one show in the other. **full file** on the file's header shows
the whole file, rendered and as code, while the page is open.

The button on its header (**‹/› code** / **¶ rendered**) switches that file to its code and back while the page is
open, and keeps the first text you see where it is on the screen: the topmost block becomes its line at the point you
scrolled to (halfway through a ten-line paragraph: its fifth line), and the topmost line becomes the block that holds
it, placed so that the line's share of the block stays where the line was. Text the code had folded opens there, with
a screen of lines around it, and stays open when you switch again. The old view fades out over the new one in a fifth
of a second (at once with reduced motion), and keys, clicks and the wheel act on the new one right away. The cursor
goes there too when it was on screen; otherwise it keeps its place in the file. `stet config set compare.markdown
code` makes code the default.

In split view the old and the new version stand side by side, block facing block: unchanged blocks are level, and
inside a changed list or table the items and rows face each other too (nested items as well), with an empty slot
facing an item or a row that was added or removed. The words that changed are marked in the text, struck through on
the old side and green on the new one; a picture or a link whose address changed is framed or underlined, with the
old address on hover. A block of which more than 60% of the words changed is marked as a whole instead. Blocks that
one change rewrote together are paired by how alike they are; when nothing is alike they stay one group.

In unified view it is one column. A block with a few words changed shows once, with the changes in its text (removed
text keeps its bold, code and links), and so does a list or a table, nested items too: an item or a row that was
added is green, one that was removed is struck through in red where it was (in an ordered list with its old number),
and a rewritten one shows as the removed one above the added one. When a block became another kind of block, a code
block changed, or a block was rewritten, its old version (marked "was") stands above its new one, the way unified
code shows removed lines above added ones. An added or a deleted file has one side. Pictures load from the repository at the version of their
side; pictures from the web are not loaded (their address is shown instead), raw HTML stays text, and code blocks
are highlighted.

Threads are on lines here too. A thread shows on the blocks its lines are in, with its card under the last of
them (and its lines on the card when it covers only part of a block); a thread on blank lines shows on the
block before them. A thread on a table row or a list item breaks the table or the list after its last row or item,
so the card stands right under it; the table goes on below with its header again, an ordered list from the next
number, and in split view the other side breaks at the facing row, with an empty slot as tall as the card. The box
for a new comment opens at the same place. A click on a block puts the cursor on it; **+** beside a block (or `i` on the cursor's
block, `V` with `j` / `k` for several) starts a thread on the block's lines, on its side, and **‹/›** beside it
shows those lines in the code where the block was, with the cursor on them. A link to another file opens it in the
preview.

Search reads the rendered text: a match is highlighted where it shows and the cursor goes to its block. A match
that only the Markdown source has (a link address, a picture's path, markup) shows that file as code, and a note
says so ([guide](guide/README.md#markdown)).

## Blame

`Space g b` on the Changes page shows where the cursor line, the selection or the rendered block under the cursor
came from, in a small box under it: per run of lines the version that brought them in their current form (`base`
when they are unchanged since the review's base, `now` when no version has them yet), the round of review that
version answered, and the threads its agent replies answered there: `v3 · round 1 · fixed #12 “title”`. A thread
anchored on the lines comes first; else one whose reply names the file `(named)`; else a fix in the same file
`(same file)`. It blames the right side of the diff at its version (or the pinned "now"); lines of the old side
blame the left one. The version opens what changed in it, on those lines; the thread opens its page. `Enter` follows
the first thread, `j` / `k` pick another link when there are several, and `Esc` or moving the cursor closes the box.
On a thread page `Space g b` blames the thread's lines in the code shown (the right side of the diff, Then or the
step). The agent gets the same from `stet blame <path>:<lines>`.

## The agent's guide to a version (experimental)

An experiment: it may change or go. With `stet version create --guide <file>` the agent explains a version as a
few steps, in the order that makes the change easiest to follow, each naming its lines (`path:a-b`, or a path alone
for the file's whole change). When the right side of the Changes page is such a version, a **Diff | Guide** switch
sits next to the title (`Space u g`). The Guide tab shows the guide's title, then each step's text (Markdown, raw HTML
shown as text; `#12` links the thread) and under it only that step's lines as a small diff of the open compare, with
three lines around them; the bars above and below show more. A click on a file's name above its lines folds them to
that line (its path, its `+` and `−`), and **show N lines** opens them again; a file of more than 80 lines (a long
new test, say) starts folded. Threads on those lines show as cards that open the thread. The Files panel marks the
file of the lines in view (or of the step `}` / `{`, a click or the cursor went to); a file picked there goes to the
first step that names it, or to the Diff when none does. **open in Diff** goes to the normal diff at exactly those
lines, highlighted, with the cursor on the first. At the end, **Not in the guide** lists the files the compare
changes that no step names. Switching to the Guide and back leaves the diff as it was: its scroll, cursor, selection
and comment box; the Guide tab keeps its own.

A step's lines take comments as the diff does: a click on a line, **+** beside it or a drag over the line numbers
opens the same box under the lines, for a draft (on the Drafts page, and a card under the lines once saved) or a
thread sent at once. The keys work as in a thread's code: a click into the lines, `V` (select from the cursor, which
starts on the first line of the step in view) or `i` / `a` / `c` / `gcc` give the lines the focus and the guide a
blue frame; then `j` / `k`, `gg` / `G`, `Ctrl+d` / `Ctrl+u`, `]c` / `[c`, `]h` / `[h`, `zz`, `V` with `o`, `i` / `a`
/ `c` / `gc` / `gcc`, `Space g Y` and counts act on them, across the steps, while `}` / `{` (which take the cursor to
the step), `za` and `Enter` stay the guide's. `Esc` closes the selection and the box, then leaves the lines; the next
`Esc` goes back to the Diff.

In the Guide tab: `}` / `{` next / previous step, `Enter` opens the step's first lines in the Diff, `j` / `k` and
`Ctrl+d` / `Ctrl+u` scroll, `za` folds or opens the file in view (`zo` / `zc`; `zR` / `zM` all of them), `V` / `i`
into the lines, `Esc` or `Space u g` back to the Diff. The agent reads it back with `stet guide [N]`.

When the agent writes one: by default (`agent.guide` `on`) for the first version of a task and for a round that
changed more than the threads asked; with guides off, only when you ask. The switch **Guides in this repository: on |
off** on the Drafts page sets it for every review of the repository (`stet config set agent.guide off` does the same;
another open page shows the change once it reloads the review, on its next change or a reload). To ask, tick **ask
the agent for a guide to the next version** under the Drafts page's buttons (or `stet review submit --guide`): it
goes with that review only, and the agent writes the guide whatever the size of the version. A version that
brings a guide you asked for opens on the Guide tab the first time it is on the right; after that the tab stays as
you left it.

## Keys

Vim-style, modelled on [LazyVim](https://www.lazyvim.org). `?` shows every key with a filter box; `Space s k`
searches the keys like LazyVim's keymaps picker and runs the one you pick; `Space` is the leader and shows
what can follow it. Counts work (`5j`), and so do non-Latin keyboard layouts (keys are matched by their
physical position). A tour with screenshots: [guide](guide/README.md#navigation).

On the Changes page a cursor moves over the diff (a click on a line puts it there). In a rendered Markdown file it
moves over the blocks instead of the hidden lines (an unchanged block once, a changed one on its old side, then its
new side), and `Ctrl+d` / `Ctrl+u` move it by half a screen of blocks; a picture (an image, an SVG shown as a
picture) is one stop:

| Key | Action |
|---|---|
| `j` / `k`, `gg` / `G`, `Ctrl+d` / `Ctrl+u` | cursor by line, to the ends, by half a page |
| `]c` / `[c`, `]h` / `[h` | next / previous change, hunk |
| `]b` / `[b` or `L` / `H` | next / previous file |
| `]t` / `[t` · `Enter` | next / previous thread on the diff · open the thread under the cursor |
| `]u` / `[u` · `n` / `N` | next / previous unread thread · next / previous search match (unread when there is no search) |
| `V` then `j` / `k`, `o` | select lines, jump to the other end of the selection |
| `i` · `a` · `c` · `gcc` | comment on the cursor line or the selection |
| `Space g Y` | copy a link to the cursor line or the selection ([links](#links)) |
| `Space g b` | where the cursor line or the selection came from: version, round, the threads it answered ([blame](#blame)) |
| `zo` / `zc` / `za`, `zR` / `zM` | open / close the file under the cursor, all files |
| `/` · `Space /` | search the diff · search all files of the version |
| `*` · `Space s w` · double-click | find where the selected word (or the double-clicked name) is used, in all files |
| `]v` / `[v`, `}` / `{` | move "to", move "from" one version |
| `Space Space` | find a file of the diff (fuzzy) |
| `Space f v` | find a version by number or label: `Enter` what changed in it, `Shift+Enter` / `Ctrl+Enter` make it from / to |
| `Space s k` | search the keys by what they do, `Enter` runs the key |
| `Space e` · `Space st` · `Space n` | Files tab · Threads tab · threads with news |
| `Space uw` · `Space ud` · `Space ur` · `Space ut` | wrap · split/unified · resolved threads · folded tests |
| `Space ul` · `Space uL` | side panel left / right of the diff · the page's column order and widths back to the defaults |
| `Space ug` | the agent's guide to the version on the right, or back to the diff ([experimental](#the-agents-guide-to-a-version-experimental)) |
| `Space rd` · `Space rs` · `Space rv` · `Space rr` | drafts · submit or approve · changes since you last looked · re-read "now" |
| `Esc` | close the preview, the selection, then the comment box |

In a thread: `j` / `k` next / previous thread, `n` / `N` unread, `[` / `]` timeline step, `t` diff / then /
at step, `p` diff base, `r` reply, `x` / `X` resolve / reopen, `e` editor, `Space g b` blame the thread's lines in the code
shown, `/` search all
files at the step shown, `*` find the selected word, `Space u l` the conversation left / right of the code, `Esc` close
the preview, then back to the changes.
The thread's code has the Changes page's cursor, but `j`, `k` and the rest act on it only while the code has the
focus, so they keep stepping through threads and messages otherwise. A click on a line or a rendered block (or a
comment started with the mouse) gives the code the focus; so do `V` (select lines from the cursor, which starts on the
thread's first line) and `i` / `a` / `c` / `gcc` (comment on the cursor line). The code column then has a blue frame,
and the Changes page's keys work in it: `j` / `k`, `gg` / `G`, `Ctrl+d` / `Ctrl+u`, `]c` / `[c`, `]h` / `[h`, `zz`, `V`
with `j` / `k` and `o`, `i` / `a` / `c` / `gc` / `gcc`, `Space g Y`, and counts (`3j`). The thread's other keys keep
working there (`x`, `r`, `[` / `]`, `t`, `n`, …; `[` and `]` wait a moment for a `c` or an `h`). `Esc` closes the
preview, the selection, then the comment box, and then leaves the code; a click outside the framed box (its tabs and
scope buttons do not count) or `r` into the reply box leaves it too. The cursor stays where it was for the next time.
In its messages: `}` / `{` next / previous message, `gg` / `G` first / last, `Ctrl+d` / `Ctrl+u` half a
page, `za` fold or unfold the message under the cursor (`zR` / `zM` all of them), and `r` replies to the
message under the cursor once you moved it there (with these keys or a click), otherwise to the thread.
Everywhere: `v` changes since you last looked, `s` drafts, `S` drafts then submit (or approve), `w` wrap, `R` re-read
"now", `Space g s` git state (pushed, staged, not staged, new), `Ctrl+O` / `Ctrl+I` jump back / forward (pages, search hits, file jumps). Only text fields take
keys: after a click on a checkbox, a select or a button the keys keep working.

In a comment box, `Ctrl+Enter` or `Ctrl+S` adds to your review (draft), `Ctrl+Shift+Enter` sends at once,
and `Esc` or `jj` leaves the box without losing the text.

## Side panel

The side panel has three tabs on the Changes page and on a thread:

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
file" switch the scope; a line above the code says what is shown. Comments start there as on the Changes
page, in the code and in rendered Markdown alike: a click on a line or a block puts the cursor on it, `+`
beside it, a drag over the line numbers or the keys below open the same box under the lines. It starts a new
thread on them (on the version shown, the old side's lines on the old version), and offers **❝ Quote in
reply** (the lines with their path and numbers go into this thread's reply box), **Copy link** (the Changes
page of the versions shown, at those lines) and, on an older version, [restore](#restore-as-in-vn) in this
thread. A Markdown file shows rendered here too (by `compare.markdown`), with the same
**‹/› code** / **¶ rendered** button, which stays as you pick steps in the timeline: the blocks the code shows for
the scope picked ("around the thread", "all changes in this file", "whole file"), the rest folded into the same bars as
on the Changes page, shared with the thread's code; the thread's blocks marked; and two versions old beside new (or
one column in unified view) with the changed words marked. A strip under the header says whose turn it is ("the agent asked
you a question", "the agent says it fixed this", with a warning when the commented lines did not change),
or that the thread is resolved, by whom and when; `#12` or "thread 12" in a message links to that thread
with a preview on hover. The agent's and your messages have their own colours.

On a wide screen the thread page is three columns: threads | code | messages, each scrolling on its own.
Drag the border next to the side panel or the messages (double-click resets it); widths are kept per page.
The ⇄ button at the top of the border between code and messages (or `Space u l`) puts the conversation left of the
code, next to the threads: threads | messages | code. On the Changes page the same button on the side panel's border
puts the panel right of the diff. Each page remembers its order in the browser, a column keeps its width wherever it
sits, and `Space u L` puts the page's columns back in their default order and widths. A narrower window lays the
columns out as before, whatever the order.

A thread opens at the first message you have not read, under a "new" line, or at the last message with
the reply box when nothing is new; the header of the messages counts them ("7 messages · 2 new", a click
goes to the first new one). Long messages you have already read fold to a few lines
([screenshots](guide/README.md#long-conversations)).

## Restore as in vN

To get old code back exactly, select the lines where an older version shows them and press **↺ Restore as in v2**
(or **as in base**). It saves a draft that asks the agent to put back exactly that text; stet never writes the
working tree itself. The draft goes with your review like any comment, and you can edit or discard it on the
Drafts page or in its thread.

- On the Changes page the button sits next to **Copy link** on the comment box of lines selected on the old side,
  when that side is a version or the base (not a commit picked from the list). The draft starts a thread on the lines
  of the new side that now stand where the old ones were (on the old lines when the file is gone there), and takes
  what you typed in the box as its words.
- On a thread page, Then and At step on an older version show the button above the code: it asks, in that thread, for
  the thread's lines as they were then. Lines picked on an older version (the old side of Diff, or Then) offer it
  in their comment box, next to **Quote in reply**, with what you typed in the box.

A comment with a restore request shows the old text as a small code block labelled "Restore as in v2 · lines 40–44",
in the thread and on the Drafts page. The agent gets it as `restore: { path, range, version, text }` on the comment
in `stet thread show --json`.

## Drafts and approval

The **Drafts** page lists your unsent comments, a box for a summary of the whole review, and two actions.
**Request changes** sends the drafts to the agent in one go, like a GitLab review; the agent answers each
thread and hands over the next version. **Approve** says the latest version is done, and needs no drafts.
With drafts it asks whether they go along as nits (the agent fixes them without a new round) or as a
request for changes; with other threads still open, whether to leave them open or resolve them all first
(`j` / `k` and `Enter` pick, `Esc` cancels). `S` on the page does what its key mark shows: it requests changes
when there are drafts and approves when there are none. Under the buttons, **ask the agent for a guide to the next
version** goes with Request changes, and **Guides in this repository: on | off** turns the agent's guides on or off
for the repository; the box still asks for one when they are off ([the agent's guide](#the-agents-guide-to-a-version-experimental)).

After an approval the header says **approved at v3**, and **approved at v3 · changed after** once a newer
version exists or the working tree differs from v3 (a click shows what changed since). The agent sees the
verdict in `stet status`. Approving does not close the review; `stet review close` does. The Round page and
`Space f v` group versions by the review they answer, with its verdict ("changes requested", "approved").
From the terminal: `stet review submit --approve` (with other threads open, `--force` leaves them open and
`--resolve-all` resolves them).

## Links

Every thread, version, file and search hit is a real link: a middle click or `Ctrl+click` opens it in a
new tab, and the link carries the file and line (and the review when there are several). A new tab of
the same browser needs no token in the link: the first visit sets an `HttpOnly`, `SameSite=Strict`
session cookie from which the page gets the token.

A link to the Changes page can name a range of lines: `#/compare/2..3?file=src/Cache.kt&line=40-55`
(`line=40` for one line, `side=old` for lines on the old side). Opening it puts the cursor on the first line
and highlights the lines; a range scrolls in from near the top, one line to the middle. The highlight stays
while the cursor is on those lines and goes once it leaves them (keys, a click on another line or block). In a
rendered Markdown file the blocks that hold the lines are highlighted, and lines the diff folds open first.
Other lines the diff does not show (another file, or one not in the diff) open in the file's preview.

To share lines, select them (a drag, `+`, or `V` and `i` on the keyboard) and press **Copy link** on the comment
box, or press `Space g Y`: in visual mode it copies the selection, otherwise the line or rendered block under
the cursor. The link is the full address with the range of versions, the review, the file, the lines and the
side, and no token: like the other links, it opens in the browser that opened the URL `stet serve` printed,
through the session cookie. In a thread's code the link names the versions it shows; lines of Then or At step (one
version) open in that file's preview.

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
