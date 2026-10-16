import { writeFileSync } from "node:fs";
import { createCliRenderer, type CliRenderer, type KeyEvent, type MouseEvent } from "@opentui/core";
import { clientApi, type Api } from "../client/api.ts";
import { subscribe, type Live, type Subscription } from "../client/live.ts";
import { connect } from "../client/server.ts";
import type { Ctx } from "../core/context.ts";
import type { CommentDto, ThreadDetail } from "../core/types.ts";
import { stepFile, stepThread, stepUnread } from "../ui/nav.ts";
import { hydratePartialDiff, parsePatchFiles } from "@pierre/diffs";
import { launchCommand } from "../core/actions.ts";
import { foldedFiles, viewedCount, type FileRow } from "../ui/compare.ts";
import { NOTHING, withSpan } from "../ui/reveal.ts";
import { defaultCompare, shiftRef, tipRef } from "../ui/state.ts";
import { onlyVersion, withEnd } from "../ui/versions.ts";
import { barSpans, isCollapsed, presetsOf, rangeTitle, refsOf, searchChanges, syncChanges, viewedChange, viewedIdx, wholeBranch } from "./changes.ts";
import { codeEnds, codeViews, fetchWide, scopesOf, threadCode, wideKey } from "./code.ts";
import { DiffView } from "./diff/view.ts";
import { FILE, GAP, GROUP } from "./diff/model.ts";
import { flushTrace, trace, tracing } from "./trace.ts";
import { Highlighter } from "./diff/highlight.ts";
import { browserTarget } from "./browser.ts";
import { linksOf, messageCode, messageRefs, statesOf, type MessageCode, type RefLink } from "./filerefs.ts";
import { fileIndex, linesText, type FileRef } from "../ui/filerefs.ts";
import { ComposerView } from "./composer.ts";
import { editLine, KeyReader } from "./keys/input.ts";
import { KeyMatcher, rowFor, runRow, type Actions } from "../ui/keys/match.ts";
import { tokens } from "../ui/keys/names.ts";
import { COUNT_SCOPES, KEYS, type KeyRow, type Scope } from "../ui/keys/table.ts";
import { menuEntries, OFF, rowOf, SCOPE, tuiReader } from "./keys/menu.ts";
import { KeyTester, type Tried } from "./keys/tester.ts";
import { terminalOf, type Terminal } from "../ui/keys/terminal.ts";
import { ordered, threadGroups } from "./model.ts";
import { columnOf, helpFor, initialView, render, scopeOf, type Branch, type Writing } from "./render.ts";
import { pickerRows, type VersionItem } from "./views/picker.ts";
import { hitAt, hitsOf, type Hit } from "./grid.ts";
import { fileOf, type Side } from "./views/list.ts";
import { Screen } from "./screen.ts";
import { plural, rangeText } from "./text.ts";
import { Texts, textsPath } from "./texts.ts";
import type { Toast } from "./views/bars.ts";

const TOAST_MS = 4000;
const READ_AFTER_MS = 800;
const RELOAD_MS = 150;
const PREVIEW_MS = 60;
const JJ_MS = 300;
const CACHE = 24;
const LANDED_MS = 1500;
const WHEEL_ROWS = 3;

/** A file the frame count is written to after every frame, for the idle check of the tests. */
const FRAMES = process.env.STET_TUI_FRAMES;

const textKey = (w: Writing) =>
  w.kind === "reply" ? `reply:${w.thread}` : w.kind === "edit" ? `edit:${w.comment}` : w.kind === "thread" ? `new:${w.at}:${w.path}:${w.side}:${w.start}-${w.end}` : "summary";

export class App {
  readonly v = initialView();
  private api: Api | null = null;
  private sub: Subscription | null = null;
  /** Threads fetched lately, so moving back and forth in the list shows them at once. */
  private readonly cache = new Map<number, ThreadDetail>();
  /** The thread whose new messages are latched in `v.fresh`. */
  private freshFor: number | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private choiceDone: ((value: string | null) => void) | null = null;
  private lastJ = 0;
  private hits: Hit[] = [];
  private landedTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly keys = new KeyReader();
  private readonly actions = this.registry();
  private readonly conditions = { drafts: () => this.v.data.drafts.length > 0 };
  private readonly reader = tuiReader(new Set(Object.keys(this.actions)));
  private readonly matcher = new KeyMatcher(() => KEYS, this.reader, (row) => this.runRow(row));
  private tester: KeyTester | null = null;
  readonly screen: Screen;
  private readonly composer: ComposerView;
  private readonly texts: Texts;
  private readonly hl = new Highlighter();
  private ended = false;
  private keyAt = 0;
  private keyName: string | null = null;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly ctx: Ctx,
    private readonly review: number,
    private readonly finish: (result: { code: number } | { error: unknown }) => void,
  ) {
    this.texts = new Texts(textsPath(ctx.repo.commonDir, review));
    this.v.summary = this.texts.get("summary");
    this.v.hl.tokens = this.hl;
    this.v.hl.want = (w) => this.hl.want(w);
    this.hl.onColours = (fd, side, start, n) => {
      let seen = false;
      for (const d of this.diffs()) seen = d.invalidate(fd, side, start, n) || seen;
      if (seen) this.redraw();
    };
    this.screen = new Screen(renderer, (w, h) => {
      try {
        this.v.now = Date.now();
        const f = render(this.v, w, h);
        if (this.composer.place(f.box)) this.later(0, () => this.redraw());
        if (FRAMES) writeFileSync(FRAMES, String(this.screen.frames));
        this.hits = hitsOf(f.rows);
        return f.rows;
      } catch (e) {
        this.end({ error: e });
        return [];
      }
    });
    renderer.root.add(this.screen);
    this.composer = new ComposerView(renderer);
    renderer.keyInput.on("keypress", (k: KeyEvent) => {
      try {
        this.key(k);
      } catch (e) {
        this.end({ error: e });
      }
    });
    renderer.on("resize", () => this.redraw());
    if (tracing) {
      // from the bytes of a key to the frame that answers it, for the performance checks
      process.stdin.prependListener("data", () => (this.keyAt = performance.now()));
      renderer.on("frame", () => {
        if (this.keyName === null) return;
        trace({ ev: "key", key: this.keyName, ms: performance.now() - this.keyAt });
        this.keyName = null;
      });
    }
    this.screen.onMouseDown = (e: MouseEvent) => this.guarded(() => this.click(e));
    this.screen.onMouseScroll = (e: MouseEvent) => this.guarded(() => this.wheel(e));
  }

  private guarded(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.end({ error: e });
    }
  }

  async start(): Promise<void> {
    this.v.connecting = "connecting to the server…";
    this.redraw();
    await this.connect();
  }

  end(result: { code: number } | { error: unknown }): void {
    if (this.ended) return;
    this.ended = true;
    this.finish(result);
  }

  async close(): Promise<void> {
    this.hl.close();
    flushTrace();
    for (const t of [...this.timers, this.toastTimer, this.readTimer, this.reloadTimer, this.previewTimer, this.landedTimer, this.searchTimer]) clearTimeout(t);
    this.matcher.reset();
    this.texts.flush();
    await this.sub?.close();
    this.sub = null;
  }

  /** The diffs on screen, whose rows are painted again as their colours come. */
  private diffs() {
    return [this.v.code.diff, this.v.draftCode.diff, this.v.changes.diff];
  }

  private redraw(): void {
    if (!this.ended) this.screen.requestRender();
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private say(text: string, tone: Toast["tone"] = "info"): void {
    this.v.toast = { text, tone };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.v.toast = null;
      this.redraw();
    }, TOAST_MS);
    this.redraw();
  }

  /** Runs a call to the server; a refusal or a lost server shows as a toast, and the result is null. */
  private async guard<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      this.say((e as Error).message, "error");
      return null;
    }
  }

  // --- data

  private async connect(): Promise<void> {
    await this.sub?.close();
    this.sub = null;
    let server;
    try {
      server = await connect(this.ctx);
    } catch (e) {
      this.v.connecting = "no server";
      this.say((e as Error).message, "error");
      return;
    }
    if (this.ended) return;
    this.api = clientApi(server);
    this.v.connecting = null;
    await this.reload();
    if (this.ended) return;
    const live: Live = {
      otherBuild: () => {
        this.say("the server was replaced by another build: reconnecting");
        void this.connect();
      },
      change: (_seq, events) => {
        if (events.some((e) => e.type === "version.created" && e.role === "agent")) this.v.banner = (this.v.data.status?.versions ?? 0) + 1;
        this.reloadSoon();
      },
      store: () => this.reloadSoon(),
      now: (n) => {
        this.v.data = { ...this.v.data, now: n };
        this.redraw();
      },
      git: (g) => {
        this.v.git = g;
        this.redraw();
      },
      connection: (up) => {
        this.v.data = { ...this.v.data, online: up };
        if (up) this.reloadSoon();
        else this.redraw();
      },
    };
    this.sub = subscribe(server, this.review, this.v.data.status?.lastSeq ?? 0, live);
  }

  private reloadSoon(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_MS);
  }

  private async reload(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const r = this.review;
    const first = !this.v.data.status;
    this.cache.clear();
    const [status, threads, drafts, git, cursors] = await Promise.all([
      this.guard(api.review(r)),
      this.guard(api.threads(r)),
      this.guard(api.drafts(r)),
      api.git(r).catch(() => null),
      api.cursors(r).catch(() => null),
    ]);
    if (this.ended) return;
    const v = this.v;
    v.data = { ...v.data, status: status ?? v.data.status, threads: threads ?? v.data.threads, drafts: drafts ?? v.data.drafts };
    if (git) v.git = git;
    if (cursors) {
      v.changes.viewed = new Set(cursors.viewed);
      v.changes.reviewed = cursors.reviewed;
    }
    if (v.changes.from !== null) {
      if (v.tab === "changes") void this.loadChanges();
      else {
        v.changes.stale = true;
        if (v.changes.data) syncChanges(v.data, v.changes, v.filter.status === "all");
      }
    }
    const latest = status?.versionsList?.[status.versionsList.length - 1];
    if (first && latest && latest.role === "agent" && latest.number > 1 && (cursors?.reviewed?.version ?? 0) < latest.number) v.banner = latest.number;
    if (v.selected === null || !v.data.threads.some((t) => t.id === v.selected)) v.selected = ordered(v.data, v.filter, null)[0]?.id ?? null;
    if (v.draftSel === null || !v.data.drafts.some((c) => c.id === v.draftSel)) v.draftSel = v.data.drafts[0]?.id ?? null;
    await Promise.all([this.fetchThread(v.selected), v.tab === "drafts" ? this.fetchThread(this.selectedDraft()?.threadId ?? null) : null, v.files ? this.loadFiles() : null]);
    this.redraw();
  }

  /** The review's changed files for the Files tab: from the base to the latest version, or to "now" before one. */
  private async loadFiles(): Promise<void> {
    if (!this.api) return;
    const n = this.v.data.status?.versions ?? 0;
    const files = await this.guard(this.api.compare(this.review, "base", n ? String(n) : "now"));
    if (!files || this.ended) return;
    this.v.files = files;
    if (!this.v.fileSel || !files.files.some((f) => f.path === this.v.fileSel)) this.v.fileSel = files.files[0]?.path ?? null;
    this.redraw();
  }

  /** Fetches a thread into the cache and shows it when it is still the one selected (or the selected draft's). */
  private async fetchThread(id: number | null): Promise<void> {
    if (id === null || !this.api) return;
    const d = await this.guard(this.api.thread(this.review, id));
    if (!d || this.ended) return;
    this.cache.delete(id);
    this.cache.set(id, d);
    while (this.cache.size > CACHE) this.cache.delete(this.cache.keys().next().value!);
    if (this.v.selected === id) this.show(d);
    if (this.selectedDraft()?.threadId === id) this.v.draftDetail = d;
    this.redraw();
  }

  private show(d: ThreadDetail): void {
    const v = this.v;
    if (this.freshFor !== d.thread.id) {
      this.freshFor = d.thread.id;
      v.fresh = new Set(d.comments.filter((c) => c.unread).map((c) => c.id));
      v.toNews = v.fresh.size > 0;
    }
    v.detail = d;
    if (v.view && !codeViews(d).includes(v.view)) v.view = null;
    this.markReadSoon();
    if (d.comments.some((c) => messageRefs(c.body).length)) void this.loadRefs();
  }

  // --- files named in messages

  /** What a message's file names resolve against: the branch's files, then the tip's tree. */
  private async loadRefs(): Promise<void> {
    const b = await this.loadBranch();
    if (!b || !this.api || this.v.trees.has(b.sha)) return this.redraw();
    const r = await this.api.files(b.sha).catch(() => null);
    if (this.ended) return;
    this.v.trees = new Map(this.v.trees).set(b.sha, fileIndex(r?.paths ?? []));
    this.redraw();
  }

  /** The references of the thread's messages that name files of the review, newest message first. */
  private threadLinks(): { c: CommentDto; link: RefLink }[] {
    const v = this.v;
    const d = v.detail;
    if (!d) return [];
    const tree = v.branch ? (v.trees.get(v.branch.sha) ?? null) : null;
    return [...d.comments].reverse().flatMap((c) => linksOf(c, v.branch?.index ?? null, tree).map((link) => ({ c, link })));
  }

  /** g f: the file a message names; several references are a choice, newest message first. */
  private async filesOfMessages(): Promise<void> {
    const v = this.v;
    const d = v.detail;
    if (!d || v.selected !== d.thread.id) return;
    await this.loadRefs();
    const all = this.threadLinks();
    if (!all.length) return this.say(v.branch ? "no message here names a file of the review" : "the review's files did not come: try again");
    if (all.length === 1) return this.followRef(all[0]!.c, all[0]!.link);
    const who = (c: CommentDto) => (c.role === "reviewer" ? "you" : c.author);
    const at = await this.ask(
      "Files the messages name",
      "Newest message first. A name several files have opens the file finder.",
      all.map((x, i) => ({ value: String(i), label: `${x.link.ref.text} · ${who(x.c)}${x.link.paths.length > 1 ? ` · ${x.link.paths.length} files have this name` : ""}` })),
    );
    if (at !== null) this.followRef(all[Number(at)]!.c, all[Number(at)]!.link);
  }

  /** A reference followed: one file opens over the thread's code; several, the file finder with the name typed in. */
  private followRef(c: CommentDto, link: RefLink): void {
    const v = this.v;
    const from = messageCode(v.detail!.thread.id, c);
    if (link.paths.length === 1) return void this.openFileRef(link.paths[0]!, link.ref, from);
    const range = { from: v.changes.from ?? "base", to: v.changes.to ?? "now" };
    v.picker = { kind: "files", query: link.ref.path, at: 0, paths: link.paths, name: { lines: linesText(link.ref) }, verb: "open it", range };
    this.choosing = (path) => void this.openFileRef(path, link.ref, from);
    this.redraw();
  }

  /** The file over the thread's code as the message's code had it, its lines marked in the middle, as the web's peek. */
  private async openFileRef(path: string, ref: FileRef, from: MessageCode): Promise<void> {
    const v = this.v;
    const api = this.api;
    if (!api) return;
    const b = await this.loadBranch();
    const states = statesOf(from, v.data.status?.versionsList ?? [], b ? { sha: b.sha, label: b.label } : null);
    let at = states[0];
    let text: string | null = null;
    for (const st of states) {
      const blob = await api.blob(st.sha, path).catch(() => null);
      if (blob?.exists) {
        at = st;
        text = blob.contents;
        break;
      }
    }
    if (!at || this.ended) return this.say(`${path} is not in the review's code`, "error");
    this.leaveCode();
    v.peek = {
      path,
      sha: at.sha,
      label: at.label,
      line: ref.start ?? 1,
      ...(ref.start !== null ? { end: ref.end ?? ref.start } : {}),
      ...(at.note ? { note: at.note } : {}),
      ...(b && b.sha !== at.sha ? { latest: { sha: b.sha, label: b.label } } : {}),
      text,
    };
    v.toPeek = true;
    if (v.focus === "list") v.focus = "code";
    this.redraw();
  }

  private closePeek(): boolean {
    if (!this.v.peek) return false;
    this.v.peek = null;
    this.redraw();
    return true;
  }

  /** A thread you went into is read after a moment, as the web marks it; a preview in the list is not. */
  private markReadSoon(): void {
    clearTimeout(this.readTimer);
    const d = this.v.detail;
    if (!d || !d.thread.unread || !this.inThread()) return;
    const id = d.thread.id;
    this.readTimer = setTimeout(async () => {
      if (this.v.selected !== id || !this.inThread() || !this.api) return;
      if (!(await this.guard(this.api.read(this.review, id)))) return;
      const v = this.v;
      v.data = { ...v.data, threads: v.data.threads.map((t) => (t.id === id ? { ...t, unread: false } : t)) };
      if (v.detail?.thread.id === id) v.detail = { ...v.detail, thread: { ...v.detail.thread, unread: false } };
      this.reloadSoon();
    }, READ_AFTER_MS);
  }

  private inThread(): boolean {
    const v = this.v;
    if (v.tab !== "round") return false;
    return v.focus !== "list";
  }

  /** The code of the thread's wider scope: every change of its file, or the whole file. */
  private async loadWide(): Promise<void> {
    const v = this.v;
    const d = v.detail;
    const api = this.api;
    if (!d || !api) return;
    const view = threadCode(d, v.view).view;
    const key = wideKey(d, view, v.scope);
    if (!key || v.wide?.key === key) return;
    const wide = await fetchWide(api, d, view, v.scope, key);
    if (this.ended || v.detail?.thread.id !== d.thread.id) return;
    v.wide = wide;
    this.redraw();
  }

  // --- moving around

  /** Moves the list's cursor; the thread shows at once when fetched lately, else after a short pause. */
  private select(id: number | null): void {
    const v = this.v;
    if (id === null || id === v.selected) return;
    v.selected = id;
    v.followList = true;
    this.leaveCode();
    v.peek = null;
    v.view = null;
    v.scope = "around";
    v.wide = null;
    v.tops.code = v.tops.conv = v.tops.thread = 0;
    const cached = this.cache.get(id);
    if (cached) this.show(cached);
    else clearTimeout(this.readTimer);
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.fetchThread(id), cached ? RELOAD_MS * 4 : PREVIEW_MS);
    this.redraw();
  }

  private focus(f: "list" | "code" | "conv"): void {
    const v = this.v;
    v.focus = f;
    if (f !== "code") this.leaveCode();
    this.markReadSoon();
    this.redraw();
  }

  private setSide(side: Side): void {
    const v = this.v;
    if (v.tab === "changes" && side === "files") {
      v.changes.side = "files";
      v.changes.focus = "list";
      return this.redraw();
    }
    if (v.tab !== "round") v.tab = "round";
    v.side = side;
    v.followList = true;
    v.tops.list = 0;
    if (side === "files") {
      const here = v.data.threads.find((t) => t.id === v.selected);
      if (here) v.fileSel = fileOf(here);
      if (!v.files) void this.loadFiles();
    }
    this.focus("list");
  }

  private filePaths(): string[] {
    return this.v.files?.files.map((f) => f.path) ?? [];
  }

  /** Puts the Files cursor on a file; the right side shows its first thread, or what the file is when it has none. */
  private selectFile(path: string | undefined): void {
    const v = this.v;
    if (!path) return;
    v.fileSel = path;
    v.followList = true;
    const first = ordered(v.data, { status: "all", newOnly: false }, null).find((t) => fileOf(t) === path);
    if (first) this.select(first.id);
    this.redraw();
  }

  private moveFile(by: number | "first" | "last"): void {
    const paths = this.filePaths();
    if (!paths.length) return;
    const at = Math.max(0, paths.indexOf(this.v.fileSel ?? ""));
    this.selectFile(paths[by === "first" ? 0 : by === "last" ? paths.length - 1 : Math.max(0, Math.min(paths.length - 1, at + by))]);
  }

  /** J and K land in another file: its header row is marked for a moment and a toast names it. */
  private land(id: number): void {
    const v = this.v;
    const t = v.data.threads.find((x) => x.id === id);
    if (!t) return;
    const path = fileOf(t);
    const n = ordered(v.data, v.filter, id).filter((x) => fileOf(x) === path).length;
    v.landed = path;
    clearTimeout(this.landedTimer);
    this.landedTimer = setTimeout(() => {
      v.landed = null;
      this.redraw();
    }, LANDED_MS);
    this.say(`${path} · ${plural(n, "thread")}`);
  }

  private listIds(): number[] {
    return ordered(this.v.data, this.v.filter, this.v.selected).map((t) => t.id);
  }

  private moveList(by: number | "first" | "last"): void {
    const ids = this.listIds();
    if (!ids.length) return;
    const at = Math.max(0, ids.indexOf(this.v.selected ?? -1));
    const to = by === "first" ? 0 : by === "last" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, at + by));
    this.select(ids[to]!);
  }

  private selectedDraft(): CommentDto | null {
    return this.v.data.drafts.find((c) => c.id === this.v.draftSel) ?? null;
  }

  private moveDraft(by: number): void {
    const ids = this.v.data.drafts.map((c) => c.id);
    if (!ids.length) return;
    const at = Math.max(0, ids.indexOf(this.v.draftSel ?? -1));
    this.v.draftSel = ids[Math.max(0, Math.min(ids.length - 1, at + by))]!;
    this.showDraft();
  }

  private showDraft(): void {
    const c = this.selectedDraft();
    this.v.tops.draft = 0;
    const cached = c ? this.cache.get(c.threadId) : undefined;
    this.v.draftDetail = cached ?? null;
    if (c && !cached) void this.fetchThread(c.threadId);
    this.redraw();
  }

  private scrollKey(): "code" | "conv" | "thread" {
    const v = this.v;
    return v.geom.columns === 3 ? (v.focus === "conv" ? "conv" : "code") : "thread";
  }

  private scroll(by: number | "top" | "bottom"): void {
    const k = this.scrollKey();
    const tops = this.v.tops;
    tops[k] = by === "top" ? 0 : by === "bottom" ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.min(tops[k], 100_000) + by);
    this.redraw();
  }

  private message(dir: 1 | -1): void {
    const v = this.v;
    const starts = v.geom.starts;
    if (!starts.length) return;
    const k = this.scrollKey();
    const top = v.tops[k];
    const next = dir === 1 ? starts.find((x) => x > top) : [...starts].reverse().find((x) => x < top);
    if (next === undefined) return this.say(dir === 1 ? "the last message" : "the first message");
    v.tops[k] = next;
    this.redraw();
  }

  private setTab(tab: "round" | "changes" | "drafts"): void {
    const v = this.v;
    v.tab = tab;
    clearTimeout(this.readTimer);
    if (tab === "drafts") this.showDraft();
    if (tab === "changes") {
      v.banner = null;
      const c = v.changes;
      if (c.from === null) {
        const r = wholeBranch(v.data);
        c.from = r.from;
        c.to = r.to;
        void this.loadChanges();
      } else if (c.stale) void this.loadChanges();
    }
    this.redraw();
  }

  // --- the Changes tab

  private syncChanges(): void {
    syncChanges(this.v.data, this.v.changes, this.v.filter.status === "all");
    this.redraw();
  }

  /** Shows the range `from..to` on the Changes tab. */
  private openRange(from: string, to: string): void {
    const c = this.v.changes;
    const same = c.from === from && c.to === to && !!c.data;
    c.from = from;
    c.to = to;
    this.setTab("changes");
    if (same) return;
    c.loading = `loading ${rangeTitle(this.v.data, c)}…`;
    void this.loadChanges();
  }

  private loads = 0;

  /** The range's files and threads, and its patch when its two ends changed. */
  private async loadChanges(): Promise<void> {
    const api = this.api;
    const c = this.v.changes;
    if (!api || c.from === null || c.to === null) return;
    const seq = ++this.loads;
    const t0 = performance.now();
    try {
      const data = await api.compare(this.review, c.from, c.to);
      if (seq !== this.loads || this.ended) return;
      const t1 = performance.now();
      const key = `${data.from.sha}-${data.to.sha}`;
      const moved = key !== c.key;
      let t2 = t1;
      if (moved) {
        const text = await api.patch(data.from.sha, data.to.sha);
        if (seq !== this.loads || this.ended) return;
        t2 = performance.now();
        c.base = parsePatchFiles(text, key).flatMap((p) => p.files);
        c.key = key;
        c.whole.clear();
        c.reveals.clear();
        c.open.clear();
      }
      c.data = data;
      c.error = null;
      c.loading = null;
      c.stale = false;
      const t3 = performance.now();
      this.syncChanges();
      if (moved) c.diff.first();
      if (c.goto) {
        const path = c.goto;
        c.goto = null;
        this.jumpToFile(path);
      }
      const t4 = performance.now();
      trace({ ev: "changes", ms: t4 - t0, compare: t1 - t0, patch: t2 - t1, parse: t3 - t2, rows: t4 - t3, files: data.files.length });
    } catch (e) {
      if (seq !== this.loads) return;
      c.error = (e as Error).message;
      c.loading = null;
      this.redraw();
    }
  }

  /** The file the cursor of the diff is in, or the list's. */
  private changesFile(): FileRow | undefined {
    const c = this.v.changes;
    const path = c.focus === "list" ? c.sel : (() => {
      const i = c.diff.info();
      return i?.item.kind === "file" ? i.item.key : null;
    })();
    return c.rows.find((r) => r.fd.name === path);
  }

  /** The list follows the file the diff's cursor is in. */
  private followDiff(): void {
    const c = this.v.changes;
    const i = c.diff.info();
    if (i?.item.kind === "file") c.sel = i.item.key;
    this.redraw();
  }

  private goToFile(path: string, align: "top" | "nearest" = "top"): void {
    const c = this.v.changes;
    const i = c.diff.items.findIndex((x) => x.key === path);
    if (i !== -1) c.diff.goTo(c.diff.itemRow(i), align);
  }

  private fold(open: boolean | "toggle", inList = false): void {
    const c = this.v.changes;
    const info = c.diff.info();
    if (!inList && info?.thread !== null && info?.thread !== undefined) {
      c.diff.toggleCard(info.thread, open === "toggle" ? undefined : open);
      return this.redraw();
    }
    if (!inList && info?.item.kind === "group") return this.toggleGroup(info.item.key === "group:tests" ? "tests" : "generated", open);
    const row = this.changesFile();
    if (!row) return;
    if (row.hidden && row.group) return this.toggleGroup(row.group, true);
    const next = open === "toggle" ? isCollapsed(c, row.fd) : open;
    c.open.set(row.fd.name, next);
    this.syncChanges();
    this.goToFile(row.fd.name, "nearest");
  }

  private foldAll(open: boolean): void {
    const c = this.v.changes;
    for (const r of c.rows) c.open.set(r.fd.name, open);
    this.syncChanges();
  }

  private toggleGroup(g: "tests" | "generated", open: boolean | "toggle" = "toggle"): void {
    const c = this.v.changes;
    c.groups = { ...c.groups, [g]: open === "toggle" ? !c.groups[g] : open };
    this.syncChanges();
    const first = c.rows.find((r) => r.group === g);
    if (first && c.groups[g]) this.goToFile(first.fd.name);
    this.say(c.groups[g] ? `showing ${foldedFiles(g, c.rows.filter((r) => r.group === g).length)}` : "folded again");
  }

  /** `m`: viewed, through the server, so the web and other clients see it at once. */
  private async toggleViewed(): Promise<void> {
    const c = this.v.changes;
    const row = this.changesFile();
    if (!row || !this.api) return;
    const { keys, on } = viewedChange(c, row.fd);
    const next = new Set(c.viewed);
    for (const k of keys) on ? next.add(k) : next.delete(k);
    c.viewed = next;
    c.open.delete(row.fd.name);
    this.syncChanges();
    this.goToFile(row.fd.name, "nearest");
    this.say(on ? `${row.fd.name}: viewed, folded until it changes` : `${row.fd.name}: not viewed`);
    if (keys.length) await this.guard(this.api.setViewed(this.review, keys, on));
    if (on) await this.doneIfAllViewed();
  }

  /** Space r m: you went through the range's "to": "since I last looked" starts there next time. */
  private async markDone(quiet = false): Promise<void> {
    const c = this.v.changes;
    if (this.v.tab !== "changes" || !c.to || !this.api) return this.say("on the Changes tab it marks the version on the right as gone through: Space r v first");
    if (c.to === "base") return this.say("“base” is where the branch starts: nothing to mark done");
    const r = await this.guard(this.api.markReviewed(this.review, c.to));
    if (!r || this.ended) return;
    c.reviewed = r;
    if (!quiet) this.say(`remembered: you went through the code up to ${r.label}. “Since I last looked” starts there next time`);
    this.redraw();
  }

  /** The last file of the range marked viewed: the pass is remembered, as the web does, unless it was already further. */
  private async doneIfAllViewed(): Promise<void> {
    const c = this.v.changes;
    const n = viewedCount(c.rows, viewedIdx(c));
    if (n.shown === 0 || n.seen < n.shown || !c.to) return;
    const rv = c.reviewed;
    if (!rv || c.to === "now" || (/^\d+$/.test(c.to) && (rv.version === null || Number(c.to) > rv.version))) await this.markDone();
  }

  /** Enter on a bar: its unchanged lines, once both texts of the file came. */
  private async openBar(): Promise<void> {
    const c = this.v.changes;
    const info = c.diff.info();
    const api = this.api;
    if (!info || info.item.kind !== "file" || !api || !c.data) return;
    const path = info.item.key;
    const base = c.rows.find((r) => r.fd.name === path)?.fd;
    if (!base) return;
    const start = info.newNo;
    const n = c.diff.rows.n[info.row]!;
    if (!c.whole.has(path)) {
      const oldPath = base.prevName ?? path;
      const [a, b] = await Promise.all([
        base.type === "new" ? null : this.guard(api.blob(c.data.from.sha, oldPath)),
        base.type === "deleted" ? null : this.guard(api.blob(c.data.to.sha, path)),
      ]);
      const oldText = base.type === "new" ? "" : a?.contents;
      const newText = base.type === "deleted" ? "" : b?.contents;
      if (typeof oldText !== "string" || typeof newText !== "string") return this.say("the file's text could not be read", "error");
      try {
        c.whole.set(path, hydratePartialDiff("clone", base, { oldFile: { name: oldPath, contents: oldText }, newFile: { name: path, contents: newText } } as never));
      } catch (e) {
        return this.say((e as Error).message, "error");
      }
    }
    let r = c.reveals.get(path) ?? NOTHING;
    for (const span of barSpans(start, n)) r = withSpan(r, span);
    c.reveals.set(path, r);
    this.syncChanges();
  }

  private stepThread(dir: 1 | -1): void {
    const c = this.v.changes;
    const r = c.diff.nextCard(dir);
    if (r === -1) return this.say("no threads on this diff");
    c.diff.goTo(r, "center");
    c.thread = c.diff.info()?.thread ?? null;
    this.syncMarks();
    this.followDiff();
  }

  /** The thread in focus is marked stronger in the gutter. */
  private syncMarks(): void {
    const c = this.v.changes;
    for (const m of c.diff.marks.values()) for (const x of [...m.old, ...m.new]) x.strong = false;
    for (const it of c.diff.items) {
      if (it.kind !== "file") continue;
      const m = c.diff.marks.get(it.key);
      it.placed?.forEach((p) => {
        if (p.threadId !== c.thread || !m) return;
        for (const x of p.side === "deletions" ? m.old : m.new) if (x.start === p.range.start && x.end === p.range.end) x.strong = true;
      });
    }
    c.diff.invalidate();
  }

  /** A thread from the diff opens on the Round tab; Esc there comes back here. */
  private openThread(id: number): void {
    const v = this.v;
    v.changes.thread = id;
    v.back = "changes";
    if (!ordered(v.data, v.filter, null).some((t) => t.id === id)) v.filter = { status: "all", newOnly: false };
    this.setTab("round");
    this.select(id);
    this.focus("code");
  }

  private enter(): void {
    const c = this.v.changes;
    const info = c.diff.info();
    if (!info) return;
    if (info.kind === FILE) return this.fold("toggle");
    if (info.kind === GROUP) return this.toggleGroup(info.item.key === "group:tests" ? "tests" : "generated");
    if (info.kind === GAP) return void this.openBar();
    const id = c.diff.threadAt();
    if (id !== null) return this.openThread(id);
    this.say("no thread on this line: ] t goes to the next one");
  }

  // --- the finders

  /** The whole branch's files, base to the tip, fetched again once a version or "now" moves the tip. */
  private async loadBranch(): Promise<Branch | null> {
    const v = this.v;
    const api = this.api;
    if (!api || !v.data.status) return v.branch;
    const tip = tipRef(refsOf(v.data));
    const key = `${tip}:${v.data.status.versions}:${v.data.status.pinnedNow ?? ""}`;
    if (v.branch?.key === key) return v.branch;
    const d = await this.guard(api.compare(this.review, "base", tip));
    if (!d || this.ended) return v.branch;
    const paths = d.files.filter((f) => f.status !== "D").map((f) => f.path);
    v.branch = { key, ref: tip, sha: d.to.sha, label: d.to.label, paths, index: fileIndex(paths) };
    return v.branch;
  }

  /** Space f f: the diff's files on the Changes tab; elsewhere the branch's, and the last diff's, opened there. */
  private async findFile(): Promise<void> {
    const v = this.v;
    this.choosing = null;
    const c = v.changes;
    const range = { from: c.from ?? "base", to: c.to ?? "now" };
    if (v.tab === "changes") {
      if (!c.rows.length) return this.say("no files in this diff");
      const threads = new Map<string, number>();
      for (const p of c.data?.placements ?? []) threads.set(p.path, (threads.get(p.path) ?? 0) + 1);
      v.picker = { kind: "files", query: "", at: 0, paths: c.rows.map((r) => r.fd.name), threads, verb: "jump", range };
      return this.redraw();
    }
    const b = await this.loadBranch();
    if (!b) return;
    const seen = new Set(b.paths);
    const paths = [...b.paths, ...(c.data?.files ?? []).map((f) => f.path).filter((p) => !seen.has(p))];
    v.picker = { kind: "files", query: "", at: 0, paths, verb: "open it on the Changes tab", range };
    this.redraw();
  }

  /** Space f v: every version; the ends it marks are the range shown, or the one the Changes tab would open with. */
  private findVersion(): void {
    const v = this.v;
    if (!v.data.status?.versionsList.length) return this.say("no versions yet");
    const c = v.changes;
    const range = c.from !== null && c.to !== null ? { from: c.from, to: c.to } : defaultCompare(refsOf(v.data), c.reviewed);
    v.picker = { kind: "versions", query: "", at: 0, paths: [], verb: "what changed in it", range };
    this.redraw();
  }

  /** A key while a finder is open: its own keys, else text for the query. */
  private pickerKey(k: KeyEvent, token: string): void {
    const p = this.v.picker!;
    const row = rowsIn(KEYS, ["picker"]).find((x) => x.keys === token)?.row;
    if (row) return this.run(row.id);
    const next = editLine(p.query, k, token);
    if (next === null) return;
    p.query = next;
    p.at = 0;
    this.redraw();
  }

  /** The finder's row under its cursor: a file opens, a version becomes the range or one end of it. */
  private pickRow(how: "pick" | "from" | "to"): void {
    const v = this.v;
    const p = v.picker;
    if (!p) return;
    const rows = pickerRows(p, v.data, v.now);
    const hit = rows[p.at];
    v.picker = null;
    this.redraw();
    if (hit === undefined) return;
    if (p.kind === "versions") {
      const n = (hit as VersionItem).v.number;
      const latest = v.data.status?.versions ?? 0;
      const [from, to] = how === "pick" ? onlyVersion(n) : withEnd(how, String(n), p.range.from, p.range.to, latest);
      return this.openRange(from, to);
    }
    if (how !== "pick") return this.say("Shift+Enter and Ctrl+Enter pick the ends of a range in the version finder");
    const path = hit as string;
    if (this.choosing) {
      const open = this.choosing;
      this.choosing = null;
      return open(path);
    }
    if (p.verb === "jump") return this.jumpToFile(path);
    this.openInChanges(path);
  }

  /** What a pick in the file finder does while it lists the files a name in a message may be. */
  private choosing: ((path: string) => void) | null = null;

  /** The diff at a file: its fold group opened when it is folded into one, the cursor on its header. */
  private jumpToFile(path: string): void {
    const c = this.v.changes;
    const row = c.rows.find((r) => r.fd.name === path);
    if (!row) return this.say(`${path} is not in this diff`);
    if (row.hidden && row.group) {
      c.groups = { ...c.groups, [row.group]: true };
      this.syncChanges();
    }
    c.sel = path;
    c.focus = "diff";
    this.goToFile(path);
    this.followDiff();
  }

  /** A file picked on a thread's page: in the last diff when it has the file, else in the whole branch. */
  private openInChanges(path: string): void {
    const v = this.v;
    const c = v.changes;
    const inLast = c.from !== null && c.to !== null && !!c.data?.files.some((f) => f.path === path);
    const range = inLast ? { from: c.from!, to: c.to! } : { from: "base", to: v.branch?.ref ?? tipRef(refsOf(v.data)) };
    const same = c.from === range.from && c.to === range.to && !!c.data && !c.stale;
    c.goto = path;
    this.openRange(range.from, range.to);
    if (same) {
      c.goto = null;
      this.jumpToFile(path);
    }
  }

  // --- the diff's search

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** `/`: the box at the bottom; matches are marked as you type. */
  private openSearch(): void {
    const v = this.v;
    if (v.tab !== "changes") return this.say("the diff's search is on the Changes tab: Space r v, then /");
    v.changes.search.typing = true;
    v.changes.focus = "diff";
    this.redraw();
  }

  private searchNow(): void {
    clearTimeout(this.searchTimer);
    searchChanges(this.v.changes);
    this.redraw();
  }

  /** A key while the box is open: text goes in, Enter goes to the first match after the cursor, Esc drops the search. */
  private searchKey(k: KeyEvent, token: string): void {
    const q = this.v.changes.search;
    k.preventDefault();
    if (token === "<CR>") {
      q.typing = false;
      this.searchNow();
      if (!q.query) return;
      if (q.error) return this.say(q.error, "error");
      if (!q.hits.length) return this.say(`no match for “${q.query}” in this diff`);
      return this.goToHit(this.hitAfterCursor());
    }
    if (token === "<Esc>") {
      q.typing = false;
      return this.clearSearch();
    }
    const next = editLine(q.query, k, token);
    if (next === null) return;
    q.query = next;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.searchNow(), next.length > 2 ? 60 : 150);
    this.redraw();
  }

  private clearSearch(): void {
    const q = this.v.changes.search;
    q.query = "";
    this.searchNow();
  }

  /** The first match at or after the cursor, in reading order; the first one past the end. */
  private hitAfterCursor(): number {
    const c = this.v.changes;
    const q = c.search;
    const info = c.diff.info();
    const order = new Map(c.rows.map((r, i) => [r.fd.name, i]));
    const here = info?.item.kind === "file" ? (order.get(info.item.key) ?? 0) : 0;
    const row = c.diff.cursor;
    const at = q.hits.findIndex((h) => {
      const f = order.get(h.path) ?? 0;
      if (f !== here) return f > here;
      const r = c.diff.lineRow(h.path, h.side === "deletions" ? 0 : 1, h.line);
      return r === -1 || r >= row;
    });
    return at === -1 ? 0 : at;
  }

  /** A match on screen: its file opened (and its fold group) when folded, the cursor on its line and side. */
  private goToHit(i: number): void {
    const c = this.v.changes;
    const q = c.search;
    const h = q.hits[i];
    if (!h) return;
    const row = c.rows.find((r) => r.fd.name === h.path);
    if (row?.hidden && row.group) c.groups = { ...c.groups, [row.group]: true };
    if (row && isCollapsed(c, row.fd)) c.open.set(row.fd.name, true);
    q.at = i;
    this.syncChanges();
    const side = h.side === "deletions" ? 0 : 1;
    const r = c.diff.lineRow(h.path, side, h.line);
    if (r !== -1) {
      c.diff.goTo(r, "center");
      if (c.diff.split) c.diff.setSide(side);
    }
    this.followDiff();
  }

  /** n, N, F3: the next match, round the end; n and N go through unread threads while nothing is searched. */
  private stepHit(dir: 1 | -1, unread: boolean): void {
    const q = this.v.changes.search;
    if (!q.hits.length) {
      if (unread) return this.run(dir === 1 ? "unread.next" : "unread.prev");
      return this.say(q.query ? `no match for “${q.query}”` : "nothing searched: / searches the diff");
    }
    const n = q.hits.length;
    this.goToHit(q.at === -1 ? (dir === 1 ? 0 : n - 1) : (q.at + dir + n) % n);
  }

  /** i, a, c, gc, gcc: a new thread on the selection or the cursor's line, on its side of the range. */
  private commentChanges(): void {
    const c = this.v.changes;
    const sel = c.diff.selection();
    if (!sel || !c.data) return this.say("put the cursor on a line of code: a folded file or a picture has none");
    if (c.diff.anchor < 0) c.diff.startSelection();
    const old = sel.side === 0;
    const end = old ? c.data.from : c.data.to;
    const path = old ? (sel.item.fd.prevName ?? sel.key) : sel.key;
    this.write({ kind: "thread", path, side: old ? "old" : "new", start: sel.start, end: sel.end, at: end.sha, label: end.label, from: "changes" });
  }

  private shiftRange(which: "from" | "to", dir: 1 | -1): void {
    const c = this.v.changes;
    const refs = refsOf(this.v.data);
    const from = which === "from" ? shiftRef(refs, c.from ?? "base", dir) : (c.from ?? "base");
    const to = which === "to" ? shiftRef(refs, c.to ?? "now", dir) : (c.to ?? "now");
    if (from === c.from && to === c.to) return this.say(dir === 1 ? "the latest already" : "the earliest already");
    if (from === to) return this.say("from and to would be the same version");
    this.openRange(from, to);
  }

  private nextPreset(): void {
    const c = this.v.changes;
    const ps = presetsOf(this.v.data, c);
    if (!ps.length) return;
    const at = ps.findIndex((p) => p.from === c.from && p.to === c.to);
    const p = ps[(at + 1) % ps.length]!;
    this.say(p.label);
    this.openRange(p.from, p.to);
  }

  private moveListFile(by: number | "first" | "last"): void {
    const c = this.v.changes;
    const paths = c.rows.map((r) => r.fd.name);
    if (!paths.length) return;
    const at = Math.max(0, paths.indexOf(c.sel ?? ""));
    c.sel = paths[by === "first" ? 0 : by === "last" ? paths.length - 1 : Math.max(0, Math.min(paths.length - 1, at + by))]!;
    this.goToFile(c.sel);
    this.redraw();
  }

  /** Opens a view of the web UI: `target` as `browserTarget` gives it, through the server's browser.open action. */
  private async browser(what: string, target = browserTarget(this.v, this.selectedDraft()?.threadId ?? null)): Promise<void> {
    if (!this.api) return;
    const r = await this.guard(this.api.action(this.review, "browser.open", target));
    if (!r || r.launch.kind !== "url") return;
    const url = r.launch.url;
    trace({ ev: "browser", url });
    try {
      Bun.spawn(launchCommand(r.launch).argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      this.say(`${what}: opened in the browser`);
    } catch {
      this.say(`${what}: ${url}`);
    }
  }

  /** Space u g: the agent's guide to the version on the right, in the browser; the terminal has no Guide tab yet. */
  private guide(): void {
    const v = this.v;
    const vs = v.data.status?.versionsList ?? [];
    const c = v.changes;
    const [from, to] = v.tab === "changes" && c.from && c.to ? [c.from, c.to] : onlyVersion(vs[vs.length - 1]?.number ?? 1);
    const n = /^\d+$/.test(to) ? Number(to) : to === "now" ? null : vs.find((x) => x.snapshot === to)?.number;
    if (!vs.find((x) => x.number === n)?.guide) return this.say(`${/^\d+$/.test(to) ? `v${to}` : to} has no guide: the agent writes one with stet version create --guide`);
    void this.browser(`the guide to v${n}`, { from, at: to, guide: true });
  }

  /** V, i on a thread's page: a cursor on its code, at first on the thread's first line. */
  private intoCode(then: "visual" | "comment"): void {
    const v = this.v;
    if (!v.detail || v.selected !== v.detail.thread.id) return;
    if (v.detail.thread.region || !v.code.enter()) return this.say("this thread has no lines of code to comment on here");
    v.codeCursor = true;
    if (v.focus !== "code") v.focus = "code";
    if (then === "visual") v.code.diff.startSelection();
    else this.commentThread();
    this.redraw();
  }

  private leaveCode(): void {
    if (!this.v.codeCursor) return;
    this.v.codeCursor = false;
    this.v.code.leave();
  }

  /** A new thread on lines of a thread's code: at the step its side of the code is at. */
  private commentThread(): void {
    const v = this.v;
    const d = v.detail;
    const sel = v.code.diff.selection();
    const shown = v.code.drawn;
    if (!d || !sel || !shown) return this.say("put the cursor on a line of code");
    const { from, to } = codeEnds(d, shown.view, shown.scope);
    const step = sel.side === 0 ? from : to;
    if (!step.path) return this.say(`the thread's code is gone at ${step.label}`);
    if (v.code.diff.anchor < 0) v.code.diff.startSelection();
    this.write({ kind: "thread", path: step.path, side: sel.side === 0 ? "old" : "new", start: sel.start, end: sel.end, at: step.sha, label: step.label, from: "thread" });
  }

  /** The keys of a cursor on a thread's code: the moves, sides and selection of the diff's own. */
  private runLines(id: string, n: number): boolean {
    const d = this.v.code.diff;
    const to = (r: number, align: "nearest" | "center" = "nearest") => {
      if (r !== -1) d.goTo(r, align);
      this.redraw();
      return true;
    };
    const repeat = (step: () => number) => {
      let r = -1;
      for (let i = 0; i < n; i++) {
        const next = step();
        if (next === -1) break;
        d.goTo((r = next));
      }
      if (r === -1) this.say("nothing further that way");
      return to(-1);
    };
    const lines = (by: number) => to(d.lay.rowAt(Math.max(0, Math.min(d.lay.total - 1, d.lay.top(d.cursor) + by))));
    const half = Math.max(1, Math.floor(this.v.geom.page / 2));
    switch (id) {
      case "diff.down":
      case "diff.up": {
        let r = d.cursor;
        for (let i = 0; i < n; i++) {
          const next = this.codeRow(r, id === "diff.down" ? 1 : -1);
          if (next === -1) break;
          r = next;
        }
        return to(r);
      }
      case "diff.first":
      case "diff.last":
        return to(this.codeRow(id === "diff.first" ? -1 : d.rows.len, id === "diff.first" ? 1 : -1));
      case "diff.pageDown":
      case "diff.pageUp":
        return lines(id === "diff.pageDown" ? half : -half);
      case "diff.nextChange":
      case "diff.prevChange":
        return repeat(() => d.nextChange(id === "diff.nextChange" ? 1 : -1));
      case "diff.nextHunk":
      case "diff.prevHunk":
        return repeat(() => d.nextHunk(id === "diff.nextHunk" ? 1 : -1));
      case "diff.center":
        return this.redraw(), true;
      case "diff.visual":
        if (d.anchor >= 0) d.clearSelection();
        else d.startSelection();
        return this.redraw(), true;
      case "diff.otherEnd":
        d.swapEnds();
        return this.redraw(), true;
      case "diff.comment":
        return this.commentThread(), true;
      case "diff.sideOld":
      case "diff.sideNew":
        if (!d.setSide(id === "diff.sideOld" ? 0 : 1)) this.say(d.split ? "no line on that side here" : "the sides stand next to each other in split: Space u d");
        return this.redraw(), true;
      case "diff.escape":
        if (d.anchor >= 0) d.clearSelection();
        else this.leaveCode();
        return this.redraw(), true;
    }
    return false;
  }

  /** The next row of a thread's code that is a line, from `r` on in `dir`; -1 at the end. */
  private codeRow(r: number, dir: 1 | -1): number {
    const d = this.v.code.diff;
    for (let i = r + dir; i >= 0 && i < d.rows.len; i += dir) if (DiffView.isCode(d.rows.kind[i]!)) return i;
    return -1;
  }

  // --- actions: what the keys run, by the ids of the shared key table (src/ui/keys/table.ts), one record per page.
  // The records only make closures: nothing in them reads the state until a key runs, so App.ids() can list them.

  /** Every action the terminal runs, and the rows it lists without running them yet (OFF). */
  private registry(): Actions {
    return { ...this.roundActions(), ...this.draftsActions(), ...this.changesActions(), ...this.globalActions(), ...this.boxActions(), ...this.offActions() };
  }

  /** The ids the terminal reads rows for, where there is no app: the menus and help in frame tests. */
  static ids(): ReadonlySet<string> {
    return new Set(Object.keys(App.prototype.registry.call(Object.create(App.prototype) as App)));
  }

  /** The Round tab: the thread list, the files, the thread's code and conversation. */
  private roundActions(): Actions {
    const v = () => this.v;
    const half = () => Math.max(1, Math.floor(this.v.geom.page / 2));
    const list = () => ordered(this.v.data, this.v.filter, this.v.selected);
    const toFile = (dir: 1 | -1) => () => {
      const cur = this.v.selected;
      const next = stepFile(threadGroups(this.v.data, this.v.filter, cur), cur, dir);
      if (next === cur || next === null) return this.say(dir === 1 ? "the last file" : "the first file");
      this.select(next);
      this.land(next);
    };
    const unread = (dir: 1 | -1) => () => {
      const next = stepUnread(list(), this.v.selected, dir);
      if (next === null) return this.say("no unread threads");
      this.select(next);
    };
    const thread = (dir: 1 | -1) => () => {
      const cur = this.v.selected;
      const next = stepThread(list(), cur, dir);
      if (next === cur) return this.say(dir === 1 ? "the last thread" : "the first thread");
      this.select(next);
    };
    const focusStep = (dir: 1 | -1) => () => {
      if (v().tab === "changes") {
        v().changes.focus = v().changes.focus === "list" ? "diff" : "list";
        return this.redraw();
      }
      if (v().tab !== "round") return;
      const cols = v().geom.columns;
      if (cols === 1) return this.focus(v().focus === "list" ? "code" : "list");
      const order = cols === 3 ? (["list", "code", "conv"] as const) : (["list", "code"] as const);
      const at = Math.max(0, order.indexOf(v().focus as never));
      this.focus(order[(at + (dir === 1 ? 1 : order.length - 1)) % order.length]!);
    };
    const wider = (next: () => void) => () => {
      next();
      v().tops.code = v().tops.thread = 0;
      void this.loadWide();
      this.redraw();
    };
    return {
      quit: () => this.end({ code: 0 }),
      "list.down": () => this.moveList(1),
      "list.up": () => this.moveList(-1),
      "list.first": () => this.moveList("first"),
      "list.last": () => this.moveList("last"),
      "list.pageDown": () => this.moveList(Math.max(1, Math.floor(half() / 2))),
      "list.pageUp": () => this.moveList(-Math.max(1, Math.floor(half() / 2))),
      "files.down": () => this.moveFile(1),
      "files.up": () => this.moveFile(-1),
      "files.first": () => this.moveFile("first"),
      "files.last": () => this.moveFile("last"),
      "files.open": () => {
        const path = v().fileSel;
        if (!path || !v().data.threads.some((t) => fileOf(t) === path)) return this.say("no threads in this file");
        this.focus("code");
      },
      "side.files": () => this.setSide("files"),
      "side.threads": () => this.setSide("threads"),
      "list.open": () => void (v().selected !== null && this.focus("code")),
      "list.close": () => {
        if (v().tab === "changes") {
          v().changes.focus = "diff";
          return this.redraw();
        }
        if (v().geom.columns === 1 && v().detail) this.focus("code");
      },
      "list.reply": () => {
        const id = v().selected;
        if (id === null) return;
        this.focus(v().geom.columns === 3 ? "conv" : "code");
        this.write({ kind: "reply", thread: id });
      },
      "thread.nextFile": toFile(1),
      "thread.prevFile": toFile(-1),
      "unread.next": unread(1),
      "unread.prev": unread(-1),
      "thread.next": thread(1),
      "thread.prev": thread(-1),
      "focus.next": focusStep(1),
      "focus.prev": focusStep(-1),
      "focus.left": () => {
        const cols = v().geom.columns;
        if (v().back === "changes" && !(cols === 3 && v().focus === "conv")) {
          v().back = null;
          return this.setTab("changes");
        }
        this.focus(cols === 3 && v().focus === "conv" ? "code" : "list");
      },
      "focus.right": () => this.focus("conv"),
      "scroll.down": () => this.scroll(1),
      "scroll.up": () => this.scroll(-1),
      "scroll.pageDown": () => this.scroll(half()),
      "scroll.pageUp": () => this.scroll(-half()),
      "scroll.top": () => this.scroll("top"),
      "scroll.bottom": () => this.scroll("bottom"),
      "msg.next": () => this.message(1),
      "msg.prev": () => this.message(-1),
      "code.view": () => {
        const d = v().detail;
        if (!d) return;
        const views = codeViews(d);
        if (views.length < 2) return this.say("the thread's code has one view only");
        wider(() => {
          const view = views[(views.indexOf(v().view ?? views[0]!) + 1) % views.length]!;
          v().view = view;
          if (!scopesOf(d, view).includes(v().scope)) v().scope = "around";
        })();
      },
      "code.more": () => {
        const d = v().detail;
        if (!d) return;
        const scopes = scopesOf(d, threadCode(d, v().view).view);
        if (scopes.length < 2) return this.say("the thread's code has no wider scope");
        wider(() => (v().scope = scopes[(Math.max(0, scopes.indexOf(v().scope)) + 1) % scopes.length]!))();
      },
      "thread.reply": () => {
        const id = v().selected;
        if (id !== null) this.write({ kind: "reply", thread: id });
      },
      "thread.resolve": () => void this.resolve(),
      "thread.reopen": () => void this.reopen(),
    };
  }

  /** The Drafts tab. */
  private draftsActions(): Actions {
    const v = () => this.v;
    return {
      "drafts.down": () => this.moveDraft(1),
      "drafts.up": () => this.moveDraft(-1),
      "drafts.open": () => {
        const c = this.selectedDraft();
        if (!c) return;
        v().tab = "round";
        if (!ordered(v().data, v().filter, c.threadId).some((t) => t.id === c.threadId)) v().filter = { status: "all", newOnly: false };
        this.select(c.threadId);
        this.focus("code");
      },
      "drafts.edit": () => {
        const c = this.selectedDraft();
        if (c) this.write({ kind: "edit", comment: c.id, thread: c.threadId }, c.body);
      },
      "drafts.discard": () => void this.discard(),
      "drafts.summary": () => this.write({ kind: "summary" }, v().summary),
      "review.changes": () => void this.requestChanges(),
      "review.approve": () => void this.approve(),
      "drafts.guide": () => {
        if (!v().data.drafts.length) return this.say("a guide goes with Request changes: there are no drafts", "error");
        v().guide = !v().guide;
        this.redraw();
      },
      "tab.round": () => this.setTab("round"),
    };
  }

  /** The Changes tab: its diff and its files. */
  private changesActions(): Actions {
    const c = () => this.v.changes;
    const d = () => this.v.changes.diff;
    const move = (to: () => number, align: "nearest" | "top" | "center" = "nearest") => () => {
      const at = to();
      if (at === -1) return;
      d().goTo(at, align);
      this.followDiff();
    };
    const repeat = (step: () => number, align: "nearest" | "top" | "center" = "nearest") => (n: number) => {
      let to = -1;
      for (let i = 0; i < n; i++) {
        const next = step();
        if (next === -1) break;
        to = next;
        d().goTo(next, align);
      }
      if (to === -1) this.say("nothing further that way");
      this.followDiff();
    };
    const side = (by: number) => (n: number) => {
      if (c().wrap) return this.say("w turns wrap off; then the code scrolls sideways");
      d().scrollSide(by * n);
      this.redraw();
    };
    return {
      "diff.down": (n) => move(() => d().cursor + n)(),
      "diff.up": (n) => move(() => d().cursor - n)(),
      "diff.first": move(() => 0, "top"),
      "diff.last": move(() => d().rows.len - 1),
      "diff.pageDown": () => (d().page(1), this.followDiff()),
      "diff.pageUp": () => (d().page(-1), this.followDiff()),
      "diff.nextChange": repeat(() => d().nextChange(1)),
      "diff.prevChange": repeat(() => d().nextChange(-1)),
      "diff.nextHunk": repeat(() => d().nextHunk(1)),
      "diff.prevHunk": repeat(() => d().nextHunk(-1)),
      "diff.nextFile": repeat(() => d().nextFile(1), "top"),
      "diff.prevFile": repeat(() => d().nextFile(-1), "top"),
      "diff.nextThread": () => this.stepThread(1),
      "diff.prevThread": () => this.stepThread(-1),
      "diff.center": () => (d().reveal("center"), this.redraw()),
      "diff.open": () => this.fold(true, c().focus === "list"),
      "diff.close": () => this.fold(false, c().focus === "list"),
      "diff.toggle": () => this.fold("toggle", c().focus === "list"),
      "diff.openAll": () => this.foldAll(true),
      "diff.closeAll": () => this.foldAll(false),
      "diff.right": side(8),
      "diff.left": side(-8),
      "diff.enter": () => this.enter(),
      "diff.viewed": () => void this.toggleViewed(),
      "range.toNext": () => this.shiftRange("to", 1),
      "range.toPrev": () => this.shiftRange("to", -1),
      "range.fromNext": () => this.shiftRange("from", 1),
      "range.fromPrev": () => this.shiftRange("from", -1),
      "range.preset": () => this.nextPreset(),
      "changes.files": () => ((c().focus = "list"), this.redraw()),
      "changes.back": () => this.setTab("round"),
      "cfiles.down": (n) => this.moveListFile(n),
      "cfiles.up": (n) => this.moveListFile(-n),
      "cfiles.first": () => this.moveListFile("first"),
      "cfiles.last": () => this.moveListFile("last"),
      "cfiles.open": () => {
        const row = c().rows.find((r) => r.fd.name === c().sel);
        if (row?.hidden && row.group) this.toggleGroup(row.group, true);
        if (c().sel) this.goToFile(c().sel!);
        c().focus = "diff";
        this.redraw();
      },
      "diff.wrap": () => {
        c().wrap = !c().wrap;
        d().setWrap(c().wrap);
        this.v.code.diff.setWrap(c().wrap);
        this.v.draftCode.diff.setWrap(c().wrap);
        this.say(c().wrap ? "long lines wrap" : "long lines are cut: zl / zh scroll sideways");
      },
      "diff.layout": () => {
        c().layout = d().split ? "unified" : "split";
        d().setLayout(c().layout);
        this.say(`${c().layout} diff`);
      },
      "diff.tests": () => this.toggleGroup("tests"),
    };
  }

  /** The keys of every tab. */
  private globalActions(): Actions {
    const v = () => this.v;
    return {
      "filter.resolved": () => {
        v().filter = { ...v().filter, status: v().filter.status === "open" ? "all" : "open", newOnly: false };
        if (v().changes.data) syncChanges(v().data, v().changes, v().filter.status === "all");
        this.say(v().filter.status === "all" ? "showing all threads" : "showing open threads and drafts");
      },
      "filter.news": () => {
        v().filter = { ...v().filter, newOnly: !v().filter.newOnly };
        if (v().tab !== "round") this.setTab("round");
        this.say(v().filter.newOnly ? "showing only threads with news" : "showing every thread again");
      },
      "tab.drafts": () => this.setTab("drafts"),
      "tab.changes": () => {
        const r = defaultCompare(refsOf(v().data), v().changes.reviewed);
        this.openRange(r.from, r.to);
      },
      submit: () => this.setTab("drafts"),
      refresh: () => void this.refreshNow(),
      help: () => this.openHelp(),
    };
  }

  /** The boxes over a tab: the keys list and a question. The reply box runs its keys in composerKey. */
  private boxActions(): Actions {
    const v = () => this.v;
    return {
      "help.close": () => this.closeHelp(),
      "choice.down": () => this.moveChoice(1),
      "choice.up": () => this.moveChoice(-1),
      "choice.pick": () => this.pick(v().choice?.at ?? 0),
      "choice.cancel": () => this.pick(null),
      "composer.draft": () => void this.send("draft"),
      "composer.now": () => void this.send(v().writing?.kind === "reply" || v().writing?.kind === "thread" ? "now" : "draft"),
      "composer.leave": () => this.leave(),
    };
  }

  /** The rows the terminal lists but does not run yet. */
  private offActions(): Actions {
    return Object.fromEntries(
      Object.entries(OFF).map(([id, off]) => [
        id,
        () => {
          const row = rowOf(id);
          if (off === "browser") void this.browser(row?.short ?? row?.desc ?? id);
          else this.say(`${row?.desc ?? id}: not in the terminal yet`);
        },
      ]),
    );
  }

  private moveChoice(dir: 1 | -1): void {
    const c = this.v.choice;
    if (c) c.at = (c.at + (dir === 1 ? 1 : c.options.length - 1)) % c.options.length;
    this.redraw();
  }

  private runRow(row: KeyRow, n = 1): void {
    runRow(row, n, this.actions, this.conditions);
  }

  private async resolve(): Promise<void> {
    const d = this.v.detail;
    if (!d || !this.api || d.thread.id !== this.v.selected) return;
    if (d.thread.draft) return this.say("a draft thread cannot be resolved: discard it on the Drafts tab (s)", "error");
    if (d.thread.status === "resolved") return this.say(`#${d.thread.id} is resolved already · X reopens it`);
    if (await this.guard(this.api.resolve(this.review, d.thread.id, null))) {
      this.say(`resolved #${d.thread.id} · X reopens it`);
      await this.reload();
    }
  }

  private async reopen(): Promise<void> {
    const d = this.v.detail;
    if (!d || !this.api || d.thread.id !== this.v.selected) return;
    if (d.thread.status === "open") return this.say(`#${d.thread.id} is open`);
    if (await this.guard(this.api.reopen(this.review, d.thread.id))) {
      this.say(`reopened #${d.thread.id}`);
      await this.reload();
    }
  }

  private async discard(): Promise<void> {
    const c = this.selectedDraft();
    if (!c || !this.api) return;
    const ids = this.v.data.drafts.map((x) => x.id);
    const r = await this.guard(this.api.discardDraft(this.review, c.id));
    if (!r) return;
    this.v.draftSel = ids[ids.indexOf(c.id) + 1] ?? ids[ids.indexOf(c.id) - 1] ?? null;
    this.texts.set(`edit:${c.id}`, "");
    this.say(r.threadDeleted ? `discarded the draft thread #${r.thread}` : `discarded the draft reply on #${r.thread}`);
    await this.reload();
    this.showDraft();
  }

  private async refreshNow(): Promise<void> {
    if (!this.api) return;
    const r = await this.guard(this.api.refreshNow(this.review));
    if (!r) return;
    this.say(r.changed ? "now: re-read the working tree" : "now: no changes in the working tree");
    await this.reload();
  }

  private ask(title: string, text: string, options: { value: string; label: string }[]): Promise<string | null> {
    return new Promise((done) => {
      this.v.choice = { title, text, options, at: 0 };
      this.choiceDone = done;
      this.redraw();
    });
  }

  private pick(at: number | null): void {
    const c = this.v.choice;
    const done = this.choiceDone;
    if (!c || !done) return;
    this.v.choice = null;
    this.choiceDone = null;
    this.redraw();
    done(at === null ? null : (c.options[at]?.value ?? null));
  }

  private settled(ids: number[]): string {
    return ids.length ? `; ${ids.map((id) => `#${id}`).join(" ")} resolved with your message` : "";
  }

  private async afterSubmit(): Promise<void> {
    this.v.summary = "";
    this.v.guide = false;
    this.texts.set("summary", "");
    this.v.tab = "round";
    await this.reload();
  }

  private async requestChanges(): Promise<void> {
    if (!this.api) return;
    if (this.v.data.drafts.length === 0) return this.say("no drafts to submit", "error");
    const r = await this.guard(this.api.submit(this.review, this.v.summary, this.v.guide ? { guide: true } : {}));
    if (!r) return;
    this.say(`changes requested: ${plural(r.comments, "comment")} in ${plural(r.threads.length, "thread")} went to the agent${this.settled(r.settled)}${r.guide ? ", with a request for a guide to the next version" : ""}`);
    await this.afterSubmit();
  }

  /** As the web approves: drafts go along as nits if you say so, and you pick what happens to the other open threads. */
  private async approve(): Promise<void> {
    if (!this.api) return;
    const mine = this.v.data.drafts;
    if (mine.length > 0) {
      const how = await this.ask(`Approve with ${plural(mine.length, "draft")}?`, "Approving says this version is done. The drafts can go with it as nits, or as a request for changes and a new round.", [
        { value: "nits", label: "Approve; drafts go as nits (the agent fixes them without a new round)" },
        { value: "changes", label: "Send as Request changes" },
      ]);
      if (how === null) return;
      if (how === "changes") return this.requestChanges();
    }
    const inReview = new Set(mine.map((c) => c.threadId));
    const open = this.v.data.threads.filter((t) => t.status === "open" && !t.draft && !inReview.has(t.id));
    let keep: "keep" | "resolve" | undefined;
    if (open.length > 0) {
      const list = open.slice(0, 5).map((t) => `#${t.id} ${t.title.split("\n")[0]}`).join("; ");
      const how = await this.ask(
        `${plural(open.length, "thread")} still open`,
        `Approve and leave ${open.length === 1 ? "it" : "them"} open, or resolve ${open.length === 1 ? "it" : "them all"} first: ${list}${open.length > 5 ? ` and ${open.length - 5} more` : ""}`,
        [
          { value: "keep", label: "Approve anyway" },
          { value: "resolve", label: "Resolve all and approve" },
        ],
      );
      if (how === null) return;
      keep = how as "keep" | "resolve";
    }
    const r = await this.guard(this.api.submit(this.review, this.v.summary, { verdict: "approved", open: keep }));
    if (!r) return;
    const nits = r.comments ? `; ${plural(r.comments, "comment")} went to the agent as nits` : "";
    this.say(`approved v${r.version}${nits}${r.resolved.length ? `; resolved ${plural(r.resolved.length, "thread")}` : ""}${this.settled(r.settled)}`);
    await this.afterSubmit();
  }

  // --- composer

  private write(w: Writing, initial = ""): void {
    const v = this.v;
    const key = textKey(w);
    const d = v.detail;
    const draftThread = w.kind === "reply" && d?.thread.id === w.thread && d.thread.draft;
    const placeholder =
      w.kind === "reply" ? (draftThread ? "Add to this draft thread…" : "Reply to the thread…") : w.kind === "edit" ? "" : w.kind === "thread" ? "What is wrong here?" : "Optional summary for the whole review";
    v.writing = w;
    this.matcher.reset();
    v.prefix = [];
    v.composerText = this.texts.get(key) || initial;
    this.composer.show(placeholder, v.composerText, (text) => {
      v.composerText = text;
      this.texts.set(key, text);
      this.redraw();
    });
    v.tops.conv = v.tops.thread = Number.MAX_SAFE_INTEGER;
    this.redraw();
  }

  private leave(): void {
    this.composer.hide();
    this.v.writing = null;
    this.redraw();
  }

  private async send(mode: "draft" | "now"): Promise<void> {
    const w = this.v.writing;
    const api = this.api;
    if (!w || !api) return;
    const text = this.composer.text;
    const key = textKey(w);
    if (w.kind === "summary") {
      this.v.summary = text;
      this.texts.set(key, text);
      this.leave();
      return this.say(text.trim() ? "summary kept: it goes out with the review (S)" : "no summary");
    }
    if (!text.trim()) return this.say("nothing to send: write something first", "error");
    if (w.kind === "edit") {
      if (!(await this.guard(api.editDraft(this.review, w.comment, text)))) return;
      this.texts.set(key, "");
      this.leave();
      this.say("draft saved");
      await this.reload();
      return this.showDraft();
    }
    if (w.kind === "thread") return this.createThread(w, text, mode);
    const r = await this.guard(api.reply(this.review, w.thread, { body: text, draft: mode === "draft" }));
    if (!r) return;
    this.texts.set(key, "");
    this.leave();
    this.say(mode === "draft" ? "draft reply saved · the agent sees it after you submit the review (S)" : "reply sent to the agent");
    await this.reload();
    this.v.tops.conv = this.v.tops.thread = Number.MAX_SAFE_INTEGER;
    this.redraw();
  }

  /** A new thread on the lines picked, as the web makes one: a draft unless sent now. */
  private async createThread(w: Extract<Writing, { kind: "thread" }>, text: string, mode: "draft" | "now"): Promise<void> {
    if (!this.api) return;
    const t = await this.guard(this.api.addThread(this.review, { path: w.path, start: w.start, end: w.end, side: w.side, at: w.at, body: text, draft: mode === "draft" }));
    if (!t) return;
    this.texts.set(textKey(w), "");
    this.leave();
    const v = this.v;
    if (w.from === "changes") {
      v.changes.diff.clearSelection();
      v.changes.thread = t.id;
    } else v.code.diff.clearSelection();
    this.say(mode === "draft" ? `draft #${t.id} saved on ${w.path}:${rangeText(w)} · the agent sees it after you submit the review (S)` : `thread #${t.id} sent to the agent`);
    await this.reload();
  }

  // --- mouse

  private click(e: MouseEvent): void {
    if (e.button !== 0) return;
    const hit = hitAt(this.hits, e.x, e.y);
    const v = this.v;
    if (v.help) {
      if (!hit?.startsWith("focus:help") && !hit?.startsWith("key:")) return this.closeHelp();
      if (hit.startsWith("key:")) return this.runKeys(hit.slice(4));
      return this.redraw();
    }
    if (v.picker) {
      if (hit?.startsWith("pick:")) {
        v.picker.at = Number(hit.slice(5));
        return this.pickRow("pick");
      }
      if (!hit?.startsWith("focus:picker")) {
        v.picker = null;
        this.choosing = null;
      }
      return this.redraw();
    }
    if (!hit) return;
    const [kind, arg = ""] = [hit.slice(0, hit.indexOf(":")), hit.slice(hit.indexOf(":") + 1)];
    if (kind === "key") return this.runKeys(arg);
    // While a box asks or the composer is open, only its own chips answer a click.
    if (v.choice || this.composer.open) return;
    this.matcher.reset();
    this.syncPrefix();
    if (kind === "tab") return this.setTab(arg as "round" | "changes" | "drafts");
    if (kind === "side") return this.setSide(arg as Side);
    if (kind === "thread") {
      if (v.focus !== "list") this.focus("list");
      return this.select(Number(arg));
    }
    if (kind === "fref") {
      const [cid, n] = arg.split(":").map(Number);
      const c = v.detail?.comments.find((x) => x.id === cid);
      const link = this.threadLinks().find((x) => x.link.hit === hit)?.link;
      if (c && link && n !== undefined) this.followRef(c, link);
      return;
    }
    if (kind === "file") {
      this.focus("list");
      return this.selectFile(arg);
    }
    if (kind === "draft") {
      v.draftSel = Number(arg);
      return this.showDraft();
    }
    if (v.tab === "changes") return this.clickChanges(kind, arg, e);
    if (kind === "focus" && v.tab === "round") {
      if (arg === "list" || arg === "code" || arg === "conv") {
        if (arg !== "list" && v.selected === null) return;
        this.focus(arg === "conv" && v.geom.columns < 3 ? "code" : arg);
      }
    }
  }

  /** A click on the Changes tab: a file in the list, a row of the diff (a header folds, a bar opens, a card opens its thread). */
  private clickChanges(kind: string, arg: string, e: MouseEvent): void {
    const c = this.v.changes;
    const g = this.v.geom.diff;
    if (kind === "cfile" && (!g || e.x < g.x)) {
      c.focus = "list";
      c.sel = arg;
      this.goToFile(arg);
      return this.redraw();
    }
    if (kind === "focus" && arg === "clist") {
      c.focus = "list";
      return this.redraw();
    }
    if (!g) return;
    const r = c.diff.rowAtLine(e.y - g.y);
    c.focus = "diff";
    if (r < 0) return this.redraw();
    c.diff.goTo(r);
    this.followDiff();
    const k = c.diff.rows.kind[r];
    if (k === FILE || k === GROUP || k === GAP || kind === "cthread") this.enter();
  }

  /** The wheel scrolls the column under the pointer, whichever has the focus. */
  private wheel(e: MouseEvent): void {
    const dir = e.scroll?.direction;
    if (dir !== "up" && dir !== "down") return;
    const by = (dir === "down" ? 1 : -1) * WHEEL_ROWS;
    const v = this.v;
    // The pane is named by its left border: the first `focus:` target left of the pointer on its row.
    let pane: Hit | null = null;
    for (const h of this.hits) if (h.y === e.y && h.x0 <= e.x && h.hit.startsWith("focus:") && (!pane || h.x0 > pane.x0)) pane = h;
    const name = pane?.hit.slice(6);
    if (name === "cdiff") {
      v.changes.diff.scroll(by);
      this.followDiff();
      return;
    }
    if (name === "clist") {
      v.tops.clist = Math.max(0, v.tops.clist + by);
      return this.redraw();
    }
    const top = (k: keyof typeof v.tops) => (v.tops[k] = Math.max(0, Math.min(v.tops[k], 100_000) + by));
    if (name === "list") {
      v.followList = false;
      top("list");
    } else if (name === "code") top(v.geom.columns === 3 ? "code" : "thread");
    else if (name === "conv") top("conv");
    else if (name === "drafts") top("drafts");
    else if (name === "draft") top("draft");
    else if (name === "help") top("help");
    else return;
    this.redraw();
  }

  /** A key chip clicked: its keys run as if typed. */
  private runKeys(keys: string): void {
    if (this.composer.open) {
      const row = rowFor(KEYS, keys, ["composer"], this.reader);
      if (row) this.runRow(row);
      return;
    }
    if (this.v.choice && /^[1-9]$/.test(keys)) return this.pick(Number(keys) - 1);
    if (!this.v.prefix.length || !keys.startsWith(this.v.prefix.join(""))) this.matcher.reset();
    else keys = keys.slice(this.v.prefix.join("").length);
    for (const token of tokens(keys)) {
      const m = this.matcher.feed(token, this.scopes());
      this.syncPrefix();
      if ("fire" in m) this.runRow(m.fire);
    }
    this.redraw();
  }

  // --- keys

  /** Where keys go: the box over the screen alone, else the column in focus and then everywhere. */
  private scopes(): Scope[] {
    const sc = scopeOf(this.v);
    if (sc === "menu") return [SCOPE[columnOf(this.v)], "global"];
    if (sc === "help" || sc === "choice" || sc === "composer" || sc === "picker") return [SCOPE[sc]];
    return [SCOPE[sc], "global"];
  }

  private key(k: KeyEvent): void {
    // Ctrl+C is OpenTUI's: it destroys the renderer, and the app ends on that.
    if (k.ctrl && k.name === "c") return;
    const token = this.keys.token(k);
    if (token === null) return;
    if (tracing) this.keyName = token;
    if (this.composer.open) return this.composerKey(k, token);
    k.preventDefault();
    const v = this.v;
    if (v.help) return this.helpKey(token);
    if (v.picker && !v.choice) return this.pickerKey(k, token);
    if (v.changes.search.typing && v.tab === "changes" && !v.choice) return this.searchKey(k, token);
    if (v.choice && /^[1-9]$/.test(token)) {
      const at = Number(token) - 1;
      if (at < v.choice.options.length) this.pick(at);
      return;
    }
    if (COUNT_SCOPES.has(this.scopes()[0]!) && !this.matcher.prefix.length && /^[0-9]$/.test(token) && (token !== "0" || v.count)) {
      v.count += token;
      return this.redraw();
    }
    if (token === "<Esc>" && v.count) {
      v.count = "";
      return this.redraw();
    }
    if (token === "<BS>" && this.matcher.prefix.length) {
      this.matcher.back();
    } else {
      const m = this.matcher.feed(token, this.scopes());
      if ("fire" in m) {
        this.syncPrefix();
        const n = m.fire.count ? Math.max(1, Number(v.count) || 1) : 1;
        v.count = "";
        return this.runRow(m.fire, n);
      }
    }
    this.syncPrefix();
    this.redraw();
  }

  private syncPrefix(): void {
    this.v.prefix = [...this.matcher.prefix];
    this.v.next = this.v.prefix.length ? menuEntries(this.matcher.next(this.scopes())) : [];
  }

  private composerKey(k: KeyEvent, token: string): void {
    const now = Date.now();
    if (token === "j" && now - this.lastJ < JJ_MS && this.composer.text.endsWith("j")) {
      k.preventDefault();
      this.composer.dropLastChar();
      this.lastJ = 0;
      return this.leave();
    }
    this.lastJ = token === "j" ? now : 0;
    const row = rowFor(KEYS, token, ["composer"], this.reader);
    if (!row) return;
    k.preventDefault();
    this.runRow(row);
  }

  /** `?`: the keys here, and a tester of what each key does in this terminal. */
  private openHelp(): void {
    const column = columnOf(this.v);
    const term = this.terminal();
    this.v.help = helpFor(column, this.reader, term);
    this.v.tops.help = 0;
    this.tester = new KeyTester(this.reader, term, [SCOPE[column], "global"], (t) => this.tried(t));
    this.redraw();
  }

  private closeHelp(): void {
    this.tester?.reset();
    this.tester = null;
    this.v.help = null;
    this.redraw();
  }

  private helpKey(token: string): void {
    if (rowFor(KEYS, token, ["help"], this.reader)) return this.closeHelp();
    if (this.tester) this.tried(this.tester.press(token));
  }

  private tried(t: Tried): void {
    const h = this.v.help;
    if (!h) return;
    h.got = t.text;
    const at = t.row ? h.rows.indexOf(`${t.row.scope} ${t.row.id}`) : -1;
    h.lit = at === -1 ? null : at;
    if (h.lit !== null) this.v.tops.help = Math.max(0, h.lit - 3);
    this.redraw();
  }

  private terminal(): Terminal {
    const caps = this.renderer.capabilities;
    return terminalOf(process.env, caps?.kitty_keyboard ?? false, caps?.terminal?.name ?? null);
  }
}

/** The terminal UI on a review, until q in the list, Ctrl+C or a signal; the terminal is restored on every way out. */
export async function runTui(ctx: Ctx, review: number): Promise<number> {
  // Clicks and the wheel only: reporting every move would draw frames while the pointer wanders.
  // maxFps 60 holds a frame back up to 15 ms under fast keys (phase 0); frames are drawn only when asked for anyway
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: true, enableMouseMovement: false, autoFocus: false, maxFps: 1000 });
  let settle!: (r: { code: number } | { error: unknown }) => void;
  const result = new Promise<{ code: number } | { error: unknown }>((resolve) => (settle = resolve));
  const app = new App(renderer, ctx, review, settle);
  const crash = (e: unknown) => app.end({ error: e });
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  renderer.on("destroy", () => app.end({ code: 0 }));
  void app.start().catch(crash);
  const r = await result;
  try {
    await app.close();
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  }
  if ("error" in r) throw r.error;
  return r.code;
}
