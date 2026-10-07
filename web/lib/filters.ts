import type { AnchorState, ThreadSummary } from "../../src/core/types.ts";
import { fileOf } from "./tree.ts";

export interface Filters {
  status: "open" | "resolved" | "all";
  newOnly: boolean;
  state: AnchorState | "";
  version: number | null;
  file: string;
}

export const DEFAULT_FILTERS: Filters = { status: "open", newOnly: false, state: "", version: null, file: "" };

export function globToRegExp(pattern: string): RegExp {
  const glob = pattern.replace(/(\*\*\/)+/g, "**/");
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          re += "(?:.*/)?";
          i++;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchesFile(path: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return true;
  if (!/[*?]/.test(p)) return path.toLowerCase().includes(p.toLowerCase());
  const re = globToRegExp(p);
  return re.test(path) || re.test(path.split("/").pop() ?? path);
}

export function applyFilters(threads: ThreadSummary[], f: Filters): ThreadSummary[] {
  return threads.filter((t) => {
    if (f.status !== "all" && t.status !== f.status && !t.draft) return false;
    if (f.newOnly && !t.unread && !t.draft) return false;
    if (f.state && t.anchor.state !== f.state) return false;
    if (f.version !== null && t.version !== f.version) return false;
    if (!matchesFile(fileOf(t), f.file) && !matchesFile(t.path, f.file)) return false;
    return true;
  });
}

/** The side panel tab a review opens on: the reader's own, except that Threads with nothing open (no drafts either) gives way to Files. */
export function landingTab<T extends string>(chosen: T, threads: ThreadSummary[], drafts: number): T | "files" {
  return chosen === "threads" && drafts === 0 && !threads.some((t) => t.status === "open") ? "files" : chosen;
}
