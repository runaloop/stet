export type Route = (
  | { name: "home" }
  | { name: "overview" }
  | { name: "thread"; id: number }
  | { name: "compare"; from: string; to: string; file?: string; line?: number; end?: number; side?: "old" | "new" }
  | { name: "drafts" }
) & { review?: number };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const h = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  const review = Number(params.get("review")) || undefined;
  const withReview = <R extends Route>(r: R): R => (review ? { ...r, review } : r);
  let m = /^\/thread\/(\d+)/.exec(h);
  if (m) return withReview({ name: "thread", id: Number(m[1]) });
  m = /^\/compare\/([^/.]+)\.\.([^/]+)/.exec(h);
  if (m) {
    const r: Route = { name: "compare", from: decodeURIComponent(m[1]!), to: decodeURIComponent(m[2]!) };
    const file = params.get("file");
    if (file) {
      r.file = file;
      const lines = /^(\d+)(?:-(\d+))?$/.exec(params.get("line") ?? "");
      const [a, b] = lines ? [Number(lines[1]), Number(lines[2] ?? lines[1])] : [0, 0];
      if (Math.min(a, b) > 0) {
        r.line = Math.min(a, b);
        if (a !== b) r.end = Math.max(a, b);
      }
      if (params.get("side") === "old") r.side = "old";
    }
    return withReview(r);
  }
  if (h.startsWith("/drafts")) return withReview({ name: "drafts" });
  if (h.startsWith("/overview")) return withReview({ name: "overview" });
  return withReview({ name: "home" });
}

export function routeHash(r: Route, review?: number | null): string {
  const params = new URLSearchParams();
  let path: string;
  switch (r.name) {
    case "thread":
      path = `/thread/${r.id}`;
      break;
    case "compare":
      path = `/compare/${encodeURIComponent(r.from)}..${encodeURIComponent(r.to)}`;
      if (r.file) {
        params.set("file", r.file);
        if (r.line) params.set("line", r.end && r.end > r.line ? `${r.line}-${r.end}` : String(r.line));
        if (r.side === "old") params.set("side", "old");
      }
      break;
    case "drafts":
      path = "/drafts";
      break;
    case "overview":
      path = "/overview";
      break;
    default:
      path = "/";
  }
  const rv = r.review ?? review;
  if (rv) params.set("review", String(rv));
  const qs = params.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

/** Whether two routes show the same view: the same page, and on the Changes page the same range and lines. */
export function sameView(a: Route, b: Route): boolean {
  return routeHash(a) === routeHash(b);
}

export function plainClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey;
}

/** The access token `stet serve` puts in the URL, and the hash without it (the review and the page stay). */
export function takeToken(hash: string): { token: string; hash: string } | null {
  const m = /[#?&]token=([0-9a-f]+)/.exec(hash);
  if (!m) return null;
  const rest = hash.replace(/([#?&])token=[0-9a-f]+&?/, "$1").replace(/[?&]$/, "");
  return { token: m[1]!, hash: rest.length > 1 ? rest : "#/" };
}
