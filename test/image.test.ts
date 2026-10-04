import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { imageSize, imageType, isPixelImage, svgSize } from "../src/core/image.ts";
import { stet, ok } from "./helpers/cli.ts";
import { Fixture, GIT_ENV } from "./helpers/fixture.ts";
import { card, png } from "./helpers/png.ts";

describe("imageSize", () => {
  test("reads PNG, GIF, JPEG, WebP, BMP and AVIF headers", () => {
    expect(imageSize(png(37, 12, () => [0, 0, 0, 255]))).toEqual({ w: 37, h: 12 });
    const gif = new Uint8Array(32);
    gif.set(new TextEncoder().encode("GIF89a"));
    gif.set([0x40, 0x01, 0xc8, 0x00], 6);
    expect(imageSize(gif)).toEqual({ w: 320, h: 200 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, ...new Array(16).fill(0)]);
    expect(imageSize(jpeg)).toEqual({ w: 600, h: 300 });
    const vp8x = new Uint8Array(32);
    vp8x.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
    vp8x.set([0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00], 24);
    expect(imageSize(vp8x)).toEqual({ w: 640, h: 480 });
    const vp8l = new Uint8Array(32);
    vp8l.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8L"));
    // 1 + 99 = 100 wide, 1 + 49 = 50 high
    const bits = 99 | (49 << 14);
    vp8l.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 20);
    expect(imageSize(vp8l)).toEqual({ w: 100, h: 50 });
    const bmp = new Uint8Array(32);
    bmp.set(new TextEncoder().encode("BM"));
    bmp.set([0x10, 0, 0, 0, 0xf0, 0xff, 0xff, 0xff], 18);
    expect(imageSize(bmp)).toEqual({ w: 16, h: 16 });
    const avif = new Uint8Array(64);
    avif.set(new TextEncoder().encode("\0\0\0\x1cftypavif"));
    avif.set(new TextEncoder().encode("ispe"), 40);
    avif.set([0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0], 44);
    expect(imageSize(avif)).toEqual({ w: 768, h: 512 });
    expect(imageSize(new TextEncoder().encode("not an image at all, just text"))).toBeNull();
  });

  test("reads an SVG's size from width and height, or from its viewBox", () => {
    expect(svgSize(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="24px" height="16" viewBox="0 0 48 32">`)).toEqual({ w: 24, h: 16 });
    expect(svgSize(`<svg viewBox="0 0 120.5 80" xmlns="http://www.w3.org/2000/svg"><rect/></svg>`)).toEqual({ w: 121, h: 80 });
    expect(svgSize(`<svg width="100%" height="100%" viewBox="0,0,200,100">`)).toEqual({ w: 200, h: 100 });
    expect(svgSize(`<svg width="50" viewBox="0 0 200 100">`)).toEqual({ w: 50, h: 25 });
    expect(svgSize(`<svg width="2em" height="1em">`)).toBeNull();
    expect(svgSize(`<html><body>no svg</body></html>`)).toBeNull();
  });

  test("tells images by extension; svg is an image but not a pixel one", () => {
    expect(imageType("a/B.PNG")).toBe("image/png");
    expect(imageType("x.kt")).toBeNull();
    expect(isPixelImage("icon.webp")).toBe(true);
    expect(isPixelImage("icon.svg")).toBe(false);
  });
});

describe("threads on an area of an image", () => {
  const f = new Fixture();
  const put = (rel: string, bytes: Uint8Array) => {
    mkdirSync(dirname(f.path(rel)), { recursive: true });
    writeFileSync(f.path(rel), bytes);
  };
  const reviewer = { cwd: f.root, role: "reviewer" as const };
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let base = "";
  let token = "";
  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { "x-stet-token": token, "content-type": "application/json", ...(init.headers ?? {}) } });

  beforeAll(async () => {
    put("img/card.png", card(120, 80, { bar: { y: 0, h: 20, color: [40, 90, 200, 255] } }));
    put("img/keep.png", card(40, 40));
    f.write("img/icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="8" height="8" fill="red"/></svg>\n`);
    f.write("a.kt", "val a = 1\n");
    f.commit("init");
    f.git(["checkout", "-q", "-b", "feat"]);
    put("img/card.png", card(120, 80, { bar: { y: 0, h: 20, color: [200, 60, 60, 255] } }));
    put("img/new.png", card(60, 90, { box: { x: 10, y: 10, w: 20, h: 20, color: [0, 160, 80, 255] } }));
    f.write("img/icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="4" y="2" width="8" height="8" fill="red"/></svg>\n`);
    await ok(stet(["version", "create"], { cwd: f.root }));
  });

  afterAll(() => {
    proc?.kill();
    f.cleanup();
  });

  test("a region thread follows the image across versions", async () => {
    const t = await ok(stet(["comment", "add", "--file", "img/card.png", "--region", "10,5,50,300", "--at", "1", "--body", "bar color?"], reviewer));
    expect(t.region).toEqual({ x: 10, y: 5, w: 50, h: 75, iw: 120, ih: 80 });
    expect(t.excerpt).toEqual([]);
    const keep = await ok(stet(["comment", "add", "--file", "img/keep.png", "--region", "0,0,10,10", "--at", "1", "--body", "untouched"], reviewer));

    put("img/card.png", card(120, 80, { bar: { y: 0, h: 20, color: [40, 160, 90, 255] } }));
    f.git(["mv", "img/keep.png", "img/kept.png"]);
    await ok(stet(["version", "create"], { cwd: f.root }));
    const list = (await ok(stet(["threads", "list", "--status", "all"], { cwd: f.root }))) as { id: number; anchor: { state: string; path: string } }[];
    expect(list.find((x) => x.id === t.id)!.anchor.state).toBe("changed");
    expect(list.find((x) => x.id === keep.id)!.anchor).toMatchObject({ state: "moved", path: "img/kept.png" });

    f.rm("img/card.png");
    await ok(stet(["version", "create"], { cwd: f.root }));
    const d = await ok(stet(["thread", "show", String(t.id)], { cwd: f.root }));
    expect(d.timeline.map((s: { state: string }) => s.state)).toEqual(["ok", "changed", "outdated"]);
    expect(d.code.then).toBeNull();
    expect(existsSync(d.image.shot)).toBe(true);
    expect(d.image.crop).toBeNull();
    expect(imageSize(readFileSync(d.image.shot))).toEqual({ w: 120, h: 80 });

    const text = (await stet(["thread", "show", String(t.id)], { cwd: f.root })).stdout;
    expect(JSON.parse(text).thread.region.w).toBe(50);
  });

  test("an SVG is an image too: a region in its own units, the thread changes with the file", async () => {
    const t = await ok(stet(["comment", "add", "--file", "img/icon.svg", "--region", "2,2,10,10", "--at", "1", "--body", "the square moved"], reviewer));
    expect(t.region).toEqual({ x: 2, y: 2, w: 10, h: 10, iw: 24, ih: 24 });
    f.write("img/icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="8" height="8" fill="red"/></svg>\n`);
    await ok(stet(["version", "create"], { cwd: f.root }));
    const d = await ok(stet(["thread", "show", String(t.id)], { cwd: f.root }));
    expect(d.timeline.at(-1).state).toBe("changed");
    expect(readFileSync(d.image.shot, "utf8")).toContain("<svg");
  });

  test("CLI rejects a region on a text file", async () => {
    const r = await stet(["comment", "add", "--file", "a.kt", "--region", "0,0,1,1", "--body", "x"], reviewer);
    expect(r.code).not.toBe(0);
    expect(r.stderr + r.stdout).toContain("is not an image");
  });

  test("the server serves image bytes and keeps the browser's shots", async () => {
    proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--json"], { cwd: f.root, env: { ...process.env, ...GIT_ENV }, stdout: "pipe", stderr: "pipe" });
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    const info = JSON.parse(new TextDecoder().decode(value));
    base = `http://127.0.0.1:${info.port}`;
    token = info.url.split("token=")[1];

    const cmp = await (await api("/api/compare?from=base&to=1")).json();
    const file = cmp.files.find((x: { path: string }) => x.path === "img/card.png");
    expect(file.image).toEqual({ old: { w: 120, h: 80, bytes: expect.any(Number) }, new: { w: 120, h: 80, bytes: expect.any(Number) } });
    expect(cmp.files.find((x: { path: string }) => x.path === "img/new.png").image.old).toBeNull();
    expect(cmp.files.find((x: { path: string }) => x.path === "img/icon.svg").image).toEqual({ old: { w: 24, h: 24, bytes: expect.any(Number) }, new: { w: 24, h: 24, bytes: expect.any(Number) } });

    const raw = await fetch(`${base}/api/raw?sha=${cmp.to.sha}&path=img/new.png&token=${token}`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("image/png");
    expect(raw.headers.get("content-security-policy")).toContain("sandbox");
    expect(imageSize(new Uint8Array(await raw.arrayBuffer()))).toEqual({ w: 60, h: 90 });
    expect((await fetch(`${base}/api/raw?sha=${cmp.to.sha}&path=img/new.png`)).status).toBe(401);
    expect((await api(`/api/raw?sha=${cmp.to.sha}&path=a.kt`)).status).toBe(400);

    const shot = Buffer.from(png(60, 90, () => [255, 0, 0, 255])).toString("base64");
    const crop = Buffer.from(png(20, 20, () => [0, 0, 255, 255])).toString("base64");
    const res = await api("/api/threads", { method: "POST", body: JSON.stringify({ path: "img/new.png", start: 1, end: 1, at: cmp.to.sha, body: "box", draft: false, region: { x: 10, y: 10, w: 20, h: 20 }, shot: { full: shot, crop } }) });
    const t = await res.json();
    expect(t.region).toEqual({ x: 10, y: 10, w: 20, h: 20, iw: 60, ih: 90 });
    const d = await ok(stet(["thread", "show", String(t.id)], { cwd: f.root }));
    expect(imageSize(readFileSync(d.image.shot))).toEqual({ w: 60, h: 90 });
    expect(imageSize(readFileSync(d.image.crop))).toEqual({ w: 20, h: 20 });
    const bad = await api("/api/threads", { method: "POST", body: JSON.stringify({ path: "img/new.png", start: 1, end: 1, at: cmp.to.sha, body: "x", region: { x: 0, y: 0, w: 5, h: 5 }, shot: { full: Buffer.from("nope").toString("base64") } }) });
    expect(bad.status).toBe(400);
  });
});
