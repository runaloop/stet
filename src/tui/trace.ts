import { appendFileSync } from "node:fs";

/** A file the TUI writes what it did and when to, for the performance checks: `STET_TUI_TRACE=<file>`. */
const TRACE = process.env.STET_TUI_TRACE;
const lines: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

export const tracing = !!TRACE;

export function trace(o: Record<string, unknown>): void {
  if (!TRACE) return;
  lines.push(JSON.stringify({ t: performance.now(), ...o }));
  // written a moment later, so a run of keys costs one write
  timer ??= setTimeout(flushTrace, 50);
}

export function flushTrace(): void {
  clearTimeout(timer);
  timer = undefined;
  if (TRACE && lines.length) appendFileSync(TRACE, `${lines.splice(0).join("\n")}\n`);
}
