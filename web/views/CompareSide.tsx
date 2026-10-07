import type { ComponentChild } from "preact";
import { isPixelImage } from "../../src/core/image.ts";
import { useEffect, useRef } from "preact/hooks";
import { Kbd } from "../components/Bits.tsx";
import { FileGitMarks } from "../components/GitState.tsx";
import { showFileInGuide } from "../components/Guide.tsx";
import {
  activeFile,
  compareData,
  compareNav,
  currentGrepHit,
  currentHit,
  goToGrepHit,
  grepHits,
  grepLoading,
  grepSorted,
  peek,
  searchScope,
  scope as effectiveScope,
  searchAt,
  onThreadPage,
  type GrepHit,
  fileRows,
  goToHit,
  isViewed,
  searchFocus,
  searchHits,
  searchInput,
  searchRegex,
  searchResult,
  setViewed,
  sideTab,
  stepHit,
  type FileRow,
  type SideTab,
  cursorSpace,
  guideShown,
  setCursor,
} from "../compare.ts";
import { guideFile } from "../guide.ts";
import { diffRows, groupHits, type DiffRow, type Hit, type HitGroup } from "../lib/search.ts";
import type { GrepLineDto } from "../../src/core/types.ts";
import type { Route } from "../lib/route.ts";
import { canQuote, quoteLines } from "../quote.ts";
import { clampStep } from "../lib/timeline.ts";
import { detail, link, route, selectedStep } from "../state.ts";
import { transition } from "../transition.ts";
import { ThreadTree } from "./ThreadTree.tsx";

const split = (path: string) => {
  const i = path.lastIndexOf("/");
  return { dir: i === -1 ? "" : `\u200E${path.slice(0, i + 1)}\u200E`, name: path.slice(i + 1) };
};

function stat(row: FileRow) {
  let add = 0;
  let del = 0;
  for (const h of row.fd.hunks) {
    add += h.additionLines;
    del += h.deletionLines;
  }
  return { add, del };
}

function compareRoute(extra: { file: string; line?: number; side?: "old" | "new" }): Route | null {
  const d = compareData.value;
  return d ? { name: "compare", from: d.from.ref, to: d.to.ref, ...extra } : null;
}

function firstChange(row: FileRow): number {
  return diffRows(row.fd).find((r) => r.kind !== "context")?.new ?? row.fd.hunks[0]?.additionStart ?? 1;
}

function openFile(row: FileRow): void {
  transition();
  if (!onThreadPage.value && guideShown.value) return showFileInGuide(row.fd.name);
  if (!onThreadPage.value) {
    compareNav.current?.scrollToFile(row.fd.name);
    const space = cursorSpace.peek();
    const at = space.fileStart(space.fileIndex(row.fd.name));
    if (at) setCursor(at, false);
    return;
  }
  const to = compareData.value?.to;
  if (to) peek.value = { path: row.fd.name, sha: to.sha, label: to.label, line: firstChange(row) };
}

function FileLine({ row, active }: { row: FileRow; active: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  const { dir, name } = split(row.fd.name);
  const { add, del } = stat(row);
  const image = row.fd.hunks.length === 0 && isPixelImage(row.fd.name);
  const seen = isViewed(row.fd);
  const target = compareRoute({ file: row.fd.name });
  return (
    <li ref={ref} class={`file-row${active ? " active" : ""}${seen ? " seen" : ""}`} title={row.fd.prevName ? `${row.fd.prevName} → ${row.fd.name}` : row.fd.name}>
      <input
        type="checkbox"
        checked={seen}
        title="viewed"
        onChange={(e) => {
          setViewed(row.fd, (e.target as HTMLInputElement).checked);
          (e.target as HTMLElement).blur();
        }}
      />
      <a class="file-link" {...(target ? link(target, () => openFile(row)) : { href: "#", onClick: (e: MouseEvent) => (e.preventDefault(), openFile(row)) })}>
        <span class="file-name">{name}</span>
        <span class="file-dir">{dir}</span>
      </a>
      {row.keptBecause ? <span class="kept" title={row.keptBecause}>⚠</span> : null}
      <FileGitMarks path={row.fd.name} />
      {row.threads ? <span class="file-threads" title="threads on this diff">{row.threads} 💬</span> : null}
      <span class="stat">
        {image ? <span class="img-tag">image</span> : null}
        {add ? <span class="add">+{add}</span> : null} {del ? <span class="del">−{del}</span> : null}
      </span>
    </li>
  );
}

function FileList() {
  const rows = fileRows.value;
  const active = !onThreadPage.value && guideShown.value ? guideFile.value : activeFile.value;
  const d = compareData.value;
  if (onThreadPage.value && !d) return <div class="empty">Files of the diff you were looking at. Open the changes (<Kbd>v</Kbd>) first.</div>;
  if (rows.length === 0) return <div class="empty">No files in this diff.</div>;
  const seen = rows.filter((r) => isViewed(r.fd)).length;
  const sections: [string, FileRow[]][] = [];
  for (const r of rows) {
    if (r.section !== null || sections.length === 0) sections.push([r.section ?? "", [r]]);
    else sections[sections.length - 1]![1].push(r);
  }
  return (
    <div class="file-list">
      <div class="side-head subtle">
        {onThreadPage.value && d ? <>{d.from.label} → {d.to.label}: a click shows the file over the thread's code · </> : null}
        {rows.length} files · {seen}/{rows.length} viewed
      </div>
      {sections.map(([title, list]) =>
        list.length ? (
          <section>
            {title ? <h4>{title} ({list.length})</h4> : null}
            <ul>{list.map((r) => <FileLine key={r.fd.name} row={r} active={r.fd.name === active} />)}</ul>
          </section>
        ) : null,
      )}
    </div>
  );
}

function marked(text: string, ranges: [number, number][]): ComponentChild {
  const parts: ComponentChild[] = [];
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a >= text.length) break;
    parts.push(text.slice(pos, a), <mark>{text.slice(a, Math.min(b, text.length))}</mark>);
    pos = Math.min(b, text.length);
  }
  parts.push(text.slice(pos));
  return parts;
}

function nearest<T>(list: T[], at: number, pos: (x: T) => number): T {
  return list.reduce((a, b) => (Math.abs(pos(b) - at) < Math.abs(pos(a) - at) ? b : a));
}

/** Rows around a match are links too: a click there goes to the nearest match of the block. */
function SnipRow({ r, path, hit, current, via, onClick }: { r: DiffRow; path: string; hit?: Hit; current: boolean; via: DiffRow; onClick: () => void }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const no = r.kind === "del" ? r.old : r.new;
  const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
  const text = r.text.length > 240 ? r.text.slice(0, 240) + "…" : r.text;
  const body = (
    <>
      <span class="no">{no}</span>
      <span class="sign">{sign}</span>
      <span class="text">{hit ? marked(text, hit.ranges) : text}</span>
    </>
  );
  const old = via.kind === "del";
  const target = compareRoute({ file: path, line: (old ? via.old : via.new) ?? undefined, side: old ? "old" : "new" });
  return (
    <a ref={ref} class={`snip ${r.kind}${hit ? " match" : ""}${current ? " current" : ""}`} {...(target ? link(target, onClick) : { href: "#", onClick: (e: MouseEvent) => (e.preventDefault(), onClick()) })}>
      {body}
    </a>
  );
}

function HitBlock({ rows, path, group, cur }: { rows: DiffRow[]; path: string; group: HitGroup; cur: Hit | null }) {
  const byRow = new Map(group.hits.map((h) => [h.hit.row, h]));
  const out: ComponentChild[] = [];
  for (let i = group.from; i <= group.to; i++) {
    const h = byRow.get(i);
    const near = h ?? nearest(group.hits, i, (x) => x.hit.row);
    out.push(<SnipRow r={rows[i]!} path={path} hit={h?.hit} current={!!h && h.hit === cur} via={rows[near.hit.row]!} onClick={() => goToHit(near.index)} />);
  }
  return <div class={`hit${group.hits.some((h) => h.hit === cur) ? " current" : ""}`}>{out}</div>;
}

const SHOW_LIMIT = 300;

let focusedFor = 0;

function DiffResults() {
  const res = searchResult.value;
  const hits = searchHits.value;
  const cur = currentHit.value;
  const index = cur ? hits.indexOf(cur) : -1;
  let shown = 0;
  let offset = 0;
  return (
    <>
      <div class="side-head subtle">
        {res.error ? (
          <span class="error">{res.error}</span>
        ) : searchInput.value ? (
          <>
            {index >= 0 ? `${index + 1} of ` : ""}
            {res.total}
            {res.truncated ? "+" : ""} match{res.total === 1 ? "" : "es"} in {res.files.length} file{res.files.length === 1 ? "" : "s"}
            {res.total ? <> · <Kbd>Enter</Kbd> next · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> previous</> : null}
          </>
        ) : (
          <>Searches every line of this diff: added, removed and the context around them. Capital letters make it case-sensitive.</>
        )}
      </div>
      {res.files.map((f) => {
        const start = offset;
        offset += f.hits.length;
        if (shown >= SHOW_LIMIT) return null;
        const { dir, name } = split(f.path);
        const list = f.hits.slice(0, SHOW_LIMIT - shown);
        shown += list.length;
        return (
          <section class="hit-file">
            <h4 title={`${f.path}: go to the first match`} onClick={() => goToHit(start)}>
              <span class="file-name">{name}</span> <span class="file-dir">{dir}</span> <span class="count">{f.hits.length}</span>
            </h4>
            {groupHits(f.rows, list, start).map((g) => (
              <HitBlock rows={f.rows} path={f.path} group={g} cur={cur} />
            ))}
          </section>
        );
      })}
      {res.total > SHOW_LIMIT ? <div class="note subtle">Showing the first {SHOW_LIMIT}. Enter still steps through all of them; refine the query to narrow the list.</div> : null}
    </>
  );
}

function grepRoute(path: string, line: number): Route | null {
  if (!onThreadPage.value) return compareRoute({ file: path, line });
  const d = detail.value;
  const step = d ? d.timeline[clampStep(d, selectedStep.value)] : null;
  if (!step) return null;
  const ref = step.kind === "now" ? "now" : /^v\d+$/.test(step.label) ? step.label.slice(1) : step.sha;
  return { name: "compare", from: ref, to: ref, file: path, line };
}

function GrepRow({ path, line, hit, via, index, current }: { path: string; line: GrepLineDto; hit: GrepHit | null; via: GrepHit | null; index: number; current: boolean }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current]);
  const text = line.text.length > 240 ? line.text.slice(0, 240) + "…" : line.text;
  const body = (
    <>
      <span class="no">{line.line}</span>
      <span class="sign">{hit ? (hit.inDiff ? "±" : "↗") : " "}</span>
      <span class="text">{hit ? marked(text, hit.ranges) : text}</span>
    </>
  );
  if (!via) return <div class="snip context">{body}</div>;
  const target = grepRoute(path, via.line);
  const at = searchAt.value;
  const title = onThreadPage.value ? "show the file here, over the thread's code" : via.inDiff ? "changed in this diff: jump there" : "not part of this diff: opens the file";
  return (
    <div class="snip-row">
      <a ref={ref} class={`snip context${hit ? " match" : ""}${current ? " current" : ""}`} title={title} {...(target ? link(target, () => goToGrepHit(index)) : { href: "#", onClick: (e: MouseEvent) => (e.preventDefault(), goToGrepHit(index)) })}>
        {body}
      </a>
      {hit && canQuote() && at ? (
        <button class="quote" title="quote this line in your reply" onClick={() => void quoteLines({ path, start: line.line, end: line.line, sha: at.sha, label: at.label })}>❝</button>
      ) : null}
    </div>
  );
}

function FileResults() {
  const r = grepSorted.value;
  const hits = grepHits.value;
  const cur = currentGrepHit.value;
  const index = cur ? hits.indexOf(cur) : -1;
  const to = searchAt.value?.label ?? "this version";
  const outside = hits.filter((h) => !h.inDiff).length;
  let n = 0;
  return (
    <>
      <div class="side-head subtle">
        {r?.error ? (
          <span class="error">{r.error}</span>
        ) : grepLoading.value ? (
          "searching…"
        ) : searchInput.value.length < 2 ? (
          onThreadPage.value ? (
            <>Searches every file at {to}, the step shown next to the thread (git grep). A hit opens over the thread's code; ❝ quotes it into your reply. Select a word and press <Kbd>*</Kbd> to find where it is used.</>
          ) : (
            <>Searches every file of {to}, changed or not (git grep). ± jumps into the diff, ↗ opens a file that is not part of it.</>
          )
        ) : r ? (
          <>
            {index >= 0 ? `${index + 1} of ` : ""}
            {r.total}
            {r.truncated ? "+" : ""} match{r.total === 1 ? "" : "es"} in {r.files.length} file{r.files.length === 1 ? "" : "s"} of {to}
            {outside && !onThreadPage.value ? ` · ${outside} outside the diff` : ""}
            {r.total ? <> · <Kbd>Enter</Kbd> next</> : null}
          </>
        ) : null}
      </div>
      {r?.files.map((f) => {
        if (n >= SHOW_LIMIT) return null;
        const { dir, name } = split(f.path);
        const first = n;
        return (
          <section class="hit-file">
            <h4 title={`${f.path}: go to the first match`} onClick={() => goToGrepHit(first)}>
              <span class="file-name">{name}</span> <span class="file-dir">{dir}</span> <span class="count">{f.matches}</span>
            </h4>
            {f.groups.map((g) => {
              const matches = g.filter((l) => l.match).map((l) => ({ line: l.line, index: n++ }));
              return (
                <div class={`hit${g.some((l) => l.match && cur?.path === f.path && cur.line === l.line) ? " current" : ""}`}>
                  {g.map((l) => {
                    const m = matches.length ? (l.match ? matches.find((x) => x.line === l.line)! : nearest(matches, l.line, (x) => x.line)) : null;
                    const h = m ? (hits[m.index] ?? null) : null;
                    return <GrepRow path={f.path} line={l} hit={l.match ? h : null} via={h} index={m?.index ?? -1} current={l.match && h !== null && h === cur} />;
                  })}
                </div>
              );
            })}
          </section>
        );
      })}
      {r && r.total > SHOW_LIMIT ? <div class="note subtle">Showing about the first {SHOW_LIMIT}. Enter still steps through all of them.</div> : null}
    </>
  );
}

function SearchPanel() {
  const input = useRef<HTMLInputElement>(null);
  const wanted = searchFocus.value;
  useEffect(() => {
    if (wanted === focusedFor) return;
    focusedFor = wanted;
    input.current?.focus();
    input.current?.select();
  }, [wanted]);
  const scope = effectiveScope.value;
  const count = scope === "files" ? grepHits.value.length : searchHits.value.length;
  const at = searchAt.value?.label ?? "";
  return (
    <div class="search">
      <div class="side-head search-head">
        <input
          ref={input}
          id="diff-search"
          type="search"
          placeholder={onThreadPage.value ? `search all files at ${at}  (/ or Ctrl+F)` : scope === "files" ? "search all files  (/ or Ctrl+F)" : "search the diff  (/ or Ctrl+F)"}
          value={searchInput.value}
          onInput={(e) => (searchInput.value = (e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              stepHit(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (peek.value) peek.value = null;
              else (e.target as HTMLElement).blur();
            }
          }}
        />
        <button class={`btn ghost small${searchRegex.value ? " on" : ""}`} title="regular expression" onClick={() => (searchRegex.value = !searchRegex.value)}>.*</button>
        <button class="btn ghost small" title="previous (Shift+Enter)" disabled={!count} onClick={() => stepHit(-1)}>↑</button>
        <button class="btn ghost small" title="next (Enter)" disabled={!count} onClick={() => stepHit(1)}>↓</button>
      </div>
      {onThreadPage.value ? null : (
        <div class="side-head search-scope">
          <div class="seg">
          <button class={scope === "diff" ? "on" : ""} title="lines of this diff" onClick={() => (searchScope.value = "diff")}>in the diff</button>
          <button class={scope === "files" ? "on" : ""} title="every file of the version, changed or not" onClick={() => (searchScope.value = "files")}>in all files</button>
          </div>
        </div>
      )}
      {scope === "files" ? <FileResults /> : <DiffResults />}
    </div>
  );
}

const TABS: [SideTab, string][] = [
  ["threads", "Threads"],
  ["files", "Files"],
  ["search", "Search"],
];

export function SidePanel() {
  const tabs = route.value.name === "compare" || route.value.name === "thread";
  const tab = tabs ? sideTab.value : "threads";
  const hits = effectiveScope.value === "files" ? grepHits.value.length : searchHits.value.length;
  return (
    <div class="side">
      {tabs ? (
        <div class="side-tabs seg">
          {TABS.map(([t, label]) => (
            <button class={tab === t ? "on" : ""} onClick={() => (sideTab.value = t)}>
              {label}
              {t === "search" && hits ? ` ${hits}` : ""}
            </button>
          ))}
        </div>
      ) : null}
      {tab === "files" ? <FileList /> : tab === "search" ? <SearchPanel /> : <ThreadTree />}
    </div>
  );
}
