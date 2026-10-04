import type { ThreadSummary } from "../../src/core/types.ts";
import { Badge, ThreadBadges, whereText } from "../components/Bits.tsx";
import { lineOf } from "../lib/tree.ts";
import { currentThreadId, filters, groups, link, setFilters, threads, versions } from "../state.ts";

function ThreadRow({ t, active }: { t: ThreadSummary; active: boolean }) {
  return (
    <li class={`thread-row${active ? " active" : ""}${t.unread ? " unread" : ""}${t.status === "resolved" ? " resolved" : ""}`}>
      <a {...link({ name: "thread", id: t.id })}>
        <div class="row-top">
          <span class={`dot${t.unread ? " on" : ""}`} title={t.unread ? "new since you last looked" : ""} />
          <span class="tid">{t.status === "resolved" ? <span class="check" title="resolved">✓</span> : null}#{t.id}</span>
          <span class="line">{whereText(t)}</span>
          <ThreadBadges t={t} />
          <span class="count" title="comments">{t.commentCount}</span>
        </div>
        <div class="row-title">{t.title}</div>
        {t.last && t.commentCount > 1 ? (
          <div class="row-last">
            ↳ <b>{t.last.name}</b>
            {t.last.intent ? <Badge tone="muted">{t.last.intent}</Badge> : null} {t.last.preview}
          </div>
        ) : null}
      </a>
    </li>
  );
}

function FilterBar() {
  const f = filters.value;
  const all = threads.value;
  const counts = {
    open: all.filter((t) => t.status === "open" && !t.draft).length,
    unread: all.filter((t) => t.unread).length,
  };
  return (
    <div class="filters">
      <div class="seg" role="group" aria-label="status">
        {(["open", "resolved", "all"] as const).map((s) => (
          <button class={f.status === s ? "on" : ""} onClick={() => setFilters({ status: s })}>
            {s}
            {s === "open" ? ` ${counts.open}` : ""}
          </button>
        ))}
      </div>
      <label class="toggle" title="only threads with comments you have not seen (n / N to step through them)">
        <input type="checkbox" checked={f.newOnly} onChange={(e) => { (e.target as HTMLElement).blur(); setFilters({ newOnly: (e.target as HTMLInputElement).checked }); }} />
        new {counts.unread ? <Badge tone="accent">{counts.unread}</Badge> : null}
      </label>
      <select value={f.state} onChange={(e) => { (e.target as HTMLElement).blur(); setFilters({ state: (e.target as HTMLSelectElement).value as typeof f.state }); }} title="where the commented code is now">
        <option value="">any state</option>
        <option value="changed">changed</option>
        <option value="outdated">outdated</option>
        <option value="moved">moved</option>
        <option value="ok">unchanged</option>
      </select>
      <select
        value={f.version === null ? "" : String(f.version)}
        onChange={(e) => {
          (e.target as HTMLElement).blur();
          const v = (e.target as HTMLSelectElement).value;
          setFilters({ version: v ? Number(v) : null });
        }}
        title="version the thread was written on"
      >
        <option value="">any version</option>
        {versions.value.map((v) => <option value={v.number}>written on v{v.number}</option>)}
      </select>
      <input
        id="file-filter"
        type="search"
        placeholder="file or glob  (/)"
        value={f.file}
        onInput={(e) => setFilters({ file: (e.target as HTMLInputElement).value })}
      />
    </div>
  );
}

export function ThreadTree() {
  const gs = groups.value;
  const active = currentThreadId.value;
  return (
    <div class="tree">
      <FilterBar />
      {gs.length === 0 ? (
        <div class="empty">{threads.value.length ? "No threads match the filters." : "No threads yet. Open a compare (v) and select lines to comment."}</div>
      ) : (
        gs.map((g) => (
          <section class="file-group" key={g.path}>
            <h3 title={g.path}>
              <span class="file-dir">{g.path.includes("/") ? g.path.slice(0, g.path.lastIndexOf("/") + 1) : ""}</span>
              <span class="file-name">{g.path.split("/").pop()}</span>
              <span class="file-count">{g.threads.length}</span>
            </h3>
            <ul>{g.threads.sort((a, b) => lineOf(a) - lineOf(b)).map((t) => <ThreadRow key={t.id} t={t} active={t.id === active} />)}</ul>
          </section>
        ))
      )}
    </div>
  );
}
