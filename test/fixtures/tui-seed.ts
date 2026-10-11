// A review in the middle of a round, for the terminal UI: `bun test/fixtures/tui-seed.ts <dir> [--bin <stet>]` makes
// the repository in <dir> (emptied first) with the CLI from source or the binary given; the frame tests use `seedTui`.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const GIT = { GIT_AUTHOR_NAME: "Demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "Demo", GIT_COMMITTER_EMAIL: "demo@example.com" };

export interface Seeded {
  timing: number;
  magic: number;
  logLine: number;
  ipKey: number;
  readme: number;
  memory: number;
  port: number;
  draft: number;
  keyOnce: number;
  keyName: number;
  order: number;
}

/**
 * Two versions and eleven threads: the agent's fix waiting for you and unread, a question, an outdated thread, a long
 * message waiting for the agent, two resolved, new threads on v2 (three in src/auth.ts, four in src/routes.ts) and a
 * draft thread.
 */
export function seedTui(root: string, cli: string[]): Seeded {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, ...GIT };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root, env });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const stet = (role: "reviewer" | "agent", ...args: string[]): any => {
    const r = Bun.spawnSync([...cli, ...args, "--json"], { cwd: root, env: { ...env, STET_ROLE: role, STET_AUTHOR: role === "reviewer" ? "arkadiy" : "claude" } });
    if (r.exitCode !== 0) throw new Error(`stet ${args.join(" ")}: ${r.stderr.toString()}`);
    return JSON.parse(r.stdout.toString() || "null");
  };
  const comment = (file: string, range: string, body: string, ...more: string[]) => stet("reviewer", "comment", "add", "--file", file, "--range", range, "--body", body, ...more).id as number;
  const reply = (role: "reviewer" | "agent", id: number, body: string, ...more: string[]) => stet(role, "reply", String(id), "--body", body, ...more);

  const server0 = `import { handle } from "./routes.ts";

const PORT = Number(process.env.PORT ?? 8080);

export function start() {
  return Bun.serve({
    port: PORT,
    fetch(req) {
      return handle(req);
    },
  });
}
`;
  const routes0 = `import { findUser } from "./db.ts";

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  if (url.pathname.startsWith("/users/")) {
    const user = await findUser(url.pathname.slice(7));
    return user ? Response.json(user) : new Response("not found", { status: 404 });
  }
  return new Response("not found", { status: 404 });
}
`;
  const db0 = `export interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>([["1", { id: "1", name: "Ada" }]]);

export async function findUser(id: string): Promise<User | null> {
  return users.get(id) ?? null;
}
`;

  git("init", "-q", "-b", "main");
  write("README.md", "# shop-api\n\nA small HTTP API.\n\n## Running\n\n    bun src/main.ts\n");
  write("src/server.ts", server0);
  write("src/routes.ts", routes0);
  write("src/db.ts", db0);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature/rate-limit");

  // v1: the agent adds a rate limiter and an API key check
  write("src/limiter.ts", `export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit = 100, private readonly windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}
`);
  write("src/auth.ts", `const KEY = process.env.API_KEY ?? "";

export function authorized(req: Request): boolean {
  const given = req.headers.get("x-api-key") ?? "";
  return given === KEY;
}
`);
  write("src/routes.ts", `import { authorized } from "./auth.ts";
import { findUser } from "./db.ts";
import { RateLimiter } from "./limiter.ts";

const limiter = new RateLimiter(100, 60_000);

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok");
  const ip = req.headers.get("x-forwarded-for") ?? "unknown";
  if (!limiter.allow(ip)) return new Response("slow down", { status: 429 });
  if (!authorized(req)) return new Response("unauthorized", { status: 401 });
  if (url.pathname.startsWith("/users/")) {
    const user = await findUser(url.pathname.slice(7));
    return user ? Response.json(user) : new Response("not found", { status: 404 });
  }
  return new Response("not found", { status: 404 });
}
`);
  write("src/db.ts", `export interface User {
  id: string;
  name: string;
}

const users = new Map<string, User>([["1", { id: "1", name: "Ada" }]]);

export async function findUser(id: string): Promise<User | null> {
  console.log("findUser", id);
  return users.get(id) ?? null;
}
`);
  stet("agent", "version", "create", "--label", "rate limit and API key");

  // round 1: the reviewer's drafts, sent as one review
  const timing = comment("src/auth.ts", "5", "`===` on secrets leaks timing. Use `crypto.timingSafeEqual` on equal-length buffers.", "--at", "1", "--draft");
  const magic = comment("src/routes.ts", "5", "Where do 100 and 60 000 come from? Should they be settings?", "--at", "1", "--draft");
  const logLine = comment("src/db.ts", "9", "Leftover debug log: please drop it.", "--at", "1", "--draft");
  const ipKey = comment(
    "src/routes.ts",
    "10-11",
    [
      "I am not comfortable keying the limiter on `x-forwarded-for` as it is.",
      "",
      "Anyone can send that header. Behind no proxy, a client rotates it on every request and is never limited; behind a proxy that appends to it, the first value is still whatever the client wrote. So as written the limiter mostly limits honest clients.",
      "",
      "What I would like instead:",
      "",
      "1. Take the peer address from the server (`server.requestIP(req)`) by default.",
      "2. Trust `x-forwarded-for` only when a `TRUST_PROXY` setting says how many hops to trust, and then take the right entry, not the first.",
      "3. Rate-limit before the auth check stays as it is: it protects the key check from brute force, which is good.",
      "",
      "Also, `unknown` as a fallback key puts every client without the header into one bucket: one noisy client then locks out everyone else. Better to skip the limiter for that case or use the peer address.",
    ].join("\n"),
    "--at",
    "1",
    "--draft",
  );
  const readme = comment("README.md", "7", "Document `API_KEY` here: the server refuses every request without it.", "--at", "1", "--draft");
  const memory = comment("src/limiter.ts", "2", "`hits` grows without bound: keys that never come back stay forever.", "--at", "1", "--draft");
  stet("reviewer", "review", "submit", "--body", "First pass: the limiter's key is the big one.");

  // v2: the agent answers
  write("src/auth.ts", `import { timingSafeEqual } from "node:crypto";

const KEY = Buffer.from(process.env.API_KEY ?? "");

export function authorized(req: Request): boolean {
  const given = Buffer.from(req.headers.get("x-api-key") ?? "");
  return given.length === KEY.length && timingSafeEqual(given, KEY);
}
`);
  write("src/db.ts", db0.replace("findUser(id: string)", "findUser(id: string)"));
  write("README.md", "# shop-api\n\nA small HTTP API.\n\n## Running\n\n    API_KEY=secret bun src/main.ts\n\nEvery request but `/health` needs the `x-api-key` header with that key.\n");
  write("src/limiter.ts", `export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limit = 100, private readonly windowMs = 60_000) {}

  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number): void {
    for (const [key, list] of this.hits) if (list.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
  }
}
`);
  stet("agent", "version", "create", "--label", "constant-time key check, sweep, docs");

  reply("agent", timing, "Fixed: both sides go through `Buffer`, a length check, then `timingSafeEqual`.", "--intent", "fixed");
  reply("agent", magic, "100 requests a minute is the limit the old nginx config had. I can move both to `RATE_LIMIT` / `RATE_WINDOW_MS` env settings if you want that in this branch.", "--intent", "question");
  reply("agent", logLine, "Removed.", "--intent", "fixed");
  reply("agent", readme, "Documented `API_KEY` and the header in Running.", "--intent", "fixed");
  reply("agent", memory, "Added a sweep once the map passes 10 000 keys; it drops keys whose hits all left the window.", "--intent", "fixed");

  // the reviewer goes through some of it
  stet("reviewer", "read", String(readme));
  stet("reviewer", "resolve", String(readme), "--reason", "fixed");
  stet("reviewer", "read", String(logLine));
  stet("reviewer", "read", String(magic));
  stet("reviewer", "read", String(memory));
  reply("reviewer", memory, "A sweep on size works, but it runs on the request that crosses 10 000: that one request pays for a full scan. A timer every window would spread it. Fine for now if you add a test for the sweep.");
  reply("agent", memory, "Added `limiter.test.ts` with a sweep test; the timer can come with the settings change.", "--intent", "answered");
  stet("reviewer", "read", String(memory));
  stet("reviewer", "resolve", String(memory), "--reason", "answered");

  // a new thread on v2, sent right away, and a draft for the next review
  // more threads in two files, so J and K (first thread of the next file) differ from j and k
  const keyOnce = comment("src/auth.ts", "3", "Read API_KEY once at startup and refuse to start when it is empty? Today an empty key accepts an empty header.", "--at", "2");
  const keyName = comment("src/auth.ts", "1", "Nit: the import is fine, but `KEY` is a Buffer now; `KEY_BYTES`?", "--at", "2");
  reply("agent", keyName, "Renamed in my working tree; it comes with the next version.", "--intent", "fixed");
  const order = comment("src/routes.ts", "12", "Checking the key before the route means a 401 for every unknown path: is that on purpose?", "--at", "2");
  reply("agent", order, "Yes: answering 404 before the key check would tell anyone which paths exist. I would keep it.", "--intent", "disagree");
  const port = comment("src/server.ts", "3", "`Number(undefined ?? 8080)` is fine, but `PORT=abc` gives NaN and Bun picks a random port. Validate it?", "--at", "2");
  const draft = comment("src/routes.ts", "13", "Should 401 come with a `www-authenticate` header?", "--at", "2", "--draft");
  return { timing, magic, logLine, ipKey, readme, memory, port, draft, keyOnce, keyName, order };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args[0];
  if (!dir) throw new Error("usage: bun test/fixtures/tui-seed.ts <dir> [--bin <stet>]");
  const bin = args[args.indexOf("--bin") + 1];
  seedTui(dir, args.includes("--bin") && bin ? [bin] : ["bun", join(import.meta.dir, "..", "..", "src", "cli.ts")]);
  console.log(`a review in ${dir}: cd there and run \`stet tui\``);
}
