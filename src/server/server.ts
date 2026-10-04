import index from "../../web/index.html";
import { timingSafeEqual } from "node:crypto";
import diffsWorker from "@pierre/diffs/worker/worker-portable.js" with { type: "text" };
import { basename } from "node:path";
import { findReview, type Ctx } from "../core/context.ts";
import { handleApi, type ServerState } from "./api.ts";
import { readServerInfo, removeServerInfo, reviewUrl, savedPort, savePort, serverToken, writeServerInfo, type ServerInfo } from "./info.ts";
import { Watcher } from "./watch.ts";

export interface ServeOptions {
  port: number;
  open: boolean;
  printUrlOnly: boolean;
  branch?: string;
  json: boolean;
  /** Run the server on its own and return once it answers. */
  detach?: boolean;
}

function tokenMatches(given: string | null, token: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function hostAllowed(req: Request, port: number): boolean {
  const host = req.headers.get("host") ?? "";
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(host)) return false;
  const origin = req.headers.get("origin");
  if (origin && !allowed.some((a) => origin === `http://${a}`)) return false;
  return true;
}

function eventStream(state: ServerState, req: Request, reviewId: number | null, since: number): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  let unwatch: (() => void) | undefined;
  let last = since;
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      const cleanup = () => {
        clearInterval(timer);
        clearInterval(ping);
        unwatch?.();
        unwatch = undefined;
      };
      send(`retry: 2000\n\n`);
      if (reviewId !== null && state.watcher) {
        unwatch = state.watcher.subscribe(reviewId, (event, data) => send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      timer = setInterval(() => {
        const rows = state.ctx.store.db
          .query<{ seq: number; type: string; role: string; thread_id: number | null }, [number, number, number]>(
            "SELECT seq, type, role, thread_id FROM events WHERE seq > ? AND (? = 0 OR review_id = ?) ORDER BY seq LIMIT 200",
          )
          .all(last, reviewId ?? 0, reviewId ?? 0);
        if (rows.length > 0) {
          last = rows[rows.length - 1]!.seq;
          send(`id: ${last}\nevent: change\ndata: ${JSON.stringify({ seq: last, events: rows })}\n\n`);
        }
      }, 300);
      ping = setInterval(() => send(`: ping\n\n`), 15_000);
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          return;
        }
      });
    },
    cancel() {
      clearInterval(timer);
      clearInterval(ping);
      unwatch?.();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

function openBrowser(url: string): void {
  const argv = process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url]
    : ["xdg-open", url];
  try {
    Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref();
  } catch {
    return;
  }
}

export async function serve(ctx: Ctx, opts: ServeOptions): Promise<number> {
  const existing = await readServerInfo(ctx.repo.commonDir);
  if (existing) {
    const mine = await findReview(ctx, opts.branch).catch(() => null);
    const url = reviewUrl(existing, mine?.id);
    report({ ...existing, url }, opts, true);
    if (opts.open) openBrowser(url);
    return 0;
  }
  if (opts.detach) {
    const info = await startDetached(ctx, opts);
    if (!info) {
      console.error("stet serve: the server did not start; run `stet serve` to see why");
      return 1;
    }
    const mine = await findReview(ctx, opts.branch).catch(() => null);
    const url = reviewUrl(info, mine?.id);
    report({ ...info, url }, opts, false);
    if (opts.open) openBrowser(url);
    return 0;
  }
  const review = await findReview(ctx, opts.branch);
  const state: ServerState = { ctx, defaultReview: review?.id ?? null, pinnedNow: new Map() };
  state.watcher = new Watcher(ctx, (id) => state.pinnedNow.get(id)?.sha ?? null);
  const token = serverToken(ctx.repo.commonDir);
  let port = 0;

  // Open tabs reconnect to the port they came from, so a restarted server takes the same one when it is free.
  const saved = opts.port ? null : savedPort(ctx.repo.commonDir);
  const listen = (at: number) => Bun.serve({
    hostname: "127.0.0.1",
    port: at,
    development: false,
    idleTimeout: 60,
    routes: {
      "/": index,
      "/diffs-worker.js": new Response(diffsWorker, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "max-age=86400" } }),
    },
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
      if (!hostAllowed(req, port)) return new Response("forbidden host", { status: 403 });
      const cookie = `stet_${port}`;
      if (url.pathname === "/api/session" && req.method === "GET") {
        const pairs = (req.headers.get("cookie") ?? "").matchAll(/(?:^|;\s*)([^=;]+)=([^;]*)/g);
        for (const m of pairs) if (m[1] === cookie && tokenMatches(m[2]!, token)) return Response.json({ token });
        return Response.json({ error: { code: "unauthorized", message: "no session: open the URL that stet serve printed" } }, { status: 401 });
      }
      const given = req.headers.get("x-stet-token") ?? url.searchParams.get("token");
      if (!tokenMatches(given, token)) return Response.json({ error: { code: "unauthorized", message: "missing or bad token" } }, { status: 401 });
      if (url.pathname === "/api/session" && req.method === "POST") {
        return Response.json({ ok: true }, { headers: { "set-cookie": `${cookie}=${token}; Path=/api/session; HttpOnly; SameSite=Strict` } });
      }
      if (url.pathname === "/api/events") {
        srv.timeout(req, 0);
        const reviewId = url.searchParams.get("review");
        const lastId = req.headers.get("last-event-id") ?? url.searchParams.get("since");
        return eventStream(state, req, reviewId ? Number(reviewId) : null, lastId ? Number(lastId) : ctx.store.maxSeq());
      }
      return handleApi(state, req, url);
    },
  });
  let server: ReturnType<typeof listen>;
  try {
    server = listen(opts.port || saved || 0);
  } catch (e) {
    if (!saved) throw e;
    server = listen(0);
  }
  port = server.port!;
  savePort(ctx.repo.commonDir, port);
  const info: ServerInfo = {
    pid: process.pid,
    port,
    token,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    startedAt: new Date().toISOString(),
  };
  writeServerInfo(ctx.repo.commonDir, info);
  const stop = () => {
    removeServerInfo(ctx.repo.commonDir, process.pid);
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const url = reviewUrl(info, review?.id);
  report({ ...info, url }, opts, false);
  if (opts.open) openBrowser(url);
  await new Promise(() => {});
  return 0;
}

// A server started by an agent's shell dies with it: harnesses stop background commands after a time limit.
// Detached, it runs in its own systemd unit, or its own session.
async function startDetached(ctx: Ctx, opts: ServeOptions): Promise<ServerInfo | null> {
  const compiled = Bun.main.startsWith("/$bunfs/") || /^[A-Z]:[\\/]~BUN[\\/]/i.test(Bun.main);
  const self = compiled ? [process.execPath] : [process.execPath, Bun.main];
  const args = [...self, "serve", "--port", String(opts.port || 0), ...(opts.branch ? ["--branch", opts.branch] : [])];
  // The user manager's PATH may lack the git the shell finds (nix, asdf, linuxbrew).
  const env = Object.entries(process.env).filter(([k]) => k.startsWith("STET_") || k === "PATH");
  const unit = `stet-${basename(ctx.repo.toplevel ?? ctx.repo.cwd).replace(/[^\w.-]/g, "_")}-${Date.now().toString(36)}`;
  const systemd = Bun.which("systemd-run") && process.env.XDG_RUNTIME_DIR
    ? Bun.spawnSync([
        "systemd-run", "--user", "--collect", "--quiet", "--property=StandardOutput=null", `--unit=${unit}`,
        `--working-directory=${ctx.repo.cwd}`, ...env.map(([k, v]) => `--setenv=${k}=${v}`), "--", ...args,
      ], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
    : false;
  if (systemd) {
    const info = await waitForServer(ctx, 50);
    if (info) return info;
  }
  Bun.spawn(args, { cwd: ctx.repo.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
  return waitForServer(ctx, 100);
}

async function waitForServer(ctx: Ctx, tries: number): Promise<ServerInfo | null> {
  for (let i = 0; i < tries; i++) {
    await Bun.sleep(100);
    const info = await readServerInfo(ctx.repo.commonDir);
    if (info) return info;
  }
  return null;
}

/** Stops the repository's server, wherever it was started. */
export async function stopServer(ctx: Ctx): Promise<boolean> {
  const info = await readServerInfo(ctx.repo.commonDir);
  if (!info) return false;
  process.kill(info.pid, "SIGTERM");
  for (let i = 0; i < 50 && (await readServerInfo(ctx.repo.commonDir)); i++) await Bun.sleep(100);
  return true;
}

function report(info: ServerInfo, opts: ServeOptions, reused: boolean): void {
  if (opts.json || !process.stdout.isTTY) console.log(JSON.stringify({ url: info.url, pid: info.pid, port: info.port, reused }));
  else if (opts.printUrlOnly) console.log(info.url);
  else console.log(`${reused ? "already running" : "stet review UI"}: ${info.url}`);
}
