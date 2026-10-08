import type { Options, Parsed } from "../cli/args.ts";
import type { OrderPreset } from "../ui/order.ts";
import type { Ctx } from "./context.ts";
import type { ReviewRow } from "./store/db.ts";

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
  /** Orders of files `compare.order` may name while the module is on; the page sorts by them through its web part. */
  orderPresets?: OrderPreset[];
  actions?: ActionDef[];
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
  /** Why the repository cannot take `value`, e.g. a name only a module that is off knows; null when it can. */
  check?(value: string, ctx: Ctx, from: readonly ModuleSpec[]): string | null;
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

/** Where a UI offers an action: the page or part of it that has the focus. */
export type Where = "compare" | "guide" | "thread" | "code" | "drafts" | "everywhere";

/**
 * Something a person runs on a part of a review that leaves stet: the editor at a line, the page in the browser. The
 * core resolves it to a `Launch`, and each UI runs that its own way: the CLI in the terminal, the server for the page.
 */
export interface ActionDef {
  /** `<module or area>.<verb>`, as in `POST /api/actions/<id>`. */
  id: string;
  label: string;
  /** The id of the command in a UI's key table that runs it. */
  command: string;
  where: Where[];
  available(ctx: Ctx, target: ActionTarget): boolean;
  resolve(ctx: Ctx, review: ReviewRow, target: ActionTarget): Promise<Launch>;
}

/** What an action runs on: a thread, or a file's line at a version (`at`, in a compare from `from`), or the review. */
export interface ActionTarget {
  thread?: number;
  path?: string;
  line?: number;
  at?: string;
  from?: string;
}

/** `file`: an absolute `file` that is `path` under `root`, at `line`. */
export type Launch =
  | { kind: "file"; root: string; path: string; file: string; line: number }
  | { kind: "url"; url: string }
  | { kind: "argv"; argv: string[]; cwd: string };
