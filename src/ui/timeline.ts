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
