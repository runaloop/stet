import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ThreadDetail } from "../../src/core/types.ts";
import { stateTone } from "../lib/timeline.ts";
import { foldRuns, keptTimeline } from "../lib/versions.ts";
import { rangeText, revealRange } from "./Bits.tsx";
import { RegionThumb } from "./ImageView.tsx";

/** A thread's code at each version. Runs of versions where nothing happened to it fold into one step. */
export function Timeline({ detail, selected, onSelect }: { detail: ThreadDetail; selected: number; onSelect: (i: number) => void }) {
  const list = useRef<HTMLOListElement>(null);
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const steps = detail.timeline;
  useEffect(() => setShown(new Set()), [detail.thread.id]);
  useLayoutEffect(() => revealRange(list.current, ".step.selected", ".step.selected"), [detail.thread.id, selected, steps.length, shown]);
  const keep = keptTimeline(steps, selected);
  const items = foldRuns(steps.length, (i) => keep.has(i) || shown.has(i));
  const region = detail.thread.region;
  return (
    <ol class="timeline" ref={list} aria-label="thread timeline">
      {items.map((item) => {
        if (item.kind === "fold") {
          const a = steps[item.from]!;
          const b = steps[item.to]!;
          const count = item.to - item.from + 1;
          return (
            <li key={`fold-${item.from}`} class="step fold">
              <button
                title={`${a.label} to ${b.label}: the commented code stayed the same, no messages. Click to show each version`}
                onClick={() => setShown(new Set([...shown, ...Array.from({ length: count }, (_, k) => item.from + k)]))}
              >
                <span class="step-label">{a.label}…{b.label}</span>
                <span class="step-where">{count} versions, no change</span>
              </button>
            </li>
          );
        }
        const s = steps[item.i]!;
        const tone = s.index === 0 ? "ok" : stateTone(s.state);
        const comments = s.commentIds.length;
        return (
          <li key={s.index} class={`step tone-${tone}${s.index === selected ? " selected" : ""}`}>
            <button onClick={() => onSelect(s.index)} title={`${s.label}: ${s.state}${s.reason ? ` (${s.reason})` : ""}`}>
              <span class="step-label">{s.label}</span>
              <span class="step-state">{s.index === 0 ? "written" : s.state}</span>
              {region && s.path ? (
                <span class="step-thumb">
                  <RegionThumb sha={s.sha} path={s.path} region={region} />
                </span>
              ) : (
                <span class="step-where">{s.range ? `${s.path !== detail.thread.path ? `${s.path}:` : "L"}${rangeText(s.range)}` : (s.reason ?? "gone")}</span>
              )}
              {comments ? <span class="step-comments">{comments} 💬</span> : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
