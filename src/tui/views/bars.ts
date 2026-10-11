import type { GitStateDto } from "../../core/types.ts";
import { gitSummary } from "../../ui/gitmarks.ts";
import { moved, type Data } from "../model.ts";
import { clip, filled, key, s, spread, type Cls, type Line, type Span } from "../text.ts";

export type Tab = "round" | "changes" | "drafts";

function tabs(d: Data, tab: Tab, narrow: boolean): Span[] {
  const turn = d.status?.counts.needsReviewer ?? 0;
  const one = (id: Tab, name: string) => (id === tab ? s(` ${name} `, "tab") : s(` ${name} `));
  const out = [one("round", `Round${turn ? ` ${turn}` : ""}`), s(" "), one("changes", "Changes"), s(" "), one("drafts", `Drafts${d.drafts.length ? ` ${d.drafts.length}` : ""}`)];
  return narrow ? out : [...out, s("  "), key("?"), s(" ")];
}

/** The top line: the branch and its git state, the versions with the one shown lit, "now"; the tabs on the right. */
export function headerLine(d: Data, git: GitStateDto | null, tab: Tab, w: number, connecting: string | null): Line {
  const narrow = w < 100;
  const st = d.status;
  if (!st) return filled(["hdr"], ...spread([s("stet", "b"), s(`  ${connecting ?? "loading…"}`, "dim")], [], w));
  const branch = narrow ? st.review.branch.slice(st.review.branch.lastIndexOf("/") + 1) : st.review.branch;
  const left: Span[] = [s("stet", "b"), s(narrow ? " " : "  "), s(branch, "b")];
  if (st.review.source === "index") left.push(s(" staged", "mod"));
  if (git && !narrow) {
    const parts = gitSummary(git, st.review.source === "index");
    if (parts.length) left.push(s("  "), s(parts.map((p) => p.text).join(" · "), "mod"));
  }
  const n = st.versions;
  left.push(s("  "));
  if (n === 0) left.push(s("no version yet", "dim"));
  else if (narrow) left.push(s(` v${n} `, "chips"));
  else {
    for (let i = 1; i <= n; i++) left.push(s(` v${i} `, i === n ? "chips" : "chip"), s(" "));
    left.push(st.now?.changedSinceLatest ? s(`now: ${st.now.files ?? "?"} file${st.now.files === 1 ? "" : "s"} after v${n}`, "mod") : s(`now = v${n}`, "dim"));
  }
  const m = moved(d);
  if (m !== null) left.push(s(`  ↻ ${m ? `${m} file${m === 1 ? "" : "s"} changed` : "now changed"} (R)`, "warn"));
  const last = st.lastSubmission;
  if (last?.verdict === "approved" && last.version !== null && !narrow) left.push(s(`  ✓ approved v${last.version}${last.changedAfter ? " · changed after" : ""}`, "ok"));
  if (!d.online) left.push(s("  ● offline · retrying", "bad"));
  return filled(["hdr"], ...spread(left, tabs(d, tab, narrow), w));
}

/** The line under the header when a version came that you have not looked at. */
export function bannerLine(version: number, w: number): Line {
  return filled(["info"], ...clip([s(` The agent handed over v${version}.  `), key("Space r v"), s(" shows what changed since you last looked.")], w));
}

/** A footer hint: its keys, then what they do. */
export type Hint = [...keys: string[], desc: string];

export interface Toast {
  text: string;
  tone: "info" | "error";
}

/** The bottom line: the focused column's name, then its keys; a toast takes the keys' place. */
export function footerLine(w: number, o: { chip: string | null; hints: Hint[]; toast: Toast | null }): Line {
  const spans: Span[] = [s(" ")];
  if (o.chip) spans.push(s(o.chip, "fk"), s("  "));
  if (o.toast) spans.push(s(o.toast.text, (o.toast.tone === "error" ? "bad" : "ok") as Cls));
  else {
    for (const h of o.hints) {
      const keys = h.slice(0, -1) as string[];
      keys.forEach((k, i) => spans.push(...(i ? [s(" ")] : []), key(k)));
      spans.push(s(`${keys.length ? " " : ""}${h[h.length - 1]}  `));
    }
  }
  return filled(["ftr"], ...clip(spans, w));
}
