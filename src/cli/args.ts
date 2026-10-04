import { parseArgs, type ParseArgsConfig } from "node:util";
import { usage } from "../core/context.ts";

export type Options = NonNullable<ParseArgsConfig["options"]>;

export const GLOBAL_OPTIONS: Options = {
  repo: { type: "string", short: "C" },
  branch: { type: "string", short: "b" },
  as: { type: "string" },
  author: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

export function parse(argv: string[], options: Options): Parsed {
  try {
    const r = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
    return { values: r.values as Parsed["values"], positionals: r.positionals };
  } catch (e) {
    throw usage((e as Error).message);
  }
}

export function str(p: Parsed, key: string): string | undefined {
  const v = p.values[key];
  return typeof v === "string" ? v : undefined;
}

export function bool(p: Parsed, key: string): boolean {
  return p.values[key] === true;
}

export function list(p: Parsed, key: string): string[] {
  const v = p.values[key];
  if (Array.isArray(v)) return v.flatMap((x) => x.split(",")).filter(Boolean);
  if (typeof v === "string") return v.split(",").filter(Boolean);
  return [];
}

export function int(value: string | undefined, name: string): number {
  if (value === undefined) throw usage(`missing ${name}`);
  const n = Number(value.replace(/^#/, ""));
  if (!Number.isInteger(n) || n < 1) throw usage(`${name} must be a positive integer, got '${value}'`);
  return n;
}

export function range(value: string | undefined): { start: number; end: number } {
  if (!value) throw usage("missing --range <a-b>");
  const m = /^(\d+)(?:[-:](\d+))?$/.exec(value);
  if (!m) throw usage(`bad range '${value}', expected <a> or <a-b>`);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (start < 1 || end < start) throw usage(`bad range '${value}'`);
  return { start, end };
}

/** `x,y,w,h` in pixels. */
export function region(value: string): { x: number; y: number; w: number; h: number } {
  const m = /^(\d+),(\d+),(\d+),(\d+)$/.exec(value.replace(/\s/g, ""));
  if (!m) throw usage(`bad region '${value}', expected <x,y,w,h> in pixels`);
  const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
  if (w < 1 || h < 1) throw usage(`bad region '${value}': width and height must be at least 1`);
  return { x, y, w, h };
}

export function duration(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (!m) throw usage(`bad duration '${value}', expected e.g. 30s, 10m, 2h`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

export async function readBody(p: Parsed): Promise<string> {
  const file = str(p, "body-file");
  if (file) return file === "-" ? await Bun.stdin.text() : await Bun.file(file).text();
  const body = str(p, "body");
  if (body === "-") return await Bun.stdin.text();
  if (body === undefined) throw usage("missing --body <text> (or --body - / --body-file <path>)");
  return body;
}
