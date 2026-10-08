import type { Options, Parsed } from "../cli/args.ts";

/**
 * A part of stet in `modules/<id>/` that a build may leave out (`bun run build -- --without <id>`) and a repository
 * may switch off (`stet config set modules.<id> off`). Its data outlives it: threads it made stay in the store, and the
 * CLI and export keep describing them.
 */
export interface ModuleSpec {
  id: string;
  /** What it adds, in a few words: `stet --help` describes `modules.<id>` with it. */
  label: string;
  /** Whether it is on in a repository that never set `modules.<id>`. */
  default: "on" | "off";
  experimental?: true;
  /** Modules it cannot work without: it is on only while they are, and a build that has it must have them. */
  needs?: string[];
  /** Modules it works with when they are there. */
  uses?: string[];
  cli?: CommandSpec[];
  config?: ConfigKeySpec[];
  fileKinds?: FileKind[];
}

export type HelpSection = "Review" | "Versions" | "Threads" | "Agent loop" | "Tools";

export interface CommandSpec {
  /** One word, or a group and a word (`images list`). */
  name: string;
  section: HelpSection;
  /** Its lines in `stet --help`, laid out as the core's: the synopsis, its description from column 49. */
  usage: string;
  options: Options;
  run(p: Parsed): Promise<number | void>;
}

export interface ConfigKeySpec {
  key: string;
  /** The values it takes, when it takes only a few. */
  values?: string[];
  default?: string;
  /** What `stet --help` says after the key's name; a key without it is listed by name. */
  help?: string;
  /** `read`: a UI gets the value in the `ui` block of GET /api/review; `write`: it may also set it (POST /api/config). */
  ui: false | "read" | "write";
  /** Where the value lives. There is no user layer yet: every key is `repo`, stored in the repository's database. */
  scope: "repo" | "user";
}

/** A kind of file the core treats as more than lines. */
export interface FileKind {
  id: string;
  match(path: string): boolean;
  /** Width and height read from the file's bytes: a thread may sit on an area of a file of this kind. */
  size?(path: string, bytes: Uint8Array): { w: number; h: number } | null;
  /** Whether bytes a UI sent are a picture of such a file that a thread may keep for the agent. */
  acceptsShot?(bytes: Uint8Array): boolean;
}
