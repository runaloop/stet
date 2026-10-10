import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where a review's unsent texts are kept: in the repository's stet directory, one file per review. */
export function textsPath(commonDir: string, review: number): string {
  return join(commonDir, "stet", "tui", `review-${review}.json`);
}

/**
 * Text typed in a composer and not sent yet, by what it is for (`reply:12`, `edit:40`, `summary`), as the web keeps it
 * in localStorage. Every change reaches the disk within `delayMs`, through a rename, so a killed TUI loses at most
 * that much and never leaves a half-written file.
 */
export class Texts {
  private texts: Record<string, string> = {};
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly path: string | null,
    private readonly delayMs = 150,
  ) {
    if (!path) return;
    try {
      const saved = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) if (typeof v === "string") this.texts[k] = v;
      }
    } catch {
      // none yet, or unreadable: start empty
    }
  }

  get(key: string): string {
    return this.texts[key] ?? "";
  }

  set(key: string, text: string): void {
    if (text.trim()) this.texts[key] = text;
    else delete this.texts[key];
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.path) return;
    try {
      if (Object.keys(this.texts).length === 0) {
        rmSync(this.path, { force: true });
        return;
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.texts, null, 2), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      // a full disk or a removed .git: the text stays on screen and in memory
    }
  }
}
