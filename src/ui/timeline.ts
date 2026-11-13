import type { OutdatedReason, ThreadDetail, TimelineStepDto } from "../core/types.ts";

export type DiffBase = "then" | "prev";

export function clampStep(detail: ThreadDetail, step: number | null): number {
  const last = detail.timeline.length - 1;
  if (step === null || step > last) return last;
  return Math.max(0, step);
}

export function diffPair(detail: ThreadDetail, selected: number, base: DiffBase): { from: TimelineStepDto; to: TimelineStepDto } | null {
  const to = detail.timeline[selected];
  if (!to || selected === 0) return null;
  let fromIndex = base === "then" ? 0 : selected - 1;
  while (fromIndex > 0 && !detail.timeline[fromIndex]!.range) fromIndex--;
  return { from: detail.timeline[fromIndex]!, to };
}

export function stateTone(state: string): "ok" | "info" | "warn" | "bad" {
  if (state === "outdated") return "bad";
  if (state === "changed") return "warn";
  if (state === "moved") return "info";
  return "ok";
}

/** Keep the first loss's evidence: later steps cannot locate an anchor that was already lost. */
export function missingThreadCode(detail: Pick<ThreadDetail, "timeline">, selected: number): {
  kind: "deleted" | "unlocated";
  at: TimelineStepDto;
  previous: TimelineStepDto;
} | null {
  const target = detail.timeline[selected];
  if (!target || (target.range && target.path)) return null;
  const before = detail.timeline.slice(0, selected + 1);
  const firstLost = before.findIndex((s) => !s.range || !s.path);
  const at = before[firstLost]!;
  const previous = before.slice(0, firstLost).reverse().find((s) => s.range && s.path) ?? detail.timeline[0]!;
  return { kind: at.reason === "file-deleted" || at.reason === "lines-deleted" ? "deleted" : "unlocated", at, previous };
}

const OUTDATED: Record<OutdatedReason, string> = {
  "file-deleted": "the file was deleted",
  "lines-deleted": "its lines were deleted",
  "text-not-found": "its lines were changed past recognition",
  ambiguous: "its lines now match more than one place",
  binary: "the file became binary",
  rewritten: "the file was rewritten",
};

/** Why a thread's code is gone, in words: the web's "the commented code is gone", with the reason after it. */
export function outdatedText(reason: OutdatedReason | undefined, at: string): string {
  return `the commented code is gone at ${at}${reason ? `: ${OUTDATED[reason]}` : ""}`;
}
