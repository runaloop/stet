import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, GIT_ENV, lines } from "./helpers/fixture.ts";

const f = new Fixture();
let proc: ReturnType<typeof Bun.spawn> | null = null;
let port = 0;
let token = "";
let review = 0;

async function start(): Promise<{ port: number; url: string }> {
  proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--json"], {
    cwd: f.root,
    env: { ...process.env, ...GIT_ENV, STET_WATCH_MS: "200" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  reader.releaseLock();
  return JSON.parse(new TextDecoder().decode(value));
}

beforeAll(async () => {
  f.write("a.kt", lines(20)).write("b.kt", lines(5));
  f.commit("init");
  f.git(["checkout", "-q", "-b", "feat"]);
  f.write("a.kt", lines(21));
  await ok(stet(["version", "create"], { cwd: f.root }));
  const info = await start();
  port = info.port;
  token = info.url.split("token=")[1]!;
  review = Number(/review=(\d+)/.exec(info.url)![1]);
});

afterAll(() => {
  proc?.kill();
  f.cleanup();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { "x-stet-token": token, "content-type": "application/json", ...(init.headers ?? {}) } });

class Stream {
  private buf = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(res: Response) {
    this.reader = res.body!.getReader();
  }
  private got: { event: string; data: unknown }[] = [];
  private reading: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | null = null;
  /** The first message `event: <name>` not taken yet whose data passes `want`; others stay for later calls. */
  async next<T>(name: string, want: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
    const until = Date.now() + ms;
    while (true) {
      const i = this.got.findIndex((m) => m.event === name && want(m.data as T));
      if (i !== -1) return this.got.splice(i, 1)[0]!.data as T;
      if (Date.now() >= until) throw new Error(`no ${name} event in ${ms} ms`);
      this.reading ??= this.reader.read();
      const r = await Promise.race([this.reading, Bun.sleep(until - Date.now()).then(() => null)]);
      if (!r) continue;
      this.reading = null;
      if (r.done) throw new Error("the stream ended");
      this.buf += new TextDecoder().decode(r.value);
      let end: number;
      while ((end = this.buf.indexOf("\n\n")) !== -1) {
        const msg = this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 2);
        const event = /^event: (.+)$/m.exec(msg)?.[1];
        const data = /^data: (.+)$/m.exec(msg)?.[1];
        if (event && data) this.got.push({ event, data: JSON.parse(data) });
      }
    }
  }
  close() {
    void this.reader.cancel();
  }
}

type Now = { sha: string; pinned: string; files: number | null };
type Git = { files: { path: string; staged: boolean; unstaged: boolean; untracked: boolean }[]; upstream: string | null; ahead: number };

test("the server tells the page when the worktree moves away from the pinned now, and the git state", async () => {
  const status = await (await api(`/api/review?review=${review}`)).json();
  const pinned = status.pinnedNow as string;
  const s = new Stream(await api(`/api/events?review=${review}`));
  const git = await s.next<Git>("git");
  expect(git.files.map((x) => x.path)).toEqual(["a.kt"]);
  expect(git.upstream).toBeNull();
  expect(await s.next<Now>("now")).toEqual({ sha: pinned, pinned, files: 0 });

  f.write("b.kt", lines(6)).write("c.kt", "new\n");
  const moved = await s.next<Now>("now", (d) => d.sha !== pinned);
  expect(moved).toMatchObject({ pinned, files: 2 });
  const after = await s.next<Git>("git", (d) => d.files.length === 3);
  expect(after.files.find((x) => x.path === "c.kt")!.untracked).toBe(true);

  const again = await (await api(`/api/now/refresh?review=${review}`, { method: "POST", body: "{}" })).json();
  expect(again.sha).toBe(moved.sha);
  expect(await s.next<Now>("now", (d) => d.pinned === moved.sha)).toEqual({ sha: moved.sha, pinned: moved.sha, files: 0 });

  const direct = (await (await api(`/api/git?review=${review}`)).json()) as Git;
  expect(direct.files).toHaveLength(3);
  s.close();
});

test("a restarted server takes the port it had, so open pages find it again", async () => {
  proc!.kill("SIGTERM");
  await proc!.exited;
  const info = await start();
  expect(info.port).toBe(port);
  expect((await api("/api/ping")).status).toBe(200);
});
