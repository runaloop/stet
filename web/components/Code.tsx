import {
  File as PierreFile,
  FileDiff,
  VirtualizedFile,
  VirtualizedFileDiff,
  Virtualizer,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type LineAnnotation,
  type SelectedLineRange,
  type SelectionSide,
} from "@pierre/diffs";
import { DEFAULT_THEMES } from "@pierre/diffs";
import { getOrCreateWorkerPoolSingleton, type WorkerPoolManager } from "@pierre/diffs/worker";
import type { ComponentChild } from "preact";
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { MARK_CSS, paintMarks, type LineMark } from "../lib/marks.ts";

export interface SourceFile {
  name: string;
  contents: string;
}

let pool: WorkerPoolManager | null | undefined;

export function workerPool(): WorkerPoolManager | undefined {
  if (pool === undefined) {
    const off = typeof Worker === "undefined" || (globalThis as { __STET_NO_WORKERS?: boolean }).__STET_NO_WORKERS === true;
    pool = off
      ? null
      : getOrCreateWorkerPoolSingleton({
          poolOptions: {
            workerFactory: () => new Worker("/diffs-worker.js", { type: "module" }),
            poolSize: Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)),
          },
          highlighterOptions: { theme: DEFAULT_THEMES, lineDiffType: "word" },
        });
  }
  return pool ?? undefined;
}

export function mount(child: ComponentChild, className: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  render(child, el);
  return el;
}

function useOwnVirtualizer(enabled: boolean, scroller: { current: HTMLElement | null }, content: { current: HTMLElement | null }): Virtualizer | null {
  const [v] = useState(() => (enabled ? new Virtualizer({ overscrollSize: 600 }) : null));
  useEffect(() => {
    if (!v || !scroller.current) return;
    v.setup(scroller.current, content.current ?? undefined);
    return () => v.cleanUp();
  }, [v]);
  return v;
}

function focusLine(
  inst: { getLinePosition?: (line: number, side?: SelectionSide) => { top: number } | undefined },
  virtualizer: Virtualizer | null,
  scroller: HTMLElement | null,
  line: number,
  side?: SelectionSide,
): void {
  requestAnimationFrame(() => {
    if (virtualizer && inst.getLinePosition) {
      const pos = inst.getLinePosition(line, side);
      if (pos) virtualizer.scrollTo({ top: Math.max(0, pos.top - (scroller?.clientHeight ?? 400) / 3) });
      return;
    }
    scroller?.querySelector(".anno-focus")?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  });
}

export interface DiffViewProps<M> {
  oldFile?: SourceFile | null;
  newFile?: SourceFile | null;
  fileDiff?: FileDiffMetadata;
  annotations?: DiffLineAnnotation<M>[];
  renderAnnotation?: (a: DiffLineAnnotation<M>) => ComponentChild;
  marks?: LineMark[];
  selected?: SelectedLineRange | null;
  onSelect?: (r: SelectedLineRange | null) => void;
  diffStyle: "split" | "unified";
  wrap?: boolean;
  expandUnchanged?: boolean;
  focus?: { line: number; side: SelectionSide };
  scroll?: boolean;
}

export function DiffView<M>(props: DiffViewProps<M>) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<FileDiff<M> | null>(null);
  const painted = useRef<HTMLElement | null>(null);
  const focused = useRef<{ key: string; inst: unknown }>({ key: "", inst: null });
  const latest = useRef(props);
  latest.current = props;
  const selectable = !!props.onSelect;
  const virtualizer = useOwnVirtualizer(!!props.scroll, scroller, host);

  useEffect(() => {
    const options = {
      diffStyle: props.diffStyle,
      overflow: props.wrap ? ("wrap" as const) : ("scroll" as const),
      themeType: "system" as const,
      lineDiffType: "word" as const,
      hunkSeparators: "line-info" as const,
      expandUnchanged: props.expandUnchanged ?? false,
      enableLineSelection: selectable,
      enableGutterUtility: selectable,
      onGutterUtilityClick: (r: SelectedLineRange) => latest.current.onSelect?.(r),
      unsafeCSS: MARK_CSS,
      onPostRender: (node: HTMLElement, _inst: unknown, phase: string) => {
        if (phase === "unmount") return;
        painted.current = node;
        paintMarks(node, latest.current.marks ?? []);
      },
      onLineSelectionEnd: (r: SelectedLineRange | null) => latest.current.onSelect?.(r),
      renderAnnotation: (a: DiffLineAnnotation<M>) => {
        const child = latest.current.renderAnnotation?.(a);
        return child === undefined || child === null ? undefined : mount(child, "anno");
      },
    };
    const fd = virtualizer
      ? new VirtualizedFileDiff<M>(options, virtualizer, undefined, workerPool())
      : new FileDiff<M>(options, workerPool());
    inst.current = fd;
    return () => {
      fd.cleanUp();
      inst.current = null;
      if (host.current) host.current.innerHTML = "";
    };
  }, [props.diffStyle, props.wrap, props.expandUnchanged, selectable, virtualizer]);

  useEffect(() => {
    const fd = inst.current;
    if (!fd || !host.current) return;
    const input = props.fileDiff
      ? { fileDiff: props.fileDiff }
      : props.oldFile && props.newFile
        ? { oldFile: props.oldFile, newFile: props.newFile }
        : props.newFile
          ? { oldFile: null, newFile: props.newFile }
          : props.oldFile
            ? { oldFile: props.oldFile, newFile: null }
            : null;
    if (!input) return;
    fd.render({ ...input, containerWrapper: host.current, lineAnnotations: props.annotations ?? [], forceRender: true });
    fd.setSelectedLines(props.selected ?? null);
    const key = props.focus ? `${props.focus.line}:${props.focus.side}` : "";
    if (props.focus && (focused.current.key !== key || focused.current.inst !== fd)) {
      focused.current = { key, inst: fd };
      focusLine(fd as never, virtualizer, scroller.current ?? host.current, props.focus.line, props.focus.side);
    }
  }, [inst.current, props.fileDiff, props.oldFile, props.newFile, props.annotations, props.selected, props.diffStyle, props.wrap, props.expandUnchanged, selectable, virtualizer]);

  useEffect(() => {
    if (painted.current) paintMarks(painted.current, props.marks ?? []);
  }, [props.marks]);

  return props.scroll ? (
    <div class="code-host" ref={scroller}>
      <div ref={host} />
    </div>
  ) : (
    <div ref={host} />
  );
}

export interface FileViewProps<M> {
  file: SourceFile;
  annotations?: LineAnnotation<M>[];
  renderAnnotation?: (a: LineAnnotation<M>) => ComponentChild;
  marks?: LineMark[];
  selected?: { start: number; end: number } | null;
  onSelect?: (r: SelectedLineRange | null) => void;
  wrap?: boolean;
  focus?: { line: number };
}

export function FileView<M>(props: FileViewProps<M>) {
  const scroller = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const inst = useRef<PierreFile<M> | null>(null);
  const painted = useRef<HTMLElement | null>(null);
  const focused = useRef<{ key: string; inst: unknown }>({ key: "", inst: null });
  const latest = useRef(props);
  latest.current = props;
  const selectable = !!props.onSelect;
  const virtualizer = useOwnVirtualizer(true, scroller, host);

  useEffect(() => {
    const options = {
      overflow: props.wrap ? ("wrap" as const) : ("scroll" as const),
      themeType: "system" as const,
      enableLineSelection: selectable,
      enableGutterUtility: selectable,
      onGutterUtilityClick: (r: SelectedLineRange) => latest.current.onSelect?.(r),
      unsafeCSS: MARK_CSS,
      onPostRender: (node: HTMLElement, _inst: unknown, phase: string) => {
        if (phase === "unmount") return;
        painted.current = node;
        paintMarks(node, latest.current.marks ?? []);
      },
      onLineSelectionEnd: (r: SelectedLineRange | null) => latest.current.onSelect?.(r),
      renderAnnotation: (a: LineAnnotation<M>) => {
        const child = latest.current.renderAnnotation?.(a);
        return child === undefined || child === null ? undefined : mount(child, "anno");
      },
    };
    const f = virtualizer
      ? new VirtualizedFile<M>(options, virtualizer, undefined, workerPool())
      : new PierreFile<M>(options, workerPool());
    inst.current = f;
    return () => {
      f.cleanUp();
      inst.current = null;
      if (host.current) host.current.innerHTML = "";
    };
  }, [props.wrap, selectable, virtualizer]);

  useEffect(() => {
    const f = inst.current;
    if (!f || !host.current) return;
    f.render({ file: props.file, containerWrapper: host.current, lineAnnotations: props.annotations ?? [], forceRender: true });
    f.setSelectedLines(props.selected ? { start: props.selected.start, end: props.selected.end } : null);
    const key = props.focus ? `${props.file.name}:${props.focus.line}` : "";
    if (props.focus && (focused.current.key !== key || focused.current.inst !== f)) {
      focused.current = { key, inst: f };
      focusLine(f as never, virtualizer, scroller.current, props.focus.line);
    }
  }, [inst.current, props.file, props.annotations, props.selected, props.wrap, props.focus?.line]);

  useEffect(() => {
    if (painted.current) paintMarks(painted.current, props.marks ?? []);
  }, [props.marks]);

  return (
    <div class="code-host" ref={scroller}>
      <div ref={host} />
    </div>
  );
}
