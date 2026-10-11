import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { clientApi, type Api } from "../client/api.ts";
import { subscribe, type Live, type Subscription } from "../client/live.ts";
import { connect } from "../client/server.ts";
import type { Ctx } from "../core/context.ts";
import type { CommentDto, ThreadDetail } from "../core/types.ts";
import { stepFile, stepThread, stepUnread } from "../ui/nav.ts";
import { codeViews } from "./code.ts";
import { ComposerView } from "./composer.ts";
import { KeyReader } from "./keys/input.ts";
import { KeyMatcher, rowsIn } from "./keys/match.ts";
import { KEYS, type Scope } from "./keys/table.ts";
import { ordered, threadGroups } from "./model.ts";
import { helpLines, initialView, render, scopeOf, type Writing } from "./render.ts";
import { Screen } from "./screen.ts";
import { plural } from "./text.ts";
import { Texts, textsPath } from "./texts.ts";
import type { Toast } from "./views/bars.ts";

const TOAST_MS = 4000;
const READ_AFTER_MS = 800;
const RELOAD_MS = 150;
const PREVIEW_MS = 60;
const JJ_MS = 300;
const CACHE = 24;

const textKey = (w: Writing) => (w.kind === "reply" ? `reply:${w.thread}` : w.kind === "edit" ? `edit:${w.comment}` : "summary");

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
  private readonly keys = new KeyReader();
  private readonly matcher = new KeyMatcher(KEYS, (row) => this.run(row.id));
  readonly screen: Screen;
  private readonly composer: ComposerView;
  private readonly texts: Texts;
  private ended = false;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly ctx: Ctx,
    private readonly review: number,
    private readonly finish: (result: { code: number } | { error: unknown }) => void,
  ) {
    this.texts = new Texts(textsPath(ctx.repo.commonDir, review));
    this.v.summary = this.texts.get("summary");
    this.screen = new Screen(renderer, (w, h) => {
      try {
        this.v.now = Date.now();
        const f = render(this.v, w, h);
        if (this.composer.place(f.box)) this.later(0, () => this.redraw());
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
    for (const t of [...this.timers, this.toastTimer, this.readTimer, this.reloadTimer, this.previewTimer]) clearTimeout(t);
    this.matcher.reset();
    this.texts.flush();
    await this.sub?.close();
    this.sub = null;
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
      first ? api.cursors(r).catch(() => null) : Promise.resolve(null),
    ]);
    if (this.ended) return;
    const v = this.v;
    v.data = { ...v.data, status: status ?? v.data.status, threads: threads ?? v.data.threads, drafts: drafts ?? v.data.drafts };
    if (git) v.git = git;
    const latest = status?.versionsList?.[status.versionsList.length - 1];
    if (first && latest && latest.role === "agent" && latest.number > 1 && (cursors?.reviewed?.version ?? 0) < latest.number) v.banner = latest.number;
    if (v.selected === null || !v.data.threads.some((t) => t.id === v.selected)) v.selected = ordered(v.data, v.filter, null)[0]?.id ?? null;
    if (v.draftSel === null || !v.data.drafts.some((c) => c.id === v.draftSel)) v.draftSel = v.data.drafts[0]?.id ?? null;
    await Promise.all([this.fetchThread(v.selected), v.tab === "drafts" ? this.fetchThread(this.selectedDraft()?.threadId ?? null) : null]);
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
    return v.geom.columns === 1 ? !v.listOpen : v.focus !== "list";
  }

  // --- moving around

  /** Moves the list's cursor; the thread shows at once when fetched lately, else after a short pause. */
  private select(id: number | null): void {
    const v = this.v;
    if (id === null || id === v.selected) return;
    v.selected = id;
    v.view = null;
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
    if (v.geom.columns === 1) v.listOpen = f === "list";
    this.markReadSoon();
    this.redraw();
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
    if (tab === "changes") v.banner = null;
    this.redraw();
  }

  // --- actions

  private run(id: string): void {
    const v = this.v;
    const half = Math.max(1, Math.floor(v.geom.page / 2));
    const cur = v.selected;
    const list = () => ordered(v.data, v.filter, cur);
    const cols = v.geom.columns;
    switch (id) {
      case "quit":
        return this.end({ code: 0 });
      case "list.down":
        return this.moveList(1);
      case "list.up":
        return this.moveList(-1);
      case "list.first":
        return this.moveList("first");
      case "list.last":
        return this.moveList("last");
      case "list.pageDown":
        return this.moveList(Math.max(1, Math.floor(half / 2)));
      case "list.pageUp":
        return this.moveList(-Math.max(1, Math.floor(half / 2)));
      case "list.open":
        if (v.selected !== null) this.focus("code");
        return;
      case "list.close":
        if (cols === 1 && v.detail) this.focus("code");
        return;
      case "list.reply":
        if (v.selected === null) return;
        this.focus(cols === 3 ? "conv" : "code");
        return this.write({ kind: "reply", thread: v.selected });
      case "list.nextFile":
      case "list.prevFile":
      case "thread.nextFile":
      case "thread.prevFile": {
        const next = stepFile(threadGroups(v.data, v.filter, cur), cur, id.endsWith("nextFile") ? 1 : -1);
        if (next === cur) return this.say(id.endsWith("nextFile") ? "the last file" : "the first file");
        return this.select(next);
      }
      case "unread.next":
      case "unread.prev": {
        const next = stepUnread(list(), cur, id === "unread.next" ? 1 : -1);
        if (next === null) return this.say("no unread threads");
        return this.select(next);
      }
      case "thread.next":
      case "thread.prev": {
        const next = stepThread(list(), cur, id === "thread.next" ? 1 : -1);
        if (next === cur) return this.say(id === "thread.next" ? "the last thread" : "the first thread");
        return this.select(next);
      }
      case "filter.resolved":
        v.filter = { ...v.filter, status: v.filter.status === "open" ? "all" : "open", newOnly: false };
        return this.say(v.filter.status === "all" ? "showing all threads" : "showing open threads and drafts");
      case "filter.news":
        v.filter = { ...v.filter, newOnly: !v.filter.newOnly };
        if (v.tab !== "round") this.setTab("round");
        return this.say(v.filter.newOnly ? "showing only threads with news" : "showing every thread again");
      case "focus.next":
      case "focus.prev": {
        if (v.tab !== "round") return;
        if (cols === 1) return this.focus(v.listOpen ? "code" : "list");
        const order = cols === 3 ? (["list", "code", "conv"] as const) : (["list", "code"] as const);
        const at = Math.max(0, order.indexOf(v.focus as never));
        return this.focus(order[(at + (id === "focus.next" ? 1 : order.length - 1)) % order.length]!);
      }
      case "focus.left":
        return this.focus(cols === 3 && v.focus === "conv" ? "code" : "list");
      case "focus.right":
        return this.focus("conv");
      case "scroll.down":
        return this.scroll(1);
      case "scroll.up":
        return this.scroll(-1);
      case "scroll.pageDown":
        return this.scroll(half);
      case "scroll.pageUp":
        return this.scroll(-half);
      case "scroll.top":
        return this.scroll("top");
      case "scroll.bottom":
        return this.scroll("bottom");
      case "msg.next":
        return this.message(1);
      case "msg.prev":
        return this.message(-1);
      case "code.view": {
        const d = v.detail;
        if (!d) return;
        const views = codeViews(d);
        if (views.length < 2) return this.say("the thread's code has one view only");
        const at = views.indexOf(v.view ?? views[0]!);
        v.view = views[(at + 1) % views.length]!;
        v.tops.code = v.tops.thread = 0;
        return this.redraw();
      }
      case "code.more":
        return this.say("all changes and the whole file come with the diff widget");
      case "thread.reply":
        if (v.selected !== null) this.write({ kind: "reply", thread: v.selected });
        return;
      case "thread.resolve":
        return void this.resolve();
      case "thread.reopen":
        return void this.reopen();
      case "drafts.down":
        return this.moveDraft(1);
      case "drafts.up":
        return this.moveDraft(-1);
      case "drafts.open": {
        const c = this.selectedDraft();
        if (!c) return;
        v.tab = "round";
        if (!ordered(v.data, v.filter, c.threadId).some((t) => t.id === c.threadId)) v.filter = { status: "all", newOnly: false };
        this.select(c.threadId);
        return this.focus("code");
      }
      case "drafts.edit": {
        const c = this.selectedDraft();
        if (c) this.write({ kind: "edit", comment: c.id, thread: c.threadId }, c.body);
        return;
      }
      case "drafts.discard":
        return void this.discard();
      case "drafts.summary":
        return this.write({ kind: "summary" }, v.summary);
      case "drafts.approve":
        return void this.approve();
      case "drafts.changes":
        return void (v.data.drafts.length ? this.requestChanges() : this.approve());
      case "drafts.guide":
        if (!v.data.drafts.length) return this.say("a guide goes with Request changes: there are no drafts", "error");
        v.guide = !v.guide;
        return this.redraw();
      case "tab.round":
        return this.setTab("round");
      case "tab.drafts":
        return this.setTab("drafts");
      case "tab.changes":
        return this.setTab("changes");
      case "submit":
        return this.setTab("drafts");
      case "refresh":
        return void this.refreshNow();
      case "help":
        return this.openHelp();
      case "help.down":
      case "help.up":
        v.tops.help = Math.max(0, v.tops.help + (id === "help.down" ? 1 : -1));
        return this.redraw();
      case "help.close":
        v.help = null;
        return this.redraw();
      case "choice.down":
      case "choice.up": {
        const c = v.choice;
        if (c) c.at = (c.at + (id === "choice.down" ? 1 : c.options.length - 1)) % c.options.length;
        return this.redraw();
      }
      case "choice.pick":
        return this.pick(v.choice?.at ?? 0);
      case "choice.cancel":
        return this.pick(null);
    }
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
    const placeholder = w.kind === "reply" ? (draftThread ? "Add to this draft thread…" : "Reply to the thread…") : w.kind === "edit" ? "" : "Optional summary for the whole review";
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
    const r = await this.guard(api.reply(this.review, w.thread, { body: text, draft: mode === "draft" }));
    if (!r) return;
    this.texts.set(key, "");
    this.leave();
    this.say(mode === "draft" ? "draft reply saved · the agent sees it after you submit the review (S)" : "reply sent to the agent");
    await this.reload();
    this.v.tops.conv = this.v.tops.thread = Number.MAX_SAFE_INTEGER;
    this.redraw();
  }

  // --- keys

  private scopes(): Scope[] {
    const sc = scopeOf(this.v);
    if (sc === "menu") return [this.lastScope(), "global"];
    if (sc === "help" || sc === "choice" || sc === "composer") return [sc];
    return [sc, "global"];
  }

  /** The column under the Space menu. */
  private lastScope(): Scope {
    const v = this.v;
    if (v.tab !== "round") return v.tab;
    const cols = v.geom.columns;
    if (cols === 1) return v.listOpen ? "list" : "thread";
    if (v.focus === "list") return "list";
    return cols === 3 ? v.focus : "thread";
  }

  private key(k: KeyEvent): void {
    // Ctrl+C is OpenTUI's: it destroys the renderer, and the app ends on that.
    if (k.ctrl && k.name === "c") return;
    const token = this.keys.token(k);
    if (token === null) return;
    if (this.composer.open) return this.composerKey(k, token);
    k.preventDefault();
    const v = this.v;
    if (v.choice && /^[1-9]$/.test(token)) {
      const at = Number(token) - 1;
      if (at < v.choice.options.length) this.pick(at);
      return;
    }
    if (token === "<BS>" && this.matcher.prefix.length) {
      this.matcher.back();
    } else {
      const m = this.matcher.feed(token, this.scopes());
      if ("fire" in m) {
        this.syncPrefix();
        return this.run(m.fire.id);
      }
    }
    this.syncPrefix();
    this.redraw();
  }

  private syncPrefix(): void {
    this.v.prefix = [...this.matcher.prefix];
    this.v.next = this.v.prefix.length ? this.matcher.next(this.scopes()) : [];
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
    const row = rowsIn(KEYS, ["composer"]).find((c) => c.keys === token)?.row;
    if (!row) return;
    k.preventDefault();
    if (row.id === "composer.leave") this.leave();
    else void this.send(row.id === "composer.now" && this.v.writing?.kind === "reply" ? "now" : "draft");
  }

  private openHelp(): void {
    const scope = this.lastScope();
    const group = (sc: Scope) => {
      const byId = new Map<string, { keys: string[]; desc: string }>();
      for (const r of KEYS.filter((x) => x.scope === sc)) {
        const had = byId.get(r.id);
        if (had) had.keys.push(...r.keys);
        else byId.set(r.id, { keys: [...r.keys], desc: r.desc });
      }
      return [...byId.values()];
    };
    const names: Record<string, string> = { list: "The thread list", code: "The code", conv: "The conversation", thread: "The thread", drafts: "Drafts", changes: "Changes" };
    this.v.help = helpLines([
      { title: names[scope] ?? scope, rows: group(scope) },
      { title: "Everywhere", rows: group("global") },
    ]);
    this.v.tops.help = 0;
    this.redraw();
  }
}

/** The terminal UI on a review, until q in the list, Ctrl+C or a signal; the terminal is restored on every way out. */
export async function runTui(ctx: Ctx, review: number): Promise<number> {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, useMouse: false, autoFocus: false });
  let settle!: (r: { code: number } | { error: unknown }) => void;
  const result = new Promise<{ code: number } | { error: unknown }>((resolve) => (settle = resolve));
  const app = new App(renderer, ctx, review, settle);
  const crash = (e: unknown) => app.end({ error: e });
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  renderer.on("destroy", () => app.end({ code: 0 }));
  void app.start().catch(crash);
  const r = await result;
  const frames = app.screen.frames;
  try {
    await app.close();
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
    process.off("uncaughtException", crash);
    process.off("unhandledRejection", crash);
  }
  if (process.env.STET_TUI_FRAMES) await Bun.write(process.env.STET_TUI_FRAMES, String(frames));
  if ("error" in r) throw r.error;
  return r.code;
}
