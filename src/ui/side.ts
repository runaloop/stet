/** The page the side panel sits on: the Changes page beside a diff, a thread's page beside its code and conversation, the others. */
export type SidePage = "compare" | "thread" | "other";

export interface SideRoom {
  /** Width of the window, px. */
  window: number;
  page: SidePage;
  /** The diff shows old and new side by side. */
  split: boolean;
}

/** The narrowest the panel gets for short rows: its tabs and the thread filters still fit. */
export const SIDE_FLOOR = 240;
/** The ceiling never goes under the panel's old minimum, however little room the window has. */
const SIDE_BASE = 300;
const SPLITTER = 7;
/** Two code columns of 80 characters (13 px mono) with their line numbers. */
const SPLIT_DIFF = 1380;
/** One code column of 100 characters with both line numbers. */
const UNIFIED_DIFF = 920;
/** A thread's code and its conversation stand side by side from this width of the page on (the container query of `.detail`). */
const THREAD_ROOM = 1100;

/** The widest the panel takes for its rows: a share of the window that leaves the diff (or a thread's two columns) their room. */
export function sideCeiling(room: SideRoom): number {
  const share = room.page === "thread" ? 0.25 : 0.3;
  const beside = room.page === "thread" ? THREAD_ROOM : room.page === "compare" && room.split ? SPLIT_DIFF : UNIFIED_DIFF;
  return Math.round(Math.max(SIDE_BASE, Math.min(room.window * share, room.window - SPLITTER - beside)));
}

/** The panel as wide as its longest row needs, between the floor and the ceiling; the ceiling while nothing was measured. */
export function sideWidth(need: number | null, room: SideRoom): number {
  const top = sideCeiling(room);
  return need === null ? top : Math.min(top, Math.max(SIDE_FLOOR, Math.ceil(need)));
}
