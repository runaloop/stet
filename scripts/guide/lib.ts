import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bidi } from "../../test/perf/bidi.ts";

export const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "cli.ts");
export const OUT = join(ROOT, "docs", "guide");
const env = { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" };

export interface Rect { x: number; y: number; w: number; h: number }
export interface Note {
  html: string;
  at: { x: number; y: number };
  to?: { x: number; y: number };
  ring?: Rect;
  w?: number;
}

async function firstMatch(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<string> {
  const reader = stream.getReader();
  let buf = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);
    if (done) break;
    buf += new TextDecoder().decode(value);
    const m = re.exec(buf);
    if (m) {
      reader.releaseLock();
      return m[1] ?? m[0];
    }
  }
  throw new Error(`no ${re} in: ${buf.slice(0, 300)}`);
}

export class Demo {
  // A fixed path: the shots show it.
  readonly repo = Demo.fresh(join(tmpdir(), "stet-guide", "shop"));

  private static fresh(dir: string): string {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    return realpathSync(dir);
  }

  write(path: string, text: string) {
    mkdirSync(dirname(join(this.repo, path)), { recursive: true });
    writeFileSync(join(this.repo, path), text);
  }
  remove(path: string) {
    rmSync(join(this.repo, path));
  }
  run(cmd: string[]): string {
    const r = Bun.spawnSync(cmd, { cwd: this.repo, env });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
  }
  git(...args: string[]) {
    return this.run(["git", ...args]);
  }
  stet(...args: string[]) {
    return JSON.parse(this.run(["bun", CLI, ...args, "--json"]));
  }
  commitBase() {
    this.git("init", "-q", "-b", "main");
    this.git("add", "-A");
    this.git("commit", "-q", "-m", "base");
    this.git("checkout", "-q", "-b", "feature");
  }
  dispose() {
    rmSync(this.repo, { recursive: true, force: true });
  }
}

const ANNOTATE = `window.__annotate = (items) => {
  document.getElementById("__ann")?.remove();
  const root = document.createElement("div");
  root.id = "__ann";
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:9999";
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", innerWidth);
  svg.setAttribute("height", innerHeight);
  svg.style.cssText = "position:absolute;inset:0;overflow:visible";
  svg.innerHTML = '<defs><marker id="ah" markerWidth="14" markerHeight="14" refX="12" refY="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L14,7 L0,14 z" fill="#e5226b"/></marker></defs>';
  root.appendChild(svg);
  document.body.appendChild(root);
  for (const it of items) {
    if (it.ring) {
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", it.ring.x - 4); r.setAttribute("y", it.ring.y - 4);
      r.setAttribute("width", it.ring.w + 8); r.setAttribute("height", it.ring.h + 8);
      r.setAttribute("rx", 8); r.setAttribute("fill", "none"); r.setAttribute("stroke", "#e5226b"); r.setAttribute("stroke-width", 3); r.setAttribute("stroke-dasharray", "8 5");
      svg.appendChild(r);
    }
    const box = document.createElement("div");
    box.innerHTML = it.html;
    box.style.cssText = "position:absolute;background:#e5226b;color:#fff;font:600 15px/1.4 system-ui,sans-serif;padding:8px 12px;border-radius:9px;box-shadow:0 4px 16px rgba(0,0,0,.28)";
    box.style.maxWidth = (it.w || 330) + "px";
    box.style.left = it.at.x + "px";
    box.style.top = it.at.y + "px";
    root.appendChild(box);
    if (!it.to) continue;
    const b = box.getBoundingClientRect();
    const sx = Math.min(Math.max(it.to.x, b.left), b.right), sy = Math.min(Math.max(it.to.y, b.top), b.bottom);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", sx); line.setAttribute("y1", sy); line.setAttribute("x2", it.to.x); line.setAttribute("y2", it.to.y);
    line.setAttribute("stroke", "#e5226b"); line.setAttribute("stroke-width", 4); line.setAttribute("marker-end", "url(#ah)");
    svg.appendChild(line);
  }
  return true;
};
true`;

export class Page {
  constructor(readonly b: Bidi, readonly url: string) {}

  sleep(ms: number) {
    return this.b.eval(`new Promise(r => setTimeout(r, ${ms}))`);
  }
  waitFor(expr: string, ms = 8000) {
    return this.b.eval(`new Promise(r => { const end = Date.now() + ${ms}; const t = () => { let v; try { v = ${expr}; } catch { v = null; } if (v || Date.now() > end) r(v ?? null); else setTimeout(t, 50); }; t(); })`);
  }
  eval(expr: string) {
    return this.b.eval(expr);
  }
  async go(hash: string) {
    await this.b.eval(`location.hash = ${JSON.stringify(hash)}; true`);
  }
  pointer(actions: unknown[]) {
    return this.b.send("input.performActions", { context: this.b.context, actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions }] });
  }
  keys(...ks: string[]) {
    return this.b.send("input.performActions", { context: this.b.context, actions: [{ type: "key", id: "kbd", actions: ks.flatMap((k) => [{ type: "keyDown", value: k }, { type: "keyUp", value: k }]) }] });
  }
  async click(r: Rect, times = 1) {
    const x = r.x + Math.round(r.w / 2), y = r.y + Math.round(r.h / 2);
    await this.pointer([{ type: "pointerMove", x, y }, ...Array.from({ length: times }, () => [{ type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }]).flat()]);
  }
  rect(sel: string, match?: string): Promise<Rect | null> {
    return this.b.eval(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(sel)})]; const el = ${match ? `els.find(e => e.textContent.includes(${JSON.stringify(match)}))` : "els[0]"}; const r = el?.getBoundingClientRect(); return r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null; })()`);
  }
  async need(sel: string, match?: string): Promise<Rect> {
    const r = await this.rect(sel, match);
    if (!r) throw new Error(`nothing matches ${sel}${match ? ` with "${match}"` : ""}`);
    return r;
  }
  /** Text inside a pierre shadow root; `container` selects the diffs-container host. */
  textRect(container: string, text: string, last = false): Promise<Rect | null> {
    return this.b.eval(`(() => { const c = document.querySelector(${JSON.stringify(container)}); if (!c) return null; const hits = []; const walker = document.createTreeWalker(c.shadowRoot, 4); for (let n = walker.nextNode(); n; n = walker.nextNode()) { const i = n.nodeValue.indexOf(${JSON.stringify(text)}); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + ${text.length}); const b = r.getBoundingClientRect(); if (b.width) hits.push({ x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }); } } return ${last ? "hits[hits.length - 1]" : "hits[0]"} ?? null; })()`);
  }
  async shot(name: string, notes: Note[]) {
    await this.b.eval(ANNOTATE);
    await this.b.eval(`__annotate(${JSON.stringify(notes)}); true`);
    await this.sleep(300);
    await this.b.screenshot(join(OUT, name));
    await this.b.eval(`document.getElementById("__ann")?.remove(); true`);
  }
}

/** Serves the demo repository and opens it in headless Firefox at 1920×1080. */
export async function withBrowser(demo: Demo, fn: (p: Page) => Promise<void>) {
  const server = Bun.spawn(["bun", CLI, "serve", "--json"], { cwd: demo.repo, env, stdout: "pipe", stderr: "ignore" });
  const prof = join(ROOT, "perf-out", "guide-prof");
  rmSync(prof, { recursive: true, force: true });
  mkdirSync(prof, { recursive: true });
  const firefox = Bun.spawn(["firefox", "--headless", "--no-remote", "--profile", prof, `--remote-debugging-port=${9600 + Math.floor(Math.random() * 90)}`], { stdout: "ignore", stderr: "pipe" });
  try {
    const url = JSON.parse(await firstMatch(server.stdout as ReadableStream<Uint8Array>, /^(\{.*\})$/m, 20_000)).url as string;
    const ws = await firstMatch(firefox.stderr as ReadableStream<Uint8Array>, /WebDriver BiDi listening on (ws:\/\/\S+)/, 30_000);
    const b = await Bidi.connect(`${ws}/session`);
    await b.viewport(1920, 1080);
    await b.navigate(url);
    await fn(new Page(b, url));
    await b.close();
  } finally {
    firefox.kill();
    server.kill();
    rmSync(prof, { recursive: true, force: true });
  }
}

/** Renders HTML pages to PNG files in headless Firefox: demo pictures for a diff. Returns what `measure` gives on each page. */
export async function renderPngs(pages: { html: string; w: number; h: number; to: string; dpr?: number; measure?: string }[]): Promise<unknown[]> {
  const prof = join(ROOT, "perf-out", "guide-mock-prof");
  rmSync(prof, { recursive: true, force: true });
  mkdirSync(prof, { recursive: true });
  const firefox = Bun.spawn(["firefox", "--headless", "--no-remote", "--profile", prof, `--remote-debugging-port=${9500 + Math.floor(Math.random() * 90)}`], { stdout: "ignore", stderr: "pipe" });
  try {
    const ws = await firstMatch(firefox.stderr as ReadableStream<Uint8Array>, /WebDriver BiDi listening on (ws:\/\/\S+)/, 30_000);
    const b = await Bidi.connect(`${ws}/session`);
    const out: unknown[] = [];
    for (const p of pages) {
      await b.viewport(p.w, p.h, p.dpr);
      await b.navigate(`data:text/html;base64,${Buffer.from(p.html).toString("base64")}`);
      await b.eval(`new Promise(r => setTimeout(r, 200))`);
      out.push(p.measure ? await b.eval(p.measure) : null);
      mkdirSync(dirname(p.to), { recursive: true });
      await b.screenshot(p.to);
    }
    await b.close();
    return out;
  } finally {
    firefox.kill();
    rmSync(prof, { recursive: true, force: true });
  }
}
