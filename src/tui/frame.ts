import { moved, type Data } from "./model.ts";
import { clip, s, spread, width, type Line, type Span, type Tone } from "./text.ts";

/** The top line: the branch and review, the latest version and "now", what waits for you. */
export function headerLine(d: Data, w: number, connecting: string | null): Line {
  const st = d.status;
  const left: Span[] = [s(" stet ", { bold: true, tone: "accent" })];
  if (!st) return { spans: spread(left, [s(`${connecting ?? "loading…"} `, { tone: "muted" })], w) };
  left.push(s(st.review.branch, { bold: true }), s(` #${st.review.id}`, { tone: "muted" }));
  if (st.review.source === "index") left.push(s(" staged", { tone: "warn" }));
  const n = st.versions;
  if (n === 0) left.push(s("  no version yet", { tone: "muted" }));
  else if (st.now?.changedSinceLatest) left.push(s(`  v${n}`), s(` · now: ${st.now.files ?? "?"} file${st.now.files === 1 ? "" : "s"} after v${n}`, { tone: "warn" }));
  else left.push(s(`  v${n}`), s(` · now = v${n}`, { tone: "muted" }));
  const m = moved(d);
  if (m !== null) left.push(s(`  ↻ ${m ? `${m} file${m === 1 ? "" : "s"} changed` : "now changed"} (R)`, { tone: "warn" }));
  const last = st.lastSubmission;
  if (last?.verdict === "approved" && last.version !== null) left.push(s(`  ✓ approved v${last.version}${last.changedAfter ? " · changed after" : ""}`, { tone: "ok" }));

  const c = st.counts;
  const right: Span[] = [];
  const add = (text: string, tone: Tone, bold = false) => right.push(...(right.length ? [s(" · ", { tone: "muted" })] : []), s(text, { tone, bold }));
  if (!d.online) add("● offline · retrying", "bad", true);
  if (c.needsReviewer) add(`${c.needsReviewer} your turn`, "accent", true);
  if (c.unread) add(`${c.unread} unread`, "accent");
  if (d.drafts.length) add(`${d.drafts.length} draft${d.drafts.length === 1 ? "" : "s"}`, "warn");
  if (!right.length) add(`${c.open} open`, "muted");
  right.push(s(" "));
  return { spans: spread(left, right, w) };
}

export interface Toast {
  text: string;
  tone: "info" | "error";
}

/** The bottom line: a toast while one shows, else the keys that may follow a prefix, else the page's keys. */
export function footerLine(w: number, opts: { toast: Toast | null; prefix: string | null; next: { key: string; desc: string }[]; hints: string[] }): Line {
  if (opts.toast) return { spans: clip([s(` ${opts.toast.text}`, { tone: opts.toast.tone === "error" ? "bad" : "ok", bold: opts.toast.tone === "error" })], w) };
  if (opts.prefix) {
    const spans: Span[] = [s(` ${opts.prefix} `, { bold: true, tone: "accent" })];
    for (const k of opts.next) spans.push(s(`${k.key} `, { bold: true }), s(`${k.desc}  `, { tone: "muted" }));
    return { spans: clip(spans, w) };
  }
  const spans: Span[] = [s(" ")];
  let used = 1;
  for (const h of opts.hints) {
    const add = width(h) + 3;
    if (used + add > w) break;
    const sp = h.indexOf(" ");
    spans.push(s(h.slice(0, sp), { bold: true }), s(`${h.slice(sp)}   `, { tone: "muted" }));
    used += add;
  }
  return { spans };
}
