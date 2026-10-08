import type { FileDiffMetadata } from "@pierre/diffs";
import { computed } from "@preact/signals";
import type { VNode } from "preact";
import { regionText } from "../src/core/media.ts";
import type { ComparePlacement, Region, ThreadDetail, TimelineStepDto } from "../src/core/types.ts";
import type { FileView, Peek } from "./compare.ts";
import type { Binding } from "./keys.ts";
import { WEB_MODULES } from "./modules.gen.ts";
import { status } from "./state.ts";

/** A file the Changes page draws instead of showing its lines. */
export interface FileViewer {
  kind: string;
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
}

/** Places in the core's views a module draws into; each has a core fallback. */
export interface Slots {
  /** A thread on an area of a file, on the thread's page in place of its code. */
  "thread.area": (p: { d: ThreadDetail; from: TimelineStepDto; to: TimelineStepDto }) => VNode;
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
  /** Drops what it began on the Changes page and has not sent yet: Esc and another range drop it as they drop a comment on lines. */
  cancel?(): void;
}

/** The web parts of the modules on in the review's repository; every one built until the review says. */
export const webModules = computed(() => {
  const on = status.value?.ui?.modules;
  return on ? WEB_MODULES.filter((m) => on.includes(m.id)) : WEB_MODULES;
});

const viewers = () => webModules.value.flatMap((m) => m.viewers ?? []);

export function viewerFor(fd: FileDiffMetadata, placed: readonly ComparePlacement[] | undefined, view: FileView | undefined): FileViewer | null {
  return viewers().find((v) => v.wants(fd, placed, view)) ?? null;
}

export const viewerByKind = (kind: string): FileViewer | null => viewers().find((v) => v.kind === kind) ?? null;
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

export function StepThumb(p: { sha: string; path: string; region: Region }) {
  const own = slot("timeline.thumb");
  return own ? own(p) : <span class="step-where">area {p.region.w}×{p.region.h}</span>;
}

export const peekView = (p: Peek, placed: readonly { threadId: number }[]): VNode | null => first("peek", p, placed);

export const fileTag = (fd: FileDiffMetadata): string | null => first("files.tag", fd);
