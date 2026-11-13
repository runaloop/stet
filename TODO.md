# TODO

- [x] Distinguish replaced, deleted and unlocated thread code from its historical source.
  - Label both compared versions and keep a replaced fragment's marker on the earlier side.
  - Show confirmed deletion with an empty selected version and a separate historical frame.
  - Preserve the first confirmed deletion across later versions; do not infer deletion from a lost anchor.
  - Keep the discussion's open/resolved state independent of code placement.

- [ ] Approval and publication control ([implementation plan](docs/approval-and-publication-plan.md)).
  - [x] P0: pin existing approval behavior, including dirty/cached/pinned worktrees, nits and settled instructions.
  - [x] P1, local single-commit increment: immutable plans, local grants, complete fresh tree evidence and a shared gate.
  - [x] P2, local single-commit increment: explicit consent, stale-click checks, pause and revocation in Round/Drafts.
  - [x] P3, local single-commit increment: exact unsigned commit, expected-old ref update, durable receipt and non-redispatching recovery.
  - [ ] Extend the local contract: validation-evidence policy, informational-thread waivers and metadata comparisons.
  - [ ] P4: runtime/helper adapters and effective-enforcement diagnostics.
  - [ ] P5: isolated authority/executor; reference environment and human authentication still need selection.
  - [ ] P6: provider identity, push/MR support and separate merge authorization.
  - [x] P7 for the local single-commit increment: migration, compatibility tests, guide screenshots and compiled-binary smoke check.
  - [ ] P7 for later increments: provider/protected deployment rollout and enforcement checks.

- [x] Keep Threads visible when selecting a thread from the tree.
  - Confirmed in headless Firefox on the current compiled build: open a thread, choose Files, return to Changes (whose panel still shows Threads), then select a thread from that tree. The panel switches to Files.
  - Expected: selecting a thread while in Threads keeps the left panel in Threads.
  - Cause: `web/compare.ts` stores separate `compare` and `thread` sidebar tabs. `ThreadRow` in `web/views/ThreadTree.tsx` only navigates, so the destination restores its previous Files tab instead of retaining the visible Threads context.
  - Control: choosing Threads on the thread page before leaving makes the same return sequence keep Threads. The separate tab state predates the recent fixes.
  - Fixed: explicitly select Threads for the destination when opening a thread from the thread tree. Modified clicks retain normal browser link behavior.
  - Regression coverage: previous Files/Search choices, the cross-page click sequence, browser Back/Forward, and an explicit Files choice after opening a thread.

- [x] Copy and open links to individual replies.
  - Each message has Copy link and a timestamp permalink, including the review, thread and comment.
  - Opening the link unfolds, scrolls to and highlights the target; unavailable targets leave the thread readable with a notice.
  - Covered clipboard fallback, nested replies, same-thread history, new tabs and narrow layouts.
