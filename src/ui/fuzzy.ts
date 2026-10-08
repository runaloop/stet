export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return 0;
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf("/") + 1;
  let score = 0;
  let pos = -1;
  let run = 0;
  for (const ch of q) {
    const i = p.indexOf(ch, pos + 1);
    if (i === -1) return null;
    run = i === pos + 1 ? run + 1 : 0;
    score += 1 + run * 3 + (i >= nameStart ? 2 : 0) + (i === nameStart || p[i - 1] === "/" || p[i - 1] === "." || p[i - 1] === "_" || p[i - 1] === "-" ? 4 : 0);
    pos = i;
  }
  return score - (p.length - nameStart) * 0.01;
}

export function fuzzyFilter<T>(items: T[], query: string, key: (t: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((t) => ({ t, s: fuzzyScore(query, key(t)) }))
    .filter((x): x is { t: T; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

export function wordFilter<T>(items: T[], query: string, text: (t: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items
    .map((t, i) => {
      const s = text(t).toLowerCase();
      let score = 0;
      for (const w of words) {
        const at = s.indexOf(w);
        if (at === -1) return null;
        score += at;
      }
      return { t, score, i };
    })
    .filter((x): x is { t: T; score: number; i: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.t);
}
