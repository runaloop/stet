import type { Cls } from "./text.ts";

export interface Look {
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** The approved mockups' dark palette; the screen paints its own background, so a light terminal theme reads the same. */
export const BG = "#0f1412";
export const FG = "#d6ddd8";
const DIM = "#7f8b85";
const FOCUS = "#5fd3b2";
const SELI = "#252e2a";
const HDR = "#18201c";
const OK = "#56d364";

export const LOOKS: Record<Cls, Look> = {
  b: { bold: true },
  dim: { fg: DIM },
  bd: { fg: "#39433e" },
  bdt: { fg: DIM },
  bf: { fg: FOCUS },
  bft: { fg: FOCUS, bold: true },
  hdr: { bg: HDR },
  info: { bg: "#12304a", fg: "#bfe0ff" },
  state: { bg: "#1b2c3d", fg: "#bfe0ff" },
  sel: { bg: "#1d4a3e" },
  seli: { bg: SELI },
  cur: { bg: SELI },
  add: { bg: "#12361f" },
  addw: { bg: "#1f6b39" },
  del: { bg: "#3f1a1d" },
  delw: { bg: "#7a2a30" },
  addc: { fg: OK },
  delc: { fg: "#f47067" },
  ln: { fg: DIM },
  mk: { fg: "#e3b341" },
  key: { bg: "#333d38", fg: "#eef3ef" },
  tab: { bg: FOCUS, fg: BG, bold: true },
  tabin: { fg: FG, bold: true, underline: true },
  chip: { fg: FG, bg: SELI },
  chips: { fg: BG, bg: FOCUS, bold: true },
  seg: { fg: FG, bg: SELI, bold: true },
  fon: { fg: FOCUS, bold: true },
  mod: { fg: "#f2cc60" },
  tchg: { bg: "#3d2e00", fg: "#f2cc60" },
  tyou: { bg: "#0d419d", fg: "#d4e8ff" },
  tag: { bg: "#3c1e70", fg: "#e2c5ff" },
  tout: { bg: "#30363d", fg: "#a8b1ba" },
  tdr: { bg: "#4d2d00", fg: "#ffb366" },
  tok: { fg: OK },
  tq: { bg: "#4b3b00", fg: "#ffd866" },
  tbad: { bg: "#7a2a30", fg: "#ffd8d3" },
  ok: { fg: OK },
  bad: { fg: "#ff7b72", bold: true },
  warn: { fg: "#f2cc60" },
  new: { fg: "#ff7b72", bold: true },
  acc: { fg: FOCUS },
  fh: { fg: FG, bold: true },
  rule: { fg: DIM },
  cf: { fg: FOCUS },
  cft: { fg: "#ffb366" },
  wk: { fg: FOCUS, bold: true },
  wg: { fg: "#e2c5ff" },
  ftr: { bg: HDR },
  fk: { bg: FOCUS, fg: BG, bold: true },
  you: { fg: "#79c0ff", bold: true },
  agentc: { fg: "#d2a8ff", bold: true },
};

/** The classes of a span in order: a later one wins for a colour it sets. */
export function look(c: readonly Cls[] | undefined): Required<Pick<Look, "fg" | "bg">> & Look {
  const out: Look = { fg: FG, bg: BG };
  for (const x of c ?? []) {
    const l = LOOKS[x];
    if (l.fg) out.fg = l.fg;
    if (l.bg) out.bg = l.bg;
    if (l.bold) out.bold = true;
    if (l.italic) out.italic = true;
    if (l.underline) out.underline = true;
  }
  return out as Required<Pick<Look, "fg" | "bg">> & Look;
}
