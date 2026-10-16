/** What the browser key opens: the web UI's view of the place the terminal UI shows, through `browser.open`. */
import type { ActionTarget } from "../core/module.ts";
import type { TimelineStepDto } from "../core/types.ts";
import { tipRef } from "../ui/state.ts";
import { refsOf } from "./changes.ts";
import { codeEnds } from "./code.ts";
import type { ViewState } from "./render.ts";

/** A step of a thread's timeline as a ref of a compare: its version when it is one, "now", else its commit. */
export const stepRef = (step: TimelineStepDto) => (step.kind === "now" ? "now" : step.version !== null && step.label === `v${step.version}` ? String(step.version) : step.sha);

/**
 * Where the browser opens for the place in focus, as the web links it: the lines picked or under the cursor in the
 * range shown (a picture or a Markdown file shows there as the web draws it), a file a message named over the
 * thread's code (the branch's Changes page at its lines, where the web's link goes), the lines of a thread's code,
 * the thread (`draft`'s on the Drafts tab), or the review.
 */
export function browserTarget(v: ViewState, draft: number | null): ActionTarget {
  const range = (from: string | null, to: string | null) => ({ ...(from ? { from } : {}), ...(to ? { at: to } : {}) });
  if (v.tab === "changes") {
    const c = v.changes;
    const sel = c.focus === "diff" ? c.diff.selection() : null;
    if (sel) return { path: sel.key, line: sel.start, end: sel.end, side: sel.side === 0 ? "old" : "new", ...range(c.from, c.to) };
    const info = c.diff.info();
    const path = c.focus === "diff" && info?.item.kind === "file" ? info.item.key : (c.sel ?? undefined);
    return { ...(path ? { path } : {}), ...range(c.from, c.to) };
  }
  if (v.tab === "drafts") return draft !== null ? { thread: draft } : {};
  const p = v.peek;
  if (p && v.focus !== "list") return { path: p.path, line: p.line, ...(p.end !== undefined ? { end: p.end } : {}), from: "base", at: v.branch?.ref ?? tipRef(refsOf(v.data)) };
  const d = v.detail;
  const shown = v.code.drawn;
  const sel = v.codeCursor && v.focus !== "list" ? v.code.diff.selection() : null;
  if (d && shown && sel) {
    const { from, to } = codeEnds(d, shown.view, shown.scope);
    if ((sel.side === 0 ? from : to).path) return { path: sel.key, line: sel.start, end: sel.end, side: sel.side === 0 ? "old" : "new", from: stepRef(from), at: stepRef(to) };
  }
  return v.selected !== null ? { thread: v.selected } : {};
}
