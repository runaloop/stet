import { useMemo } from "preact/hooks";
import { Kbd } from "../components/Bits.tsx";
import { FileView } from "../components/Code.tsx";
import { ImagePane } from "../components/ImageView.tsx";
import { isPixelImage } from "../../src/core/image.ts";
import { hi, lo, NewHereBox, useNewThread } from "../components/NewThread.tsx";
import { ThreadMini } from "../components/ThreadMini.tsx";
import { useBlob } from "../components/useBlob.ts";
import { usePlacements } from "../components/usePlacements.ts";
import { currentGrepHit, grepHits, hoverThread, onThreadPage, peek, type Peek } from "../compare.ts";
import { threads, wrap } from "../state.ts";

function PeekBody({ p }: { p: Peek }) {
  const blob = useBlob(p.sha, p.path);
  const here = useNewThread("peek");
  const hits = grepHits.value;
  const cur = currentGrepHit.value;
  const mine = here.pending && here.pending.path === p.path && here.pending.sha === p.sha ? here.pending : null;
  const placed = usePlacements(p.sha, p.path);
  const hover = hoverThread.value;
  const marks = useMemo(
    () => [
      ...placed.map((t) => ({ side: "additions" as const, start: t.range.start, end: t.range.end, tag: t.threadId === hover ? "focus" : "thread" })),
      ...hits
        .filter((h) => h.path === p.path)
        .map((h) => ({ side: "additions" as const, start: h.line, end: h.line, tag: "hit", ranges: h.ranges, current: h === cur })),
    ],
    [hits, cur, p.path, placed, hover],
  );
  type Anno = { kind: "thread" | "new"; id: number; state: string };
  const annotations = useMemo(
    (): { lineNumber: number; metadata: Anno }[] => [
      ...placed.map((t) => ({ lineNumber: t.range.end, metadata: { kind: "thread" as const, id: t.threadId, state: t.state } })),
      ...(mine ? [{ lineNumber: mine.end, metadata: { kind: "new" as const, id: 0, state: "" } }] : []),
    ],
    [placed, mine?.start, mine?.end],
  );
  const selected = useMemo(() => (mine ? { start: mine.start, end: mine.end } : null), [mine?.start, mine?.end]);
  const file = useMemo(() => (blob && blob !== "loading" && blob.contents !== null ? { name: p.path, contents: blob.contents } : null), [blob]);
  const focus = useMemo(() => ({ line: p.line }), [p.line, p.path]);
  if (isPixelImage(p.path)) {
    const frames = placed.flatMap((x) => {
      const t = threads.value.find((y) => y.id === x.threadId);
      return t?.region ? [{ id: t.id, region: t.region, tone: "thread" as const }] : [];
    });
    return (
      <div class="image-anno">
        <ImagePane sha={p.sha} path={p.path} label={p.label} frames={frames} />
      </div>
    );
  }
  if (blob === "loading") return <div class="note">loading…</div>;
  if (!file) return <div class="note">{p.path} is not a text file at {p.label}.</div>;
  return (
    <FileView
      file={file}
      wrap={wrap.value}
      marks={marks}
      selected={selected}
      annotations={annotations}
      renderAnnotation={(a) => (a.metadata.kind === "thread" ? <ThreadMini id={a.metadata.id} state={a.metadata.state} /> : mine ? <NewHereBox here={here} p={mine} /> : null)}
      onSelect={(r) => r && here.start({ path: p.path, side: "new", sha: p.sha, label: p.label, start: lo(r), end: hi(r), diffSide: null })}
      focus={focus}
    />
  );
}

export function PeekView() {
  const p = peek.value;
  if (!p) return null;
  return (
    <div class="peek">
      <div class="peek-head">
        <b class="path">{p.path}</b>
        <span class="subtle">
          at {p.label} · line {p.line}{onThreadPage.value ? "" : " is outside this diff"}
        </span>
        <span class="spacer" />
        <span class="hint">
          {onThreadPage.value ? "select lines to quote them in your reply or start a thread" : "select lines to comment"} · <Kbd>Esc</Kbd> {onThreadPage.value ? "back to the thread's code" : "back to the diff"}
        </span>
        <button class="btn ghost small" onClick={() => (peek.value = null)}>close</button>
      </div>
      <PeekBody key={`${p.sha}:${p.path}`} p={p} />
    </div>
  );
}
