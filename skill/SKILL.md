---
name: stet-review
description: Take part in a local multi-round code review as the author, through the `stet` CLI. Use when the user says the work is ready for review, asks you to "answer the review", "take the review comments", "check stet", "fix what I commented", mentions stet threads or versions, or when `stet status` shows threads that need an agent reply. You reply in each thread, fix the code, and hand over the next version; the human reviews in the stet web UI.
---

# stet review loop (you are the author)

The human is the reviewer. They comment on line ranges in the stet web UI and submit a
review, or approve the work. You answer every thread, fix the code, and hand over a new
version. Threads, versions and replies live in `.git/stet/`; every worktree of the branch
sees the same review.

All commands print JSON when piped. Run them from the worktree you are working in.

First run `stet status --json`. If `.review.source` is `"index"`, the human reviews **staged
changes**: versions are snapshots of the index, compared with HEAD. Then, after you fix a file,
stage exactly that file (`git add <file>`) before `stet version create`, or the fix will not be in
the version. Never stage anything else and never commit.

## 1. Hand over a version

When the task (or a round of fixes) is done:

```bash
stet version create --label "<one line: what this version contains>"
stet status --json            # .server.url is the review UI, if it is running
```

Tell the human the version number and give the `.server.url` from your own worktree: one server serves
every worktree of the repository, and the URL names your branch's review (`?review=N`). A URL from
another worktree, or one without `review=`, opens someone else's review. If `.server` is null, run
`stet serve --open --json`: it starts the server on its own and returns at once (when a server already runs, it
opens your review there). Never keep `stet serve` running in your shell or as a background task: those are
stopped after a time limit, and the review UI dies with them in the middle of the review.
`version create` exits with code 3 when nothing changed since the last version: that is fine
if you only answered questions.

For the first version of a task, and for a round where you changed more than the threads asked for, add a
guide (experimental, optional): `--guide <file>`, a Markdown file outside the repository that explains the
change as a few steps, in the order that makes it easiest to understand. Skip it for a small or obvious version.

```markdown
# <what the version does>

1. <what this step does and why; Markdown, over as many lines as it needs>
   src/store/migrations.ts:140-152
2. <the next step; in a round, name the threads it answers as #12>
   src/cli/commands.ts:316-330
   test/verdict.test.ts
```

Each step ends with its lines, one reference per line: `path:a-b` for lines of the file in this version, or
`path` alone for the file's whole change, the path from the repository's root. stet refuses the version when a
path or a range is not in it: fix the guide and run the command again.

## 2. End your turn

Do not wait for the review. End your turn after handing over the version. The human reviews when they can,
maybe hours later, and calls you back ("answer the review") once they have submitted; then start at step 3.
Do not remind them about the review, and do not report that it has not arrived.

Only when the human asks you to wait, run this in the background:

```bash
stet wait --for review --json
```

Without `--timeout` it blocks until the reviewer submits; it returns at once when threads already wait for
you (`reason: "pending"`) or the reviewer approved the latest version (`reason: "approved"`). If the wait
ends without a review (a timeout, or your harness stopped the command), do not report it and do not start
it again: the human will call you back.

## 3. Read the review

First check the verdict: `stet status --json`. `.lastSubmission.verdict` is `changes` (answer the threads)
or `approved`: the reviewer accepted version `.lastSubmission.version` (`.lastSubmission.body` is their
summary, if any). On an approval:

- no thread waits for you (`.counts.needsAgent` is 0): the work is done. Write the human a short summary
  of it and stop. Commit or push only if they asked.
- threads wait for you: they are nits. Fix them, reply `fixed` to each (step 4), create a version
  (step 5), write the summary and stop. There is no next round to wait for.

For `changes`, and for nits, read the threads:

```bash
stet threads list --needs-reply --json
stet thread show <id> --json
```

`thread show` gives the conversation, the code the comment was written on
(`code.then`), where that code is now (`thread.anchor`: `ok`, `moved`, `changed` or
`outdated`), and the thread's timeline across versions. Read the whole conversation, not
only the last comment. `anchor.path` and `anchor.range` point at the current location.

A thread on an image has `thread.region` (`x,y,w,h` in pixels of an `iw`×`ih` image) instead of lines,
and `code.then` is null. `thread show` writes the picture the reviewer framed and prints its path:
`image.shot` is the image with the area framed and the rest dimmed, `image.crop` the area at full size.
Open both with the tool you read images with before you answer; the frame is what the comment is about.
The thread turns `changed` once the image file changes.

## 4. Answer every thread, exactly once per round

Pick one intent per thread:

| Intent | When | Body |
|---|---|---|
| `fixed` | you changed the code | what you changed and where (file:line) |
| `answered` | it was a question, no code change | the answer |
| `disagree` | you think the current code is right | the reason, concretely |
| `question` | you need a decision from the reviewer | the question, with options |

```bash
stet reply <id> --intent fixed --body "Moved the null check before the cache lookup (Foo.kt:42)."
stet reply <id> --intent disagree --body - <<'EOF'
Multi-line bodies go through stdin.
EOF
```

Reply to a specific comment in the thread with `--to <commentId>` when the thread branches.
Refer to other threads as `#N`: the review UI turns that into a link. When you agree but wait for the
reviewer (an answer in another thread, a choice), use `question` and say what you wait for; the UI shows
the reviewer that the thread waits for them.

Make the code changes in the working tree as usual. Reply `fixed` only after the change is
actually in the files.

A comment with `restore` (`{ path, range, version, text }`) asks you to put back exactly `restore.text`, the
lines `range` of `path` as they were in that version (or the base), in place of the thread's lines: the
thread's anchor tells where they are now. If bringing them back would break something done later (the build,
a fix asked in another thread), do not restore; reply `question` and explain.

Before you change lines that an earlier round may have fixed, run `stet blame <path>:<a>-<b>`. It names
the version that brought each line and the threads that version answered (`fixed #12`); read those with
`stet thread show <id>` first, so your change does not undo a fix the reviewer asked for.

## 5. Hand over the next version

```bash
stet version create --label "fixes for review <N>"   # --guide <file> when you changed more than the threads asked for
```

Report to the human: how many threads fixed / answered / disagreed / questions, and the
version number. Then go back to step 2; after the nits of an approval, write the summary and stop instead.

## Rules

- Reply in the language the reviewer wrote the thread in (a comment in Spanish gets a reply in Spanish),
  whatever language the code, commits or docs use. Code identifiers, paths and event names stay as is.
- Never resolve or reopen threads: that is the reviewer's call. (`stet resolve` exits 3 for you.)
- Never commit, amend, checkout, stash or reset unless the human asked; stet snapshots the
  working tree itself, uncommitted changes are fine. The one exception is the staged mode above:
  `git add` the files you fixed.
- Never edit files under `.git/stet/`. If `stet` fails because it may not write there (a sandbox that lets
  you write only the worktree; a linked worktree keeps it in the main checkout's `.git`), ask the human
  to allow it. Do not work around it.
- Do not start new threads unless you need to flag something the reviewer must see; then use
  `stet comment add --file <path> --range <a-b> --body <text>`.
- If a thread is `outdated`, read `code.then` to understand what it was about and answer
  anyway; say where that code went, or that it is gone.
