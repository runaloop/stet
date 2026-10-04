import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { markReviewed, nowDirty, presets, reviewedCursor, reviewedRef, status, tipRef, versions } from "../state.ts";
import { ago, revealRange } from "./Bits.tsx";
import { commitAt, commitOf, commits, commitSubject, isSha } from "../commits.ts";
import { picker } from "../keys.ts";
import { foldRuns, keptSteps } from "../lib/versions.ts";

export interface StripStep {
  ref: string;
  label: string;
  sub: string;
  title: string;
  kind: "base" | "version" | "pass" | "now";
}

export function stripSteps(from: string, to: string): StripStep[] {
  const s = status.value;
  const vs = versions.value;
  const n = vs.length;
  const out: StripStep[] = [{ ref: "base", label: "base", sub: s?.review.baseRef ?? "start", title: "where the branch started", kind: "base" }];
  for (const v of vs) {
    out.push({
      ref: String(v.number),
      label: `v${v.number}`,
      sub: `${ago(v.createdAt)}${v.files !== null && v.files !== undefined ? ` · ${v.files} file${v.files === 1 ? "" : "s"}` : ""}`,
      title: `v${v.number}${v.label ? `: ${v.label}` : ""} · by ${v.author} (${v.role}) · ${v.createdAt.replace("T", " ").slice(0, 16)}`,
      kind: "version",
    });
  }
  const passes = [...new Set([from, to, reviewedRef() ?? ""].filter(isSha))];
  for (const sha of passes) {
    const mine = reviewedCursor.value?.sha === sha;
    const commit = mine ? null : commitOf(sha);
    out.push({ ref: sha, label: mine ? "last pass" : sha.slice(0, 8), sub: mine ? ago(reviewedCursor.value!.at) : commit ? "commit" : "snapshot", title: mine ? "the code as it was when you last marked it as gone through" : commit ? `${sha}\n${commit.subject}` : sha, kind: "pass" });
  }
  const files = s?.now?.files;
  out.push({
    ref: "now",
    label: "now",
    sub: nowDirty.value ? (n ? `${files ?? "?"} file${files === 1 ? "" : "s"} after v${n}` : "working tree") : `= v${n}`,
    title: nowDirty.value ? "the working tree: changed after the latest version, not saved as a version yet" : `the working tree is the same as v${n}`,
    kind: "now",
  });
  return out;
}

export function refLabel(ref: string): string {
  if (ref === "base" || ref === "now") return ref;
  if (/^\d+$/.test(ref)) return `v${ref}`;
  return reviewedCursor.value?.sha === ref ? "your last pass" : ref.slice(0, 8);
}

export function rangeTitle(from: string, to: string): string {
  const n = versions.value.length;
  const f = refLabel(from);
  const t = refLabel(to);
  if (from === reviewedRef() && to === tipRef()) return `Since you last looked (${f} → ${t})`;
  if (to === "now" && from === String(n) && nowDirty.value) return `Changes after v${n}, not saved as a version yet`;
  if (from === "base") return to === tipRef() ? `The whole branch (base → ${t})` : `The branch up to ${t}`;
  const prev = /^\d+$/.test(to) ? (Number(to) === 1 ? "base" : String(Number(to) - 1)) : null;
  if (prev === from) {
    const v = versions.value.find((x) => String(x.number) === to);
    return `What changed in ${t}${v?.role === "agent" ? ", the agent's version" : ""} (${f} → ${t})`;
  }
  const list = commits.value?.commits ?? [];
  const fc = commitAt(from);
  const tc = to === "now" ? null : commitAt(to);
  if (fc && (tc || to === "now")) {
    const oldest = list.indexOf(fc) - 1;
    const n = tc ? oldest - list.indexOf(tc) + 1 : 0;
    const sha = (i: number) => list[i]!.sha.slice(0, 8);
    if (tc && n === 1) return `Commit ${sha(oldest)}: ${commitSubject(tc, 80)}`;
    if (tc && n > 1) return `${n} commits: ${sha(oldest)} … ${sha(list.indexOf(tc))}`;
    const pending = status.value?.review.source === "index" ? "staged, not committed yet" : "not committed yet";
    if (!tc && oldest === -1) return `Changes ${pending} (on top of ${fc.sha.slice(0, 8)})`;
    if (!tc && oldest >= 0) return `${oldest + 1} commit${oldest ? "s" : ""} and the changes ${pending}: ${sha(oldest)} … now`;
  }
  return `Changes from ${f} to ${t}`;
}

/**
 * The code as it was at each step, oldest first. The diff runs from the "from" step to the "to" step: the
 * buttons under a step set one end exactly, a click on the step shows what changed in it, a drag sets both.
 * Versions far from the range fold into one step ("v1…v38"); a click on it shows them.
 */
export function VersionStrip({ from, to, onPick }: { from: string; to: string; onPick: (from: string, to: string) => void }) {
  const steps = stripSteps(from, to);
  const fi = steps.findIndex((s) => s.ref === from);
  const ti = steps.findIndex((s) => s.ref === to);
  const last = steps.length - 1;
  const down = useRef<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const reviewed = reviewedCursor.value;
  const n = versions.value.length;
  useLayoutEffect(() => revealRange(list.current, ".vstep.from", ".vstep.to"), [from, to, steps.length]);
  useEffect(() => setShown(new Set()), [from, to]);
  const mine = (s: StripStep) => !!reviewed && ((reviewed.version !== null && s.ref === String(reviewed.version)) || s.ref === reviewed.sha);
  const keep = keptSteps(steps, [fi, ti, steps.findIndex(mine)]);
  const items = foldRuns(steps.length, (i) => keep.has(i) || shown.has(steps[i]!.ref));
  const inRange = (i: number) => fi !== -1 && ti !== -1 && i >= Math.min(fi, ti) && i <= Math.max(fi, ti);
  const setEnd = (end: "from" | "to", i: number) => {
    if (end === "from") onPick(steps[i]!.ref, ti !== -1 && ti <= i ? steps[i + 1]!.ref : to);
    else onPick(fi !== -1 && fi >= i ? steps[i - 1]!.ref : from, steps[i]!.ref);
  };
  const alone = (i: number) => {
    const s = steps[i]!;
    if (s.kind === "base") onPick("base", to);
    else if (s.kind === "now") onPick(n ? String(n) : "base", "now");
    else if (s.kind === "version") onPick(Number(s.ref) > 1 ? String(Number(s.ref) - 1) : "base", s.ref);
    else onPick(steps[i - 1]!.ref, s.ref);
  };
  return (
    <ol class="vstrip" ref={list} aria-label="versions: from / to under a step set that end of the diff, a click on a step shows what changed in it, a drag picks both ends">
      {items.map((item) => {
        if (item.kind === "fold") {
          const a = steps[item.from]!;
          const b = steps[item.to]!;
          const count = item.to - item.from + 1;
          return (
            <li class={`vstep fold${inRange(item.from) && inRange(item.to) ? " in" : ""}`}>
              <button
                class="vbody"
                title={`${count} versions: ${a.label} to ${b.label}. Click to show them`}
                onClick={() => setShown(new Set([...shown, ...steps.slice(item.from, item.to + 1).map((s) => s.ref)]))}
              >
                <span class="vlabel">{a.label}…{b.label}</span>
                <span class="vsub">{count} versions</span>
              </button>
              <span class="vends">
                <button class="vend" title="find a version by its number or label (Space f v)" onClick={() => (picker.value = "versions")}>
                  find…
                </button>
              </span>
            </li>
          );
        }
        const i = item.i;
        const s = steps[i]!;
        const end = i === fi ? " from" : i === ti ? " to" : "";
        return (
          <li class={`vstep ${s.kind}${inRange(i) ? " in" : ""}${end}`}>
            <button
              class="vbody"
              title={`${s.title}\n\n${s.kind === "base" ? "click: from the start of the branch" : `click: only what changed in ${s.label}`} · drag to another step: that range`}
              onPointerDown={() => (down.current = i)}
              onPointerUp={() => {
                const start = down.current;
                down.current = null;
                if (start !== null && start !== i) onPick(steps[Math.min(start, i)]!.ref, steps[Math.max(start, i)]!.ref);
              }}
              onClick={() => alone(i)}
            >
              <span class="vlabel">{s.label}{mine(s) ? <span class="seen" title="your last pass"> ✓</span> : null}</span>
              <span class="vsub">{s.sub}</span>
            </button>
            <span class="vends">
              <button class={`vend${i === fi ? " on" : ""}`} disabled={i === last} title={`the diff starts at ${s.label}: its code is the old side`} onClick={() => setEnd("from", i)}>
                from
              </button>
              <button class={`vend${i === ti ? " on" : ""}`} disabled={i === 0} title={`the diff ends at ${s.label}: its code is the new side`} onClick={() => setEnd("to", i)}>
                to
              </button>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Presets({ from, to, onPick }: { from: string; to: string; onPick: (from: string, to: string) => void }) {
  return (
    <span class="presets">
      {presets().map((p) => (
        <button class={`chip${p.from === from && p.to === to ? " on" : ""}`} onClick={() => onPick(p.from, p.to)}>{p.label}</button>
      ))}
    </span>
  );
}

export function ReviewedButton({ to, toSha, allViewed }: { to: string; toSha: string | null; allViewed: boolean }) {
  const r = reviewedCursor.value;
  const n = versions.value.length;
  const same = !!r && (r.sha === toSha || (r.version !== null && ((/^\d+$/.test(to) && r.version === Number(to)) || (to === "now" && !nowDirty.value && r.version === n))));
  if (same) return <span class="reviewed-mark" title={`remembered ${ago(r!.at)}`}>✓ you went through {refLabel(to)}</span>;
  if (to === "base") return null;
  return (
    <button class={`btn small${allViewed ? " primary" : ""}`} title="remember this as your last pass: next time “since I last looked” starts here" onClick={() => void markReviewed(to)}>
      ✓ Done up to {refLabel(to)}
    </button>
  );
}
