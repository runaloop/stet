import { useEffect, useState } from "preact/hooks";
import { commitPicker, commitRef, commits, commitSubject, loadCommits, rowOf } from "../commits.ts";
import { link, status } from "../state.ts";
import { ago } from "./Bits.tsx";

/** Consecutive versions of one commit as one tag ("v39–v46+"): an agent can stack a dozen on one commit. */
function versionRuns(vs: { number: number; exact: boolean }[]): { from: number; to: number; exact: boolean }[] {
  const runs: { from: number; to: number; exact: boolean }[] = [];
  for (const v of vs) {
    const last = runs[runs.length - 1];
    if (last && last.exact === v.exact && v.number === last.to + 1) last.to = v.number;
    else runs.push({ from: v.number, to: v.number, exact: v.exact });
  }
  return runs;
}

/**
 * Commits of the branch, newest first, with "now" (not committed yet) on top. The range is inclusive, as in
 * GitHub: "first" is the oldest commit to show, "last" the newest; the compare runs from the parent of "first".
 * The words differ from the strip's from / to on purpose: those are the two sides of the diff (code states).
 */
export function CommitPicker(props: { from: string; to: string; fromSha: string | null; toSha: string | null; onPick: (from: string, to: string) => void }) {
  const { from, to, onPick } = props;
  const data = commits.value;
  const [typed, setTyped] = useState("");
  useEffect(() => void loadCommits(), []);
  const list = data?.commits ?? [];
  const source = status.value?.review.source === "index" ? "staged changes" : "working tree";
  // Row -1 is "now"; null means the end is not in the list (a version snapshot, an older commit).
  const at = (ref: string, sha: string | null) => {
    const row = rowOf(ref);
    if (row !== null) return row;
    const i = sha ? list.findIndex((c) => c.sha === sha) : -1;
    return i >= 0 ? i : null;
  };
  const toRow = to === "now" ? -1 : at(to, props.toSha);
  const fromState = from === "now" ? null : at(from, props.fromSha);
  const fromRow = fromState === null ? null : fromState - 1;
  const stateOf = (i: number) => (i === -1 ? "now" : commitRef(list[i]!.sha));
  const stateBefore = (i: number) => {
    const parent = i === -1 ? list[0]?.sha : list[i]!.parent;
    return parent ? commitRef(parent) : "empty";
  };
  const pick = (end: "from" | "to", i: number) => {
    let f = from;
    let t = to;
    if (end === "from") {
      f = stateBefore(i);
      if (toRow !== null && toRow > i) t = stateOf(i);
    } else {
      t = stateOf(i);
      if (fromRow !== null && fromRow < i) f = stateBefore(i);
    }
    if (f !== t) onPick(f, t);
  };
  const shown = (i: number) => toRow !== null && fromRow !== null && toRow <= i && i <= fromRow;
  const ends = (i: number) => (
    <>
      <button class={`end${fromRow === i ? " on" : ""}`} title={i === -1 ? "show only what is not committed yet" : "the oldest commit to show"} onClick={() => pick("from", i)}>first</button>
      <button class={`end${toRow === i ? " on" : ""}`} title={i === -1 ? "show up to what is not committed yet" : "the newest commit to show"} onClick={() => pick("to", i)}>last</button>
    </>
  );
  const firstMain = list.findIndex((c) => !c.onBranch);
  return (
    <div class="commit-picker">
      <div class="commit-head">
        <b>Commits of {status.value?.review.branch ?? "the branch"}</b>
        <span class="hint">“first” and “last” commit to show, both included · a click on a message shows that commit alone</span>
        <span class="spacer" />
        <input
          class="commit-range"
          placeholder="or any range: main..HEAD, a1b2c3d..e4f5a6b"
          title="git revisions: the diff runs from the first to the second, as in git diff A B"
          value={typed}
          onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const m = /^\s*(\S+?)\s*\.\.\.?\s*(\S+)\s*$/.exec(typed);
            if (m) onPick(m[1]!, m[2]!);
          }}
        />
        <button class="btn ghost small" title="close (Esc)" onClick={() => (commitPicker.value = false)}>✕</button>
      </div>
      {!data ? (
        <div class="note subtle">loading…</div>
      ) : (
        <ol class="commit-list">
          <li class={`commit-row now${shown(-1) ? " in" : ""}`}>
            {ends(-1)}
            <span class="commit-msg"><code class="sha">now</code> <span class="subject">not committed yet: the {source}</span></span>
          </li>
          {list.map((c, i) => {
            const ref = commitRef(c.sha);
            const before = stateBefore(i);
            return (
              <>
                {i === firstMain ? <li class="commit-sep">↓ already in {data.forkRef}: the branch starts above this line</li> : null}
                <li class={`commit-row${shown(i) ? " in" : ""}${c.onBranch ? "" : " main"}`}>
                  {ends(i)}
                  <a class="commit-msg" title={`${c.sha}\n${c.subject}\n\nshow this commit alone`} {...link({ name: "compare", from: before, to: ref }, () => onPick(before, ref))}>
                    <code class="sha">{c.sha.slice(0, 8)}</code> <span class="subject">{commitSubject(c)}</span>
                  </a>
                  <span class="commit-meta">
                    {versionRuns(c.versions).map((r) => {
                      const name = r.to > r.from ? `v${r.from}–v${r.to}` : `v${r.from}`;
                      const many = r.to > r.from;
                      return (
                        <span class="vtag" title={r.exact ? `${name} ${many ? "are" : "is"} this commit` : `${name} ${many ? "were" : "was"} taken on top of this commit, with the ${source}`}>
                          {name}{r.exact ? "" : "+"}
                        </span>
                      );
                    })}
                    {c.author} · {ago(c.date)}
                  </span>
                </li>
              </>
            );
          })}
          {data.more ? <li class="commit-sep">older commits are not listed: type a range above</li> : null}
        </ol>
      )}
    </div>
  );
}
