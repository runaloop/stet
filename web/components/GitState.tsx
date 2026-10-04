import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import type { GitFileDto } from "../../src/core/types.ts";
import { compareData } from "../compare.ts";
import { fileMarks, gitSummary, type Mark } from "../lib/gitmarks.ts";
import { gitFiles, gitInfo, link, status } from "../state.ts";

export const gitOpen = signal(false);

const SHOWN = 200;

export function Marks({ marks }: { marks: Mark[] }) {
  return (
    <>
      {marks.map((m) => (
        <span class={`gmark gmark-${m.tone}`} title={m.title}>
          {m.text}
        </span>
      ))}
    </>
  );
}

export function FileGitMarks({ path }: { path: string }) {
  return <Marks marks={fileMarks(gitFiles.value.get(path), status.value?.review.source === "index")} />;
}

/** Pushed or not, staged or not: a short line in the header; a click lists the files. */
export function GitChip() {
  const g = gitInfo.value;
  if (!g) return null;
  const parts = gitSummary(g, status.value?.review.source === "index");
  return (
    <button class={`gitchip${gitOpen.value ? " on" : ""}`} title="where the branch is in git: pushed or not, what is staged, not staged or new (Space g s)" onClick={() => (gitOpen.value = !gitOpen.value)}>
      {parts.map((m, i) => (
        <>
          {i ? <span class="sep">·</span> : null}
          <span class={`gpart gpart-${m.tone}`} title={m.title}>{m.text}</span>
        </>
      ))}
    </button>
  );
}

function FileItem({ f }: { f: GitFileDto }) {
  const d = compareData.value;
  const inDiff = !!d?.files.some((x) => x.path === f.path);
  return (
    <li>
      {inDiff ? (
        <a {...link({ name: "compare", from: d!.from.ref, to: d!.to.ref, file: f.path }, undefined)} onClickCapture={() => (gitOpen.value = false)}>
          {f.path}
        </a>
      ) : (
        <span title="not in the diff on screen">{f.path}</span>
      )}{" "}
      <Marks marks={fileMarks(f, status.value?.review.source === "index").filter((m) => m.text === "↑" || m.text === "partly staged")} />
    </li>
  );
}

function Section({ title, files, note }: { title: string; files: GitFileDto[]; note?: string }) {
  if (files.length === 0) return null;
  return (
    <section>
      <h4>
        {title} <span class="subtle">({files.length})</span>
      </h4>
      {note ? <p class="subtle">{note}</p> : null}
      <ul>
        {files.slice(0, SHOWN).map((f) => <FileItem f={f} />)}
        {files.length > SHOWN ? <li class="subtle">… and {files.length - SHOWN} more</li> : null}
      </ul>
    </section>
  );
}

export function GitPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const open = gitOpen.value;
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      gitOpen.value = false;
    };
    const click = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest?.(".gitchip")) gitOpen.value = false;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("mousedown", click, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("mousedown", click, true);
    };
  }, [open]);
  const g = gitInfo.value;
  if (!open || !g) return null;
  const indexOnly = status.value?.review.source === "index";
  const files = g.files;
  const conflicts = files.filter((f) => f.conflict);
  const staged = files.filter((f) => !f.conflict && !f.untracked && f.staged);
  const unstaged = files.filter((f) => !f.conflict && !f.untracked && f.unstaged);
  const untracked = files.filter((f) => f.untracked);
  const pushedOnly = files.filter((f) => f.unpushed && !f.staged && !f.unstaged && !f.untracked && !f.conflict);
  const chip = document.querySelector(".gitchip")?.getBoundingClientRect();
  const at = chip ? `top: ${Math.round(chip.bottom + 4)}px; left: ${Math.round(Math.max(8, Math.min(chip.left, window.innerWidth - 576)))}px` : "top: 44px; left: 16px";
  return (
    <div class="git-panel" ref={ref} style={at} role="dialog" aria-label="git state">
      <div class="gp-head">
        <b class="mono">{g.branch}</b>{" "}
        {g.upstream ? (
          <>
            → <span class="mono">{g.upstream}</span>
            {g.tracking ? null : <span class="subtle"> (same name; no upstream set)</span>}
          </>
        ) : (
          <span class="subtle">is on no remote</span>
        )}
        <div class="gp-summary">
          <Marks marks={gitSummary(g, indexOnly)} />
        </div>
        {g.worktree ? <div class="subtle mono gp-where" title="the worktree that holds the branch: “now” is read from it">{g.worktree}</div> : <div class="subtle">no worktree holds the branch: “now” is its last commit</div>}
        {g.detached ? <div class="subtle">The worktree's HEAD is detached: what is committed there may not be on {g.branch} yet.</div> : null}
      </div>
      {g.unpushed.length ? (
        <section>
          <h4>
            {g.upstream ? "Commits not pushed" : "Commits since the base, on no remote"} <span class="subtle">({g.ahead})</span>
          </h4>
          <ul>
            {g.unpushed.map((c) => (
              <li>
                <code>{c.sha.slice(0, 8)}</code> {c.subject}
              </li>
            ))}
            {g.ahead > g.unpushed.length ? <li class="subtle">… and {g.ahead - g.unpushed.length} more</li> : null}
          </ul>
        </section>
      ) : null}
      <Section title="Conflicts" files={conflicts} />
      <Section title="Staged, not committed" files={staged} />
      <Section
        title={indexOnly ? "Not staged: not in this review" : "Not staged"}
        files={unstaged}
        note={indexOnly ? "The review reads the index. Changes that are not staged (git add) are not in “now” and not in versions." : undefined}
      />
      <Section title={indexOnly ? "New, not in git: not in this review" : "New, not in git"} files={untracked} />
      <Section title="Committed, not pushed" files={pushedOnly} />
      {g.truncated ? <p class="subtle">The list stops at {files.length} files.</p> : null}
      {files.length === 0 && !g.unpushed.length ? <p class="subtle">Nothing to commit: the worktree is clean.</p> : null}
      <p class="subtle gp-foot">Checked every few seconds while this page is open. Remote branches are as of the last fetch or push.</p>
    </div>
  );
}
