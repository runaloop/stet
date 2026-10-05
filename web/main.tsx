import { render } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { setToken } from "./api.ts";
import { ago, Badge, Kbd, roundTitle } from "./components/Bits.tsx";
import { ChoiceDialog } from "./components/Choice.tsx";
import { GitChip, GitPanel } from "./components/GitState.tsx";
import { Help, Pickers, WhichKey } from "./components/KeyUi.tsx";
import { Splitter, widthOf } from "./components/Splitter.tsx";
import { refLabel } from "./components/VersionStrip.tsx";
import { leftPage } from "./jumps.ts";
import { layoutPage, swapped, toggleSwap } from "./layout.ts";
import { takeToken } from "./lib/route.ts";
import { installKeys, picker } from "./keys.ts";
import {
  banner,
  boot,
  defaultCompare,
  drafts,
  fatal,
  helpOpen,
  link,
  loadDetail,
  loading,
  navigate,
  nowDirty,
  nowMoved,
  online,
  ordered,
  ownNavigation,
  parseHash,
  presets,
  refreshNow,
  reviewedCursor,
  reviewedRef,
  reviewId,
  reviews,
  route,
  status,
  switchReview,
  threads,
  tipRef,
  toast,
  versionRounds,
  versions,
} from "./state.ts";
import { onDoubleClick } from "./usages.ts";
import { CompareView } from "./views/Compare.tsx";
import { SidePanel } from "./views/CompareSide.tsx";
import { DraftsView } from "./views/Drafts.tsx";
import { ThreadDetailView } from "./views/ThreadDetail.tsx";

function readToken(): string {
  const taken = takeToken(location.hash);
  if (taken) {
    history.replaceState(null, "", location.pathname + taken.hash);
    return taken.token;
  }
  try {
    return sessionStorage.getItem("stet.token") ?? "";
  } catch {
    return "";
  }
}

interface RoundStep {
  done: boolean;
  title: string;
  body: preact.ComponentChildren;
}

function roundSteps(): RoundStep[] {
  const waiting = ordered.value.filter((t) => t.status === "open" && !t.draft && t.needsReply === "reviewer");
  const all = threads.value.filter((t) => t.status === "open" && !t.draft && t.needsReply === "reviewer");
  const first = waiting[0] ?? all[0];
  const since = presets().find((p) => p.id === "since");
  const codeDone = !!reviewedCursor.value && reviewedRef() === null;
  const start = since ?? { ...defaultCompare() };
  const n = drafts.value.length;
  return [
    {
      done: all.length === 0,
      title: "Answer the agent",
      body: all.length ? (
        <>
          {all.length} thread{all.length === 1 ? "" : "s"} wait for you: the agent replied. {first ? <a {...link({ name: "thread", id: first.id })}>Open #{first.id}</a> : null}, then <Kbd>n</Kbd> steps
          through the unread ones and <Kbd>j</Kbd> / <Kbd>k</Kbd> through all.
        </>
      ) : (
        <>No thread waits for you.</>
      ),
    },
    {
      done: codeDone,
      title: "Go through the new code",
      body: codeDone ? (
        <>You went through everything up to {reviewedCursor.value!.label}.</>
      ) : (
        <>
          {since ? <>Changed since your last pass: </> : <>No pass remembered yet. Start with </>}
          <a {...link({ name: "compare", from: start.from, to: start.to })}>
            {refLabel(start.from)} → {refLabel(start.to)}
          </a>{" "}
          (<Kbd>v</Kbd>). Mark files viewed as you go; “✓ Done up to …” (or the last file marked viewed) remembers the pass.
        </>
      ),
    },
    {
      done: n === 0,
      title: "Send your review",
      body: n ? (
        <>
          {n} draft{n === 1 ? " is" : "s are"} not sent: the agent sees nothing until you submit. <a {...link({ name: "drafts" })}>Review and submit</a> (<Kbd>S</Kbd>).
        </>
      ) : (
        <>Nothing waits to be sent.</>
      ),
    },
  ];
}

const SHOWN_VERSIONS = 6;

function Approved() {
  const last = status.value?.lastSubmission;
  if (last?.verdict !== "approved" || last.version === null) return null;
  const when = `you approved v${last.version} ${ago(last.at)}`;
  if (!last.changedAfter) return <span class="verdict" title={`${when}; the agent sees it in stet status`}>✓ approved at v{last.version}</span>;
  return (
    <a class="verdict changed" title={`${when}; the code changed after it. Click: what changed since`} {...link({ name: "compare", from: String(last.version), to: tipRef() })}>
      ✓ approved at v{last.version} · changed after
    </a>
  );
}

function Header() {
  const s = status.value;
  const r = route.value;
  const nDrafts = drafts.value.length;
  const vs = versions.value;
  const n = vs.length;
  const left = s ? roundSteps().filter((x) => !x.done).length : 0;
  const moved = nowMoved.value;
  const chips = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = chips.current;
    if (!el) return;
    const toEnd = () => (el.scrollLeft = el.scrollWidth);
    toEnd();
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n, nowDirty.value]);
  return (
    <header class="top">
      <a class="brand" title="this round: what is left to do" {...link({ name: "overview" })}>stet</a>
      {reviews.value.length > 1 ? (
        <select
          value={reviewId.value ?? ""}
          onChange={async (e) => {
            const el = e.target as HTMLSelectElement;
            el.blur();
            await switchReview(Number(el.value));
            navigate({ name: "home" });
          }}
        >
          {reviews.value.map((x) => <option value={x.id}>{x.branch}</option>)}
        </select>
      ) : (
        <span class="branch" title={s?.review.branch}>{s?.review.branch}</span>
      )}
      {s?.review.source === "index" ? <Badge tone="warn" title="versions are snapshots of the index (git add), compared with HEAD">staged</Badge> : null}
      <GitChip />
      <span class="versions" ref={chips}>
        {n > SHOWN_VERSIONS ? (
          <button class="older" title="all versions, newest first: find one by its number or label (Space f v)" onClick={() => (picker.value = "versions")}>
            v1…v{n - SHOWN_VERSIONS} ▾
          </button>
        ) : null}
        {vs.slice(-SHOWN_VERSIONS).map((v) => (
          <a
            class="ver"
            title={`what changed in v${v.number}${v.label ? `: ${v.label}` : ""} · ${v.author} · ${v.createdAt.replace("T", " ").slice(0, 16)}`}
            {...link({ name: "compare", from: v.number > 1 ? String(v.number - 1) : "base", to: String(v.number) })}
          >
            v{v.number}
          </a>
        ))}
        {n && nowDirty.value ? (
          <a class="now dirty" title="the working tree changed after the latest version and is not saved as a version yet" {...link({ name: "compare", from: String(n), to: "now" })}>
            now: {s?.now?.files ?? "?"} file{s?.now?.files === 1 ? "" : "s"} after v{n}
          </a>
        ) : (
          <span class="now" title="the working tree is the same as the latest version">{n ? `now = v${n}` : "now"}</span>
        )}
        {moved === null ? (
          <button class="refresh" title="“now” is pinned so the screen does not jump while the agent edits; R re-reads the working tree" onClick={() => void refreshNow()}>
            ↻
          </button>
        ) : (
          <button
            class="refresh moved"
            title={`the working tree changed after this page read “now”${moved ? `: ${moved} file${moved === 1 ? "" : "s"} differ` : ""}. The page does not redraw by itself; R re-reads it`}
            onClick={() => void refreshNow()}
          >
            ↻ {moved ? `${moved} file${moved === 1 ? "" : "s"} changed` : "now changed"}
          </button>
        )}
      </span>
      <Approved />
      {online.value ? null : (
        <span class="offline" title="the stet server does not answer. The page keeps trying and catches up when it is back; if it stays away, start it again with stet serve --open">
          ● offline · retrying
        </span>
      )}
      <nav>
        <a class={r.name === "overview" ? "on" : ""} title="what is left to do in this round" {...link({ name: "overview" })}>
          Round {left ? <Badge tone="accent">{left}</Badge> : <span class="done-mark">✓</span>}
        </a>
        <a class={r.name === "compare" ? "on" : ""} title="the code: what changed since you last looked" {...link({ name: "compare", ...defaultCompare() })}>
          Changes <Kbd>v</Kbd>
        </a>
        <a class={r.name === "drafts" ? "on" : ""} {...link({ name: "drafts" })}>
          Drafts {nDrafts ? <Badge tone="warn">{nDrafts}</Badge> : null} <Kbd>s</Kbd>
        </a>
        <button onClick={() => (helpOpen.value = true)} title="all keys">
          <Kbd>?</Kbd>
        </button>
      </nav>
    </header>
  );
}

function DraftBar() {
  const n = drafts.value.length;
  if (!n || route.value.name === "drafts") return null;
  return (
    <div class="draft-bar">
      <span>
        <b>{n} draft{n === 1 ? "" : "s"}</b> not sent. The agent sees them only after you submit the review.
      </span>
      <a class="btn primary small" {...link({ name: "drafts" })}>Review and submit <Kbd>S</Kbd></a>
    </div>
  );
}

function Round() {
  const s = status.value;
  if (!s) return null;
  const k = s.counts;
  const steps = roundSteps();
  return (
    <div class="home">
      <h2>This round · {s.review.branch}</h2>
      <p class="note subtle">
        base {s.review.baseRef ?? "—"} · {s.versions} versions · last event #{s.lastSeq}
      </p>
      <ol class="round">
        {steps.map((x) => (
          <li class={x.done ? "done" : "todo"}>
            <span class="tick">{x.done ? "✓" : ""}</span>
            <div>
              <b>{x.title}</b>
              <p>{x.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div class="cards">
        <div class="card"><b>{k.open}</b> open</div>
        <div class="card accent"><b>{k.needsReviewer}</b> your turn</div>
        <div class="card"><b>{k.needsAgent}</b> agent's turn</div>
        <div class="card warn"><b>{k.changed}</b> changed</div>
        <div class="card bad"><b>{k.outdated}</b> outdated</div>
        <div class="card"><b>{k.resolved}</b> resolved</div>
        <div class="card"><b>{k.unread}</b> unread</div>
        <div class="card"><b>{k.drafts}</b> drafts</div>
      </div>
      <h3>Versions</h3>
      {versionRounds.value
        .slice()
        .reverse()
        .map((round, k) => (
          <details class="round-versions" open={k < 2}>
            <summary>
              <b>{roundTitle(round)}</b> ·{" "}
              <a {...link({ name: "compare", from: round.first > 1 ? String(round.first - 1) : "base", to: String(round.last) })}>
                {round.last > round.first ? `v${round.first}–v${round.last}: what this round changed` : `v${round.first}`}
              </a>
            </summary>
            <ul class="version-list">
              {s.versionsList
                .filter((v) => v.number >= round.first && v.number <= round.last)
                .reverse()
                .map((v) => (
                  <li>
                    <a {...link({ name: "compare", from: v.number > 1 ? String(v.number - 1) : "base", to: String(v.number) })}>v{v.number}</a>{" "}
                    <span class="subtle">
                      {v.createdAt.replace("T", " ").slice(0, 16)} · {v.author}
                      {v.files !== null && v.files !== undefined ? ` · ${v.files} file${v.files === 1 ? "" : "s"}` : ""}
                    </span>{" "}
                    {v.label}
                  </li>
                ))}
            </ul>
          </details>
        ))}
      <h3>Loop</h3>
      <ol class="loop">
        <li>Open the changes (<Kbd>v</Kbd>), select lines, write drafts.</li>
        <li>Submit the review (<Kbd>S</Kbd>), then tell the agent to answer it. Or approve when all is fine; drafts then go as nits.</li>
        <li>The agent replies in each thread and hands over the next version.</li>
        <li>Step through new replies with <Kbd>n</Kbd>, check each thread's timeline with <Kbd>[</Kbd> <Kbd>]</Kbd>, resolve with <Kbd>x</Kbd>, then go through the new code.</li>
      </ol>
    </div>
  );
}

function App() {
  const aside = useRef<HTMLElement>(null);
  if (loading.value) return <div class="boot">loading…</div>;
  if (fatal.value) return <div class="boot error">{fatal.value}</div>;
  const r = route.value;
  const page = layoutPage();
  const sideKey = `side.${page}`;
  const sideW = widthOf(sideKey);
  const right = page === "compare" && swapped("compare");
  return (
    <>
      <Header />
      {banner.value ? (
        <div
          class="banner"
          onClick={async () => {
            await refreshNow();
            navigate({ name: "compare", ...defaultCompare() });
          }}
        >
          {banner.value.text}
        </div>
      ) : null}
      <DraftBar />
      <main class={right ? "side-right" : ""} style={sideW ? `--side-w: ${sideW}px` : ""}>
        <aside ref={aside}>
          <SidePanel />
        </aside>
        <Splitter
          id={sideKey}
          kind="side-splitter"
          target={() => aside.current}
          grows={right ? "left" : "right"}
          min={220}
          max={() => Math.max(260, window.innerWidth - 520)}
          swap={page === "compare" ? { title: `side panel to the ${right ? "left" : "right"} of the diff · Space u l`, run: () => toggleSwap("compare") } : undefined}
        />
        <section class="pane">
          {r.name === "thread" ? (
            <ThreadDetailView id={r.id} />
          ) : r.name === "compare" ? (
            <CompareView from={r.from} to={r.to} />
          ) : r.name === "drafts" ? (
            <DraftsView />
          ) : r.name === "overview" ? (
            <Round />
          ) : (
            <div class="empty">loading…</div>
          )}
        </section>
      </main>
      <GitPanel />
      <Help />
      <WhichKey />
      <Pickers />
      <ChoiceDialog />
      {toast.value ? (
        <div class={`toast ${toast.value.tone}`}>
          {toast.value.text}
          {toast.value.link ? <a {...link(toast.value.link.route)}>{toast.value.link.label}</a> : null}
        </div>
      ) : null}
    </>
  );
}

setToken(readToken());
route.value = parseHash(location.hash);
let currentHash = location.hash;
window.addEventListener("hashchange", () => {
  leftPage(currentHash, ownNavigation(location.hash));
  currentHash = location.hash;
  const next = parseHash(location.hash);
  if (next.review && next.review !== reviewId.value) void switchReview(next.review);
  route.value = next;
  void loadDetail();
});
installKeys();
window.addEventListener("dblclick", onDoubleClick, true);
render(<App />, document.getElementById("app")!);
void boot();
