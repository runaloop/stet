import "./web.css";
import { imageType } from "../../src/core/media.ts";
import { drawnFiles, setFileView } from "../../web/compare.ts";
import type { Binding } from "../../web/keys.ts";
import type { WebModule } from "../../web/modules.tsx";
import { threads } from "../../web/state.ts";
import { isPixelImage, isSvg } from "./core.ts";
import { ImageArea, ImageDiff, ImagePane, RegionThumb } from "./ImageView.tsx";
import { zoomKey } from "./ImageZoom.tsx";
import { imagePending } from "./state.ts";

const zoom = (where: "compare" | "thread"): Binding[] => [
  { keys: "+", desc: "zoom in on the picture under the mouse (or the one in sight)", where, run: () => zoomKey(1) },
  { keys: "=", desc: "zoom in on the picture (same as +)", where, run: () => zoomKey(1) },
  { keys: "-", desc: "zoom out of the picture", where, run: () => zoomKey(-1) },
  { keys: "0", desc: "fit the picture in its place again", where, run: () => zoomKey(0) },
];

export default {
  id: "images",
  viewers: [
    {
      kind: "image",
      match: (path) => imageType(path) !== null,
      cssClass: "img-anno",
      // a picture for an image git calls binary, or for an SVG unless the reader picked its code or lines of it have threads
      wants(fd, placed, view) {
        if (fd.hunks.length === 0 && isPixelImage(fd.name)) return true;
        if (!isSvg(fd.name)) return false;
        if (view) return view === "picture";
        return !(placed ?? []).some((p) => !threads.peek().find((t) => t.id === p.threadId)?.region);
      },
      picture: isPixelImage,
      switchable: isSvg,
      header: (path) =>
        isSvg(path) ? (
          <button class="btn ghost small img-svg-toggle" title="an SVG: show it as a picture or as code" onClick={() => setFileView(path, drawnFiles.value.has(path) ? "code" : "picture")}>
            {drawnFiles.value.has(path) ? "‹/› code" : "▣ picture"}
          </button>
        ) : null,
      render: (path) => <ImageDiff file={path} />,
    },
  ],
  slots: {
    "thread.area": (p) => <ImageArea {...p} />,
    "thread.areaHint": () => <span class="hint">a thread on an area of an image: the frame marks it · new areas are drawn on the Changes page</span>,
    "timeline.thumb": (p) => (
      <span class="img-step-thumb">
        <RegionThumb {...p} />
      </span>
    ),
    peek(p, placed) {
      if (!isPixelImage(p.path)) return null;
      const frames = placed.flatMap((x) => {
        const t = threads.value.find((y) => y.id === x.threadId);
        return t?.region ? [{ id: t.id, region: t.region, tone: "thread" as const }] : [];
      });
      return (
        <div class="img-anno">
          <ImagePane sha={p.sha} path={p.path} label={p.label} frames={frames} />
        </div>
      );
    },
    "files.tag": (fd) => (fd.hunks.length === 0 && isPixelImage(fd.name) ? "image" : null),
  },
  bindings: [...zoom("compare"), ...zoom("thread")],
  cancel: () => void (imagePending.value = null),
} satisfies WebModule;
