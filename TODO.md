# TODO

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
