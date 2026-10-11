import { appendFileSync } from "node:fs";

/** A file the TUI writes what it did and when to, for the performance checks: `STET_TUI_TRACE=<file>`. */
const TRACE = process.env.STET_TUI_TRACE;
const lines: string[] = [];

export const tracing = !!TRACE;

export function trace(o: Record<string, unknown>): void {
  if (!TRACE) return;
  lines.push(JSON.stringify({ t: performance.now(), ...o }));
  if (lines.length >= 50) flushTrace();
}

export function flushTrace(): void {
  if (TRACE && lines.length) appendFileSync(TRACE, `${lines.splice(0).join("\n")}\n`);
}
