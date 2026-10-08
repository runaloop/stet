import type { FileDiffMetadata } from "@pierre/diffs";
import { computed, effect } from "@preact/signals";
import type { VNode } from "preact";
import { areaText, regionText } from "../src/core/media.ts";
import type { ComparePlacement, Region, ThreadDetail, TimelineStepDto } from "../src/core/types.ts";
import type { OrderPreset } from "../src/ui/order.ts";
import type { FileView, Peek } from "./compare.ts";
import type { RenderedProps } from "./components/MarkdownView.tsx";
import type { Binding } from "./keys.ts";
import { markdownViewer } from "./markdown.tsx";
import { WEB_MODULES } from "./modules.gen.ts";
import { modulePresets, status } from "./state.ts";

/** A kind of file the Changes page draws instead of showing its lines: the core's Markdown, or a module's. */
export interface FileViewer {
  kind: string;
  /** The files of its kind, whether it draws them now or they show as code. */
  match(path: string): boolean;
  /** Classes of the box it is drawn in, besides the core's `anno`. */
  cssClass: string;
  wants(fd: FileDiffMetadata, placed: readonly ComparePlacement[] | undefined, view: FileView | undefined): boolean;
  /** Always drawn, never lines: jumps to it land on the whole file. */
  picture?(path: string): boolean;
  /** Drawn or shown as code at the reader's choice: a jump to its lines shows the code first. */
  switchable?(path: string): boolean;
  /** A control on the file's header, e.g. the switch between the drawing and the code. */
  header?(path: string): VNode | null;
  render(path: string): VNode;
  /** For text it renders, as Markdown: how that is drawn wherever the file's lines are shown. */
  text?: RenderedText;
}

/**
 * Text drawn rendered, in blocks, on the Changes page, in a thread's code and in the guide. The cursor steps through the
 * blocks, a jump to lines lands on the block that holds them, and the lines opened around the changes show in the
 * rendered text and in the code alike.
 */
export interface RenderedText {
  /** How such a file shows until the reader switches it. */
  view(): FileView;
  draw(p: RenderedProps): VNode;
  /** The switch between the rendered text and the code. */
  toggle(p: { rendered: boolean; onClick: () => void }): VNode;
}

/** Places in the core's views a module draws into; each has a core fallback. */
export interface Slots {
  /** A thread on an area of a file, on the thread's page in place of its code. */
  "thread.area": (p: { d: ThreadDetail; from: TimelineStepDto; to: TimelineStepDto }) => VNode;
  /** The hint over a thread on an area, where a thread on lines has the keys of its code. */
  "thread.areaHint": () => VNode;
  /** A step of the timeline of a thread on an area. */
  "timeline.thumb": (p: { sha: string; path: string; region: Region }) => VNode;
  /** The peek panel on a file the module draws; null leaves it to the core. */
  peek: (p: Peek, placed: readonly { threadId: number }[]) => VNode | null;
  /** A word after a file's change in the Files panel. */
  "files.tag": (fd: FileDiffMetadata) => string | null;
}

/** A module's web part, listed in web/modules.gen.ts. Its CSS comes last in the bundle: its rules carry its own prefix. */
export interface WebModule {
  id: string;
  viewers?: FileViewer[];
  slots?: Partial<Slots>;
  bindings?: Binding[];
  /** The order presets of its core part, for the page to sort files by them as the CLI and the terminal do. */
  orderPresets?: readonly OrderPreset[];
  /** Drops what it began on the Changes page and has not sent yet: Esc and another range drop it as they drop a comment on lines. */
  cancel?(): void;
}

let lastOn = WEB_MODULES;

/**
 * The web parts of the modules on in the review's repository; every one built until the review says. It stays the same
 * list while the same modules are on: the diff's files and items, which ask it, are not made again on every status.
 */
export const webModules = computed(() => {
  const on = status.value?.ui?.modules;
  const now = on ? WEB_MODULES.filter((m) => on.includes(m.id)) : WEB_MODULES;
  if (now.length !== lastOn.length || now.some((m, i) => m !== lastOn[i])) lastOn = now;
  return lastOn;
});

effect(() => {
  modulePresets.value = webModules.value.flatMap((m) => m.orderPresets ?? []);
});

/** The viewers of the core's kinds of file, in every build: they come before the modules'. */
const CORE_VIEWERS: readonly FileViewer[] = [markdownViewer];

const viewers = () => [...CORE_VIEWERS, ...webModules.value.flatMap((m) => m.viewers ?? [])];

export function viewerFor(fd: FileDiffMetadata, placed: readonly ComparePlacement[] | undefined, view: FileView | undefined): FileViewer | null {
  return viewers().find((v) => v.wants(fd, placed, view)) ?? null;
}

export const viewerByKind = (kind: string): FileViewer | null => viewers().find((v) => v.kind === kind) ?? null;

/** The viewer of the kind of `path` when it renders the file's text, whether the file is drawn now or not. */
export function textViewer(path: string): (FileViewer & { text: RenderedText }) | null {
  const v = viewers().find((x) => x.match(path));
  return v && renders(v) ? v : null;
}

const renders = (v: FileViewer): v is FileViewer & { text: RenderedText } => v.text !== undefined;

export const isPicture = (path: string): boolean => viewers().some((v) => v.picture?.(path));
export const isSwitchable = (path: string): boolean => viewers().some((v) => v.switchable?.(path));

export function headerControl(path: string): VNode | null {
  for (const v of viewers()) {
    const control = v.header?.(path);
    if (control) return control;
  }
  return null;
}

export function cancelModules(): void {
  for (const m of WEB_MODULES) m.cancel?.();
}

/** The key bindings of the enabled modules, after the core's. */
export const moduleBindings = (): Binding[] => webModules.value.flatMap((m) => m.bindings ?? []);

const slot = <K extends keyof Slots>(name: K): Slots[K] | undefined => webModules.value.find((m) => m.slots?.[name])?.slots?.[name];

/** The first answer of the enabled modules' `name` slots that is not null. */
function first<K extends "peek" | "files.tag">(name: K, ...args: Parameters<Slots[K]>): ReturnType<Slots[K]> | null {
  for (const m of webModules.value) {
    const v = (m.slots?.[name] as ((...a: Parameters<Slots[K]>) => ReturnType<Slots[K]>) | undefined)?.(...args);
    if (v) return v;
  }
  return null;
}

export function ThreadArea(p: { d: ThreadDetail; from: TimelineStepDto; to: TimelineStepDto }) {
  const own = slot("thread.area");
  if (own) return own(p);
  const r = p.d.thread.region;
  return <div class="note">a thread on an area of {p.d.thread.path}{r ? `: ${regionText(r)}` : ""} · no pictures here: the images module is off or not in this build</div>;
}

export function AreaHint() {
  const own = slot("thread.areaHint");
  return own ? own() : null;
}

export function StepThumb(p: { sha: string; path: string; region: Region }) {
  const own = slot("timeline.thumb");
  return own ? own(p) : <span class="step-where">{areaText(p.region)}</span>;
}

export const peekView = (p: Peek, placed: readonly { threadId: number }[]): VNode | null => first("peek", p, placed);

export const fileTag = (fd: FileDiffMetadata): string | null => first("files.tag", fd);
