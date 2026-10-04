import { useEffect, useState } from "preact/hooks";
import type { AnchorState } from "../../src/core/types.ts";
import { api } from "../api.ts";
import { reviewId, status } from "../state.ts";

export interface Placed {
  threadId: number;
  range: { start: number; end: number };
  state: AnchorState;
}

export function usePlacements(sha: string | null, path: string | null): Placed[] {
  const [list, setList] = useState<Placed[]>([]);
  const rid = reviewId.value;
  const seq = status.value?.lastSeq ?? 0;
  useEffect(() => {
    let live = true;
    if (rid === null || !sha || !path) {
      setList([]);
      return;
    }
    api.placements(rid, sha, path).then(
      (r) => live && setList(Array.isArray(r) ? r : []),
      () => live && setList([]),
    );
    return () => {
      live = false;
    };
  }, [rid, sha, path, seq]);
  return list;
}
