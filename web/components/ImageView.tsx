import { useEffect, useRef, useState } from "preact/hooks";
import type { AnchorState, ImageInfo, Region, ThreadDetail, TimelineStepDto } from "../../src/core/types.ts";
import { isSvg } from "../../src/core/image.ts";
import { api, rawUrl } from "../api.ts";
import { compareData, hoverThread, imageMode, imagePending, shownPlacements, type ImageMode, type ImagePending } from "../compare.ts";
import { cropRect, dragRegion, framePercent, imageCaption, pixelDiff, regionLabel, scaleRegion, shotScale, type PixelDiff } from "../lib/image.ts";
import { compareFocus, guard, link, notify, reloadAll, reviewId, threads } from "../state.ts";
import { Composer } from "./Composer.tsx";

export interface Frame {
  /** null: the area being commented on, not a thread yet. */
  id: number | null;
  region: Region;
  tone: "thread" | "focus" | "changed" | "outdated" | "pending";
}

const toneOf = (s: AnchorState): Frame["tone"] => (s === "changed" ? "changed" : s === "outdated" ? "outdated" : "thread");
/** Icons and other small pictures are shown at least this big, without smoothing. */
const SMALL = 160;

function FrameBox({ f }: { f: Frame }) {
  const style = framePercent(f.region);
  if (f.id === null) return <div class={`img-frame tone-${f.tone}`} style={style} />;
  const id = f.id;
  const t = threads.value.find((x) => x.id === id);
  return (
    <a
      class={`img-frame tone-${f.tone}${compareFocus.value === id ? " focused" : ""}${hoverThread.value === id ? " hover" : ""}`}
      style={style}
      title={t ? `#${id} ${t.title}` : `#${id}`}
      data-thread={id}
      onMouseEnter={() => (hoverThread.value = id)}
      onMouseLeave={() => hoverThread.value === id && (hoverThread.value = null)}
      {...link({ name: "thread", id })}
    >
      <span class="img-frame-tag">#{id}</span>
    </a>
  );
}

function displayWidth(w: number, h: number): number {
  return Math.max(w, h) < SMALL ? w * shotScale(w, h, Infinity, SMALL) : w;
}

// An SVG may have no size of its own (only a viewBox): give it one, or it is drawn 0 × 0.
function paneSize(path: string, nat: { w: number; h: number } | null) {
  if (!nat) return undefined;
  if (isSvg(path)) return { width: `min(${displayWidth(nat.w, nat.h)}px, calc(70vh * ${nat.w / nat.h}))`, aspectRatio: `${nat.w} / ${nat.h}` };
  return Math.max(nat.w, nat.h) < SMALL ? { width: `${displayWidth(nat.w, nat.h)}px` } : undefined;
}

/** One image with thread frames over it; with `onDraw`, a drag on it marks an area. */
export function ImagePane(props: { sha: string; path: string; label?: string; size?: ImageInfo | null; frames: Frame[]; onDraw?: (r: Region) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const known = props.size?.w && props.size?.h ? { w: props.size.w, h: props.size.h } : null;
  const [nat, setNat] = useState<{ w: number; h: number } | null>(known);
  const [drag, setDrag] = useState<{ a: { fx: number; fy: number }; b: { fx: number; fy: number } } | null>(null);
  const [failed, setFailed] = useState(false);
  const at = (e: PointerEvent) => {
    const r = img.current!.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
  };
  const draw = props.onDraw && nat ? props.onDraw : null;
  const live = drag && nat ? dragRegion(drag.a, drag.b, nat.w, nat.h) : null;
  if (failed) return <div class="note">{props.path} could not be shown at this version.</div>;
  return (
    <figure class="imgpane">
      {props.label ? <figcaption>{props.label}</figcaption> : null}
      <div
        class={`imgbox${draw ? " drawable" : ""}`}
        onPointerDown={(e) => {
          if (!draw || e.button !== 0 || (e.target as Element).closest(".img-frame")) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const p = at(e);
          setDrag({ a: p, b: p });
        }}
        onPointerMove={(e) => drag && setDrag({ ...drag, b: at(e) })}
        onPointerUp={(e) => {
          if (!drag || !draw || !nat) return;
          setDrag(null);
          const r = dragRegion(drag.a, at(e), nat.w, nat.h);
          const shown = img.current!.getBoundingClientRect();
          if (r && (r.w / nat.w) * shown.width >= 4 && (r.h / nat.h) * shown.height >= 4) draw({ ...r, iw: nat.w, ih: nat.h });
        }}
        onPointerCancel={() => setDrag(null)}
      >
        <img
          ref={img}
          src={rawUrl(props.sha, props.path)}
          alt={props.path}
          draggable={false}
          width={nat?.w}
          height={nat?.h}
          class={nat && Math.max(nat.w, nat.h) < SMALL && !isSvg(props.path) ? "pixelated" : ""}
          style={paneSize(props.path, nat)}
          onLoad={(e) => {
            const el = e.currentTarget as HTMLImageElement;
            // an SVG with only a viewBox gets a made-up natural size (300 px): keep the one the server read
            if (!isSvg(props.path) && (!nat || nat.w !== el.naturalWidth || nat.h !== el.naturalHeight)) setNat({ w: el.naturalWidth, h: el.naturalHeight });
          }}
          onError={() => setFailed(true)}
        />
        {nat ? props.frames.map((f) => <FrameBox key={f.id ?? "new"} f={f} />) : null}
        {live && nat ? <div class="img-frame tone-pending drawing" style={framePercent({ ...live, iw: nat.w, ih: nat.h })} /> : null}
      </div>
    </figure>
  );
}

interface Side {
  sha: string;
  path: string;
  label: string;
  info: ImageInfo;
}

/** Old and new on top of each other: a divider (swipe) or the new one's opacity (onion) shows how they differ. */
function ImageStack({ a, b, mode, frames }: { a: Side; b: Side; mode: "swipe" | "onion"; frames: Frame[] }) {
  const [pos, setPos] = useState(50);
  const [held, setHeld] = useState(false);
  const W = Math.max(a.info.w!, b.info.w!);
  const H = Math.max(a.info.h!, b.info.h!);
  const scale = displayWidth(W, H) / W;
  const move = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPos(Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))));
  };
  const clip = mode === "swipe" ? `inset(0 0 0 ${(pos * W) / b.info.w!}%)` : undefined;
  return (
    <div class="imgstack-wrap">
      <div class="imgstack-labels">
        <span>{mode === "swipe" ? `◀ ${a.label}` : `${a.label} under`}</span>
        <span>{mode === "swipe" ? `${b.label} ▶` : `${b.label} over it at ${pos}%`}</span>
      </div>
      <div
        class={`imgstack mode-${mode}`}
        style={{ aspectRatio: `${W} / ${H}`, width: `min(${W * scale}px, calc(70vh * ${W / H}))` }}
        onPointerDown={(e) => {
          if (mode !== "swipe" || (e.target as Element).closest(".img-frame")) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setHeld(true);
          move(e);
        }}
        onPointerMove={(e) => held && move(e)}
        onPointerUp={() => setHeld(false)}
      >
        <img class={scale > 1 && !isSvg(a.path) ? "pixelated" : ""} src={rawUrl(a.sha, a.path)} alt={a.path} draggable={false} style={{ width: `${(a.info.w! / W) * 100}%` }} />
        <div class="imgstack-top" style={{ width: `${(b.info.w! / W) * 100}%`, clipPath: clip, opacity: mode === "onion" ? pos / 100 : 1 }}>
          <img class={scale > 1 && !isSvg(b.path) ? "pixelated" : ""} src={rawUrl(b.sha, b.path)} alt={b.path} draggable={false} />
          {frames.map((f) => <FrameBox key={f.id ?? "new"} f={f} />)}
        </div>
        {mode === "swipe" ? <div class="imgstack-divider" style={{ left: `${pos}%` }} /> : null}
      </div>
      <input type="range" class="imgstack-range" min={0} max={100} value={pos} aria-label={mode === "swipe" ? "divider" : "opacity of the new image"} onInput={(e) => setPos(Number((e.target as HTMLInputElement).value))} />
    </div>
  );
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function pixels(img: HTMLImageElement, w: number, h: number, dw: number, dh: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, w, h).data;
}

const unscale = (r: { x: number; y: number; w: number; h: number }, k: number, iw: number, ih: number): Region => ({
  x: Math.floor(r.x / k),
  y: Math.floor(r.y / k),
  w: Math.max(1, Math.round(r.w / k)),
  h: Math.max(1, Math.round(r.h / k)),
  iw,
  ih,
});

/** Changed pixels in magenta over the new image, faded. */
function ImageDifference({ a, b }: { a: Side; b: Side }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [result, setResult] = useState<PixelDiff | "big" | "error" | null>(null);
  const W = Math.max(a.info.w!, b.info.w!);
  const H = Math.max(a.info.h!, b.info.h!);
  // an SVG is drawn bigger, so a small icon is compared in more than its few hundred pixels
  const vector = isSvg(a.path) || isSvg(b.path);
  const k = vector ? Math.min(8, Math.max(1, 512 / Math.max(W, H))) : 1;
  const RW = Math.round(W * k);
  const RH = Math.round(H * k);
  useEffect(() => {
    let live = true;
    if (RW * RH > 24e6) {
      setResult("big");
      return;
    }
    Promise.all([loadImage(rawUrl(a.sha, a.path)), loadImage(rawUrl(b.sha, b.path))]).then(
      ([ia, ib]) => {
        if (!live || !canvas.current) return;
        const ctx = canvas.current.getContext("2d")!;
        const out = ctx.createImageData(RW, RH);
        const r = pixelDiff(pixels(ia, RW, RH, a.info.w! * k, a.info.h! * k), pixels(ib, RW, RH, b.info.w! * k, b.info.h! * k), RW, RH, out.data);
        ctx.putImageData(out, 0, 0);
        setResult(r);
      },
      () => live && setResult("error"),
    );
    return () => {
      live = false;
    };
  }, [a.sha, b.sha, a.path, b.path]);
  const scale = displayWidth(W, H) / W;
  const sizes = a.info.w !== b.info.w || a.info.h !== b.info.h ? ` · the sizes differ: both are drawn from the top left` : "";
  return (
    <div class="imgdiff-canvas">
      <div class="imgstack-labels">
        <span>
          {result === null
            ? "comparing pixels…"
            : result === "big"
              ? "too big to compare pixel by pixel here"
              : result === "error"
                ? "could not read the images"
                : result.changed === 0
                  ? `no pixel differs between ${a.label} and ${b.label}: the files differ in bytes only`
                  : `${result.changed.toLocaleString()} px differ (${((result.changed / result.total) * 100).toFixed(result.changed / result.total < 0.01 ? 2 : 1)}%) · all within ${regionLabel(unscale(result.box!, k, W, H))}${sizes}`}
        </span>
      </div>
      <div class="imgstack" style={{ aspectRatio: `${W} / ${H}`, width: `min(${W * scale}px, calc(70vh * ${W / H}))` }}>
        <canvas ref={canvas} width={RW} height={RH} class={!vector && scale > 1 ? "pixelated" : ""} />
        {result && typeof result === "object" && result.box ? <div class="img-frame tone-change-box" style={framePercent({ ...result.box, iw: RW, ih: RH })} /> : null}
      </div>
    </div>
  );
}

async function pngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("could not encode the picture");
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What the agent opens: the whole image with the area framed and the rest dimmed, and the area itself at full size. */
export async function makeShots(sha: string, path: string, region: Region): Promise<{ full: string; crop: string }> {
  const img = await loadImage(rawUrl(sha, path));
  const vector = isSvg(path);
  const iw = vector ? region.iw : img.naturalWidth;
  const ih = vector ? region.ih : img.naturalHeight;
  const r = scaleRegion(region, iw, ih);
  // an SVG draws sharp at any size: a small one as big as a screenshot would be
  const grow = (w: number, h: number, least: number) => Math.min(1600, Math.max(least, w, h)) / Math.max(w, h);
  const s = vector ? grow(iw, ih, 800) : shotScale(iw, ih);
  const full = document.createElement("canvas");
  full.width = Math.round(iw * s);
  full.height = Math.round(ih * s);
  let ctx = full.getContext("2d")!;
  ctx.drawImage(img, 0, 0, full.width, full.height);
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.beginPath();
  ctx.rect(0, 0, full.width, full.height);
  ctx.rect(r.x * s, r.y * s, r.w * s, r.h * s);
  ctx.fill("evenodd");
  ctx.lineWidth = Math.max(2, Math.round(Math.max(full.width, full.height) / 300));
  ctx.strokeStyle = "#e5226b";
  ctx.strokeRect(r.x * s, r.y * s, r.w * s, r.h * s);

  const c = cropRect(r);
  const cs = vector ? grow(c.w, c.h, 320) : shotScale(c.w, c.h, 1600, 320);
  const crop = document.createElement("canvas");
  crop.width = Math.round(c.w * cs);
  crop.height = Math.round(c.h * cs);
  ctx = crop.getContext("2d")!;
  ctx.imageSmoothingEnabled = vector || cs <= 1;
  if (vector) ctx.drawImage(img, -c.x * cs, -c.y * cs, iw * cs, ih * cs);
  else ctx.drawImage(img, c.x, c.y, c.w, c.h, 0, 0, crop.width, crop.height);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#e5226b";
  ctx.strokeRect((r.x - c.x) * cs, (r.y - c.y) * cs, r.w * cs, r.h * cs);
  return { full: await pngBase64(full), crop: await pngBase64(crop) };
}

function NewImageThread({ p }: { p: ImagePending }) {
  const rid = reviewId.value;
  const cancel = () => (imagePending.value = null);
  const create = async (body: string, how: "draft" | "now") => {
    if (rid === null) return false;
    const shot = await makeShots(p.sha, p.path, p.region).catch(() => null);
    const t = await guard(api.addThread(rid, { path: p.path, start: 1, end: 1, side: p.side, at: p.sha, body, draft: how === "draft", region: p.region, shot }));
    if (!t) return false;
    imagePending.value = null;
    compareFocus.value = t.id;
    notify(how === "draft" ? `draft #${t.id} saved on an area of ${p.path} · the agent sees it after you submit the review` : `thread #${t.id} sent to the agent`, "info", {
      label: `open #${t.id}`,
      route: { name: "thread", id: t.id },
    });
    await reloadAll();
  };
  return (
    <div class="new-thread inline">
      <div class="note">
        New thread on an area of {p.path}
        {p.side === "old" ? " · the old image" : ""} ({p.label}) · {regionLabel(p.region)} · the agent gets the image with this area framed
      </div>
      <Composer
        storageKey={`new:${rid}:img:${p.sha}:${p.path}:${p.region.x},${p.region.y},${p.region.w},${p.region.h}`}
        autoFocus
        placeholder="What is wrong in this area?"
        onCancel={cancel}
        onSubmit={create}
        onEscape={(el) => el.blur()}
        secondaryLabel="Send now"
      />
    </div>
  );
}

const MODES: [ImageMode, string, string][] = [
  ["2-up", "side by side", "old and new next to each other; drag on either to comment"],
  ["swipe", "swipe", "new over old: drag the divider"],
  ["onion", "onion skin", "new over old: change its opacity"],
  ["diff", "difference", "changed pixels in magenta"],
];

/** An image file of the diff: added, deleted, or old and new compared in one of four ways. */
export function ImageDiff({ file }: { file: string }) {
  const d = compareData.value;
  const f = d?.files.find((x) => x.path === file);
  if (!d || !f) return null;
  const info = f.image ?? { old: null, new: null };
  const oldPath = f.oldPath ?? file;
  const a: Side | null = info.old ? { sha: d.from.sha, path: oldPath, label: d.from.label, info: info.old } : null;
  const b: Side | null = info.new ? { sha: d.to.sha, path: file, label: d.to.label, info: info.new } : null;
  const placed = shownPlacements.value.filter((p) => p.path === file);
  const pending = imagePending.value?.file === file ? imagePending.value : null;
  const frames = (side: "additions" | "deletions"): Frame[] => [
    ...placed.flatMap((p) => {
      const t = threads.value.find((x) => x.id === p.threadId);
      return p.side === side && t?.region ? [{ id: t.id, region: t.region, tone: toneOf(p.state) }] : [];
    }),
    ...(pending && (pending.side === "old") === (side === "deletions") ? [{ id: null, region: pending.region, tone: "pending" as const }] : []),
  ];
  const draw = (s: Side, side: "new" | "old") => (region: Region) => (imagePending.value = { file, path: s.path, side, sha: s.sha, label: s.label, region });
  const sized = a && b && a.info.w && a.info.h && b.info.w && b.info.h;
  const mode = a && b ? (sized ? imageMode.value : "2-up") : null;
  return (
    <div class="imgdiff" data-file={file}>
      <div class="imgdiff-bar">
        <span class="imgdiff-caption">{imageCaption(file, info)}</span>
        {a && b && sized ? (
          <span class="seg small">
            {MODES.map(([m, text, title]) => (
              <button class={mode === m ? "on" : ""} title={title} onClick={() => (imageMode.value = m)}>
                {text}
              </button>
            ))}
          </span>
        ) : null}
        <span class="hint">{mode === null || mode === "2-up" ? "drag on an image to comment on an area" : "frames show threads · comment in side by side"}</span>
      </div>
      {mode === null ? (
        b ? (
          <ImagePane key={`${b.sha}:${b.path}`} sha={b.sha} path={b.path} label={`${b.label} · added`} size={b.info} frames={frames("additions")} onDraw={draw(b, "new")} />
        ) : a ? (
          <ImagePane key={`${a.sha}:${a.path}`} sha={a.sha} path={a.path} label={`${a.label} · deleted after this`} size={a.info} frames={frames("deletions")} onDraw={draw(a, "old")} />
        ) : null
      ) : mode === "2-up" ? (
        <div class="imgpair">
          <ImagePane key={`${a!.sha}:${a!.path}`} sha={a!.sha} path={a!.path} label={a!.label} size={a!.info} frames={frames("deletions")} onDraw={draw(a!, "old")} />
          <ImagePane key={`${b!.sha}:${b!.path}`} sha={b!.sha} path={b!.path} label={b!.label} size={b!.info} frames={frames("additions")} onDraw={draw(b!, "new")} />
        </div>
      ) : mode === "diff" ? (
        <ImageDifference a={a!} b={b!} />
      ) : (
        <ImageStack a={a!} b={b!} mode={mode} frames={frames("additions")} />
      )}
      {pending ? <NewImageThread p={pending} /> : null}
    </div>
  );
}

/** The commented area of an image, with a margin, as a crop: on the thread page and in its timeline. */
export function RegionCrop({ sha, path, region, height, frame = true }: { sha: string; path: string; region: Region; height?: number; frame?: boolean }) {
  const c = cropRect(region);
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div class="region-crop" style={{ aspectRatio: `${c.w} / ${c.h}`, ...(height ? { height: `${height}px` } : { width: `min(100%, ${displayWidth(c.w, c.h) * 2}px, calc(60vh * ${c.w / c.h}))` }) }}>
      <img src={rawUrl(sha, path)} alt="" draggable={false} class={c.w < SMALL && !isSvg(path) ? "pixelated" : ""} style={{ width: pct(region.iw, c.w), left: pct(-c.x, c.w), top: pct(-c.y, c.h) }} />
      {frame ? <div class="img-frame tone-focus" style={{ left: pct(region.x - c.x, c.w), top: pct(region.y - c.y, c.h), width: pct(region.w, c.w), height: pct(region.h, c.h) }} /> : null}
    </div>
  );
}

/** A thread on an image, on its page: the area (or the whole image) at one step, or at two steps side by side. */
export function ImageArea({ d, from, to }: { d: ThreadDetail; from: TimelineStepDto; to: TimelineStepDto }) {
  const region = d.thread.region!;
  const [whole, setWhole] = useState(false);
  const single = from.index === to.index;
  const changed = d.timeline.slice(Math.min(from.index, to.index) + 1, Math.max(from.index, to.index) + 1).some((s) => s.method === "image");
  const pane = (s: TimelineStepDto) =>
    !s.path ? (
      <div class="note">At {s.label} the image is gone ({s.reason ?? "outdated"}).</div>
    ) : whole ? (
      <ImagePane key={`${s.sha}:${s.path}`} sha={s.sha} path={s.path} label={s.label} size={isSvg(s.path) ? { w: region.iw, h: region.ih, bytes: 0 } : null} frames={[{ id: null, region, tone: "focus" }]} />
    ) : (
      <figure class="imgpane">
        <figcaption>{s.label}</figcaption>
        <RegionCrop sha={s.sha} path={s.path} region={region} />
      </figure>
    );
  const label = single
    ? to.index === 0
      ? `The commented area of ${d.thread.path} as it was at ${to.label}, when the thread started`
      : `The commented area at ${to.label}`
    : !to.path
      ? `At ${to.label} the image is gone; at ${from.label} it was:`
      : changed
        ? `How the image changed from ${from.label} to ${to.label}`
        : `The image did not change from ${from.label} to ${to.label}`;
  return (
    <>
      <div class="code-label">
        <span>{label}</span>
        <span class="spacer" />
        <span class="hint">{regionLabel(region)} px</span>
        <span class="seg small">
          <button class={whole ? "" : "on"} onClick={() => setWhole(false)}>the area</button>
          <button class={whole ? "on" : ""} onClick={() => setWhole(true)}>whole image</button>
        </span>
      </div>
      <div class="image-area">{single || (!changed && to.path) ? pane(to) : <div class="imgpair">{pane(from)}{pane(to)}</div>}</div>
    </>
  );
}

/** A small crop of the area at one timeline step. */
export function RegionThumb({ sha, path, region }: { sha: string; path: string; region: Region }) {
  return <RegionCrop sha={sha} path={path} region={region} height={36} frame={false} />;
}
