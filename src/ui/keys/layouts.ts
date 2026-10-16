/**
 * What a non-Latin layout types on each physical key, as the US key it sits on. Only keys that type a non-ASCII
 * character are listed: an ASCII character always wins over the table (Shift+7 on ЙЦУКЕН types `?` and stays `?`).
 * Sources: xkb symbols/ru "winkeys" (the default ru) and symbols/ua "unicode" (the default ua).
 */
export interface Layout {
  id: string;
  /** produced character → the US character of the same physical key, Shift included (`Х` → `{`) */
  keys: Record<string, string>;
  /** this layout types `.` / `,` on the US `/` key: they stand for `/` / `?` while the layout is known to be active */
  slashKey: boolean;
}

const pairs = (lower: string, upper: string, us: string, usShift: string): Record<string, string> => {
  const out: Record<string, string> = {};
  [...lower].forEach((ch, i) => (out[ch] = us[i]!));
  [...upper].forEach((ch, i) => (out[ch] = usShift[i]!));
  return out;
};

export const RU: Layout = {
  id: "ru",
  slashKey: true,
  keys: {
    ...pairs(
      "йцукенгшщзхъфывапролджэячсмитьбюё",
      "ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮЁ",
      "qwertyuiop[]asdfghjkl;'zxcvbnm,.`",
      'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>~',
    ),
    "№": "#",
  },
};

export const UK: Layout = {
  id: "uk",
  slashKey: true,
  keys: {
    ...pairs(
      "йцукенгшщзхїфівапролджєячсмитьбюґ",
      "ЙЦУКЕНГШЩЗХЇФІВАПРОЛДЖЄЯЧСМИТЬБЮҐ",
      "qwertyuiop[]asdfghjkl;'zxcvbnm,.\\",
      'QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>|',
    ),
    "№": "#",
  },
};

export const LAYOUTS: Layout[] = [RU, UK];

/** One lookup over every layout: they agree wherever their characters overlap. */
export function tableFor(layouts: Layout[] = LAYOUTS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of layouts) Object.assign(out, l.keys);
  return out;
}
