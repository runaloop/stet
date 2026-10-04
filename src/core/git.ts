export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
}

export interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

const HARDENED_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
};

const STRIPPED_ENV = ["GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX"];

const HARDENED_FLAGS = [
  "-c", "core.quotepath=off",
  "-c", "color.ui=never",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.relative=false",
  "-c", "log.showSignature=false",
];

const decoder = new TextDecoder();

export async function gitRun(args: string[], opts: GitOptions): Promise<GitResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of STRIPPED_ENV) delete env[k];
  Object.assign(env, HARDENED_ENV);
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(["git", ...HARDENED_FLAGS, ...args], {
    cwd: opts.cwd,
    env,
    stdin: opts.input === undefined ? "ignore" : new Blob([opts.input as BlobPart]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function gitBytes(args: string[], opts: GitOptions): Promise<Uint8Array> {
  const r = await gitRun(args, opts);
  if (r.code !== 0) {
    throw new GitError(`git ${args[0]} failed (${r.code}): ${r.stderr.trim()}`, args, r.code, r.stderr);
  }
  return r.stdout;
}

export async function git(args: string[], opts: GitOptions): Promise<string> {
  return decoder.decode(await gitBytes(args, opts));
}

export async function gitLine(args: string[], opts: GitOptions): Promise<string> {
  return (await git(args, opts)).trim();
}

export async function gitTry(args: string[], opts: GitOptions): Promise<string | null> {
  const r = await gitRun(args, opts);
  return r.code === 0 ? decoder.decode(r.stdout).trim() : null;
}

export class Lru<V> {
  private map = new Map<string, V>();
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  set(key: string, v: V): void {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

export interface GitBlob {
  id: string;
  bytes: Uint8Array;
  binary: boolean;
  text: string;
}

const blobCache = new Lru<GitBlob>(512);

export function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function makeBlob(id: string, bytes: Uint8Array): GitBlob {
  const binary = isBinary(bytes);
  return { id, bytes, binary, text: binary ? "" : decoder.decode(bytes) };
}

export async function readBlobById(cwd: string, id: string): Promise<GitBlob> {
  const hit = blobCache.get(id);
  if (hit) return hit;
  const blob = makeBlob(id, await gitBytes(["cat-file", "blob", id], { cwd }));
  if (!blob.binary || blob.bytes.length <= 1 << 20) blobCache.set(id, blob);
  return blob;
}

export async function blobIdAt(cwd: string, commit: string, path: string): Promise<string | null> {
  const r = await gitRun(["ls-tree", "-z", "--full-tree", commit, "--", path], { cwd });
  if (r.code !== 0) return null;
  const entry = decoder.decode(r.stdout).split("\0")[0] ?? "";
  const m = /^\d+ blob ([0-9a-f]+)\t(.*)$/s.exec(entry);
  return m && m[2] === path ? m[1]! : null;
}

export async function readBlobAt(cwd: string, commit: string, path: string): Promise<GitBlob | null> {
  const id = await blobIdAt(cwd, commit, path);
  return id ? readBlobById(cwd, id) : null;
}

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
