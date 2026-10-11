import { createCliRenderer, type CliRenderer, type KeyEvent } from "@opentui/core";
import { clientApi, type Api } from "../client/api.ts";
import { subscribe, type Live, type Subscription } from "../client/live.ts";
import { connect } from "../client/server.ts";
import type { Ctx } from "../core/context.ts";
import type { CommentDto } from "../core/types.ts";
import { stepFile, stepThread, stepUnread } from "../ui/nav.ts";
import { ComposerView, composerHeight } from "./composer.ts";
import { footerLine, headerLine, type Toast } from "./frame.ts";
import { KeyReader } from "./keys/input.ts";
import { KeyMatcher, rowsIn } from "./keys/match.ts";
import { KEYS, keyLabel, type Scope } from "./keys/table.ts";
import { NO_DATA, ordered, threadGroups, type Data, type ListFilter } from "./model.ts";
import { draftsPage } from "./pages/drafts.ts";
import { threadPage } from "./pages/thread.ts";
import { threadsPage } from "./pages/threads.ts";
import { Screen, type Frame, type Overlay } from "./screen.ts";
import { line, plural, s, wrap, type Line } from "./text.ts";
import { Texts, textsPath } from "./texts.ts";

type Page = { name: "threads" } | { name: "thread"; id: number; from: "threads" | "drafts" } | { name: "drafts"; from: "threads" | "thread" };

/** What the composer writes: a reply to a thread, a draft's new text, or the summary of the whole review. */
type Writing = { kind: "reply"; thread: number } | { kind: "edit"; comment: number; thread: number } | { kind: "summary" };

interface Choice {
  title: string;
  text: string;
  options: { value: string; label: string }[];
  at: number;
  done: (value: string | null) => void;
}

const TOAST_MS = 4000;
const READ_AFTER_MS = 800;
const RELOAD_MS = 150;
const JJ_MS = 300;

const textKey = (w: Writing) => (w.kind === "reply" ? `reply:${w.thread}` : w.kind === "edit" ? `edit:${w.comment}` : "summary");

class App {
  private data: Data = NO_DATA;
  private page: Page = { name: "threads" };
  private filter: ListFilter = { status: "open", newOnly: false };
  private selected: number | null = null;
  private listTop = 0;
  private threadTop = 0;
  private toNews = false;
  /** Messages that were unread when the thread was opened: the `new` rule stays over them while it is open. */
  private fresh: { thread: number; ids: Set<number> } | null = null;
  private draftSel: number | null = null;
  private draftsTop = 0;
  private toast: Toast | null = null;
  private choice: Choice | null = null;
  private help: { top: number; lines: Line[] } | null = null;
  private writing: Writing | null = null;
  private connecting: string | null = "connecting…";
  private api: Api | null = null;
  private sub: Subscription | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private readTimer: ReturnType<typeof setTimeout> | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private lastJ = 0;
  private size = { w: 80, h: 24 };
  private readonly keys = new KeyReader();
  private readonly matcher = new KeyMatcher(KEYS, (row) => this.run(row.id));
  private readonly screen: Screen;
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
    this.screen = new Screen(renderer, (w, h) => {
      try {
        return this.frame(w, h);
      } catch (e) {
        this.end({ error: e });
        return { header: line(), body: [], footer: line(), overlay: null };
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
    this.redraw();
    await this.connect();
  }

  end(result: { code: number } | { error: unknown }): void {
    if (this.ended) return;
    this.ended = true;
    this.finish(result);
  }

  async close(): Promise<void> {
    for (const t of [...this.timers, this.toastTimer, this.readTimer, this.reloadTimer]) clearTimeout(t);
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
    this.toast = { text, tone };
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast = null;
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
    this.connecting = "connecting to the server…";
    this.redraw();
    let server;
    try {
      server = await connect(this.ctx);
    } catch (e) {
      this.connecting = "no server";
      this.say((e as Error).message, "error");
      return;
    }
    if (this.ended) return;
    this.api = clientApi(server);
    this.connecting = null;
    await this.reload();
    if (this.ended) return;
    const live: Live = {
      otherBuild: () => {
        this.say("the server was replaced by another build: reconnecting");
        void this.connect();
      },
      change: () => this.reloadSoon(),
      store: () => this.reloadSoon(),
      now: (n) => {
        this.data = { ...this.data, now: n };
        this.redraw();
      },
      connection: (up) => {
        this.data = { ...this.data, online: up };
        if (up) this.reloadSoon();
        else this.redraw();
      },
    };
    this.sub = subscribe(server, this.review, this.data.status?.lastSeq ?? 0, live);
  }

  private reloadSoon(): void {
    clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => void this.reload(), RELOAD_MS);
  }

  private async reload(): Promise<void> {
    const api = this.api;
    if (!api) return;
    const r = this.review;
    const page = this.page;
    const [status, threads, drafts, detail] = await Promise.all([
      this.guard(api.review(r)),
      this.guard(api.threads(r)),
      this.guard(api.drafts(r)),
      page.name === "thread" ? this.guard(api.thread(r, page.id)) : Promise.resolve(null),
    ]);
    if (this.ended) return;
    this.data = {
      ...this.data,
      status: status ?? this.data.status,
      threads: threads ?? this.data.threads,
      drafts: drafts ?? this.data.drafts,
    };
    if (detail && this.page.name === "thread" && this.page.id === detail.thread.id) this.showDetail(detail);
    this.redraw();
  }

  private showDetail(d: NonNullable<Data["detail"]>): void {
    if (this.fresh?.thread !== d.thread.id) {
      this.fresh = { thread: d.thread.id, ids: new Set(d.comments.filter((c) => c.unread).map((c) => c.id)) };
      this.toNews = this.fresh.ids.size > 0;
    }
    this.data = { ...this.data, detail: d };
    clearTimeout(this.readTimer);
    if (!d.thread.unread) return;
    const id = d.thread.id;
    this.readTimer = setTimeout(async () => {
      if (this.page.name !== "thread" || this.page.id !== id || !this.api) return;
      if (!(await this.guard(this.api.read(this.review, id)))) return;
      this.data = {
        ...this.data,
        threads: this.data.threads.map((t) => (t.id === id ? { ...t, unread: false } : t)),
        detail: this.data.detail?.thread.id === id ? { ...this.data.detail, thread: { ...this.data.detail.thread, unread: false } } : this.data.detail,
      };
      this.reloadSoon();
    }, READ_AFTER_MS);
  }

  // --- pages

  private openThread(id: number | null, from?: "threads" | "drafts"): void {
    if (id === null) return;
    const back = from ?? (this.page.name === "thread" ? this.page.from : this.page.name === "drafts" ? "drafts" : "threads");
    if (this.page.name === "thread" && this.page.id === id) return;
    this.page = { name: "thread", id, from: back };
    this.selected = id;
    this.threadTop = 0;
    this.toNews = false;
    if (this.data.detail?.thread.id !== id) this.data = { ...this.data, detail: null };
    clearTimeout(this.readTimer);
    this.redraw();
    const api = this.api;
    if (!api) return;
    void this.guard(api.thread(this.review, id)).then((d) => {
      if (!d || this.page.name !== "thread" || this.page.id !== id) return;
      this.showDetail(d);
      this.redraw();
    });
  }

  private goBack(): void {
    const p = this.page;
    clearTimeout(this.readTimer);
    if (p.name === "thread" && p.from === "drafts") this.page = { name: "drafts", from: "threads" };
    else if (p.name === "drafts" && p.from === "thread" && this.data.detail) {
      this.page = { name: "thread", id: this.data.detail.thread.id, from: "threads" };
      this.showDetail(this.data.detail);
    } else this.page = { name: "threads" };
    this.redraw();
  }

  private goDrafts(): void {
    if (this.page.name === "drafts") return;
    this.page = { name: "drafts", from: this.page.name === "thread" ? "thread" : "threads" };
    clearTimeout(this.readTimer);
    this.redraw();
  }

  private bodyHeight(): number {
    return Math.max(1, this.size.h - 2 - (this.composer.open ? composerHeight(this.size.h) : 0));
  }

  private listIds(): number[] {
    return ordered(this.data, this.filter, null).map((t) => t.id);
  }

  private moveList(by: number | "first" | "last"): void {
    const ids = this.listIds();
    if (!ids.length) return;
    const at = Math.max(0, ids.indexOf(this.selected ?? -1));
    const to = by === "first" ? 0 : by === "last" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, at + by));
    this.selected = ids[to]!;
    this.redraw();
  }

  private draftIds(): number[] {
    return this.data.drafts.map((c) => c.id);
  }

  private moveDraft(by: number): void {
    const ids = this.draftIds();
    if (!ids.length) return;
    const at = Math.max(0, ids.indexOf(this.draftSel ?? -1));
    this.draftSel = ids[Math.max(0, Math.min(ids.length - 1, at + by))]!;
    this.redraw();
  }

  private selectedDraft(): CommentDto | null {
    return this.data.drafts.find((c) => c.id === this.draftSel) ?? this.data.drafts[0] ?? null;
  }

  private current(): number | null {
    return this.page.name === "thread" ? this.page.id : this.selected;
  }

  private scroll(by: number | "top" | "bottom"): void {
    this.threadTop = by === "top" ? 0 : by === "bottom" ? Number.MAX_SAFE_INTEGER : Math.max(0, this.threadTop + by);
    this.redraw();
  }

  // --- actions

  private run(id: string): void {
    const half = Math.max(1, Math.floor(this.bodyHeight() / 2));
    const cur = this.current();
    const list = () => ordered(this.data, this.filter, cur);
    switch (id) {
      case "quit":
        return this.end({ code: 0 });
      case "back":
        return this.goBack();
      case "list.down":
        return this.moveList(1);
      case "list.up":
        return this.moveList(-1);
      case "list.first":
        return this.moveList("first");
      case "list.last":
        return this.moveList("last");
      case "list.pageDown":
        return this.moveList(half);
      case "list.pageUp":
        return this.moveList(-half);
      case "list.open":
        return this.openThread(this.selected, "threads");
      case "list.nextFile":
      case "list.prevFile":
        this.selected = stepFile(threadGroups(this.data, this.filter, null), this.selected, id === "list.nextFile" ? 1 : -1);
        return this.redraw();
      case "unread.next":
      case "unread.prev": {
        const next = stepUnread(list(), cur, id === "unread.next" ? 1 : -1);
        if (next === null) return this.say("no unread threads");
        return this.openThread(next);
      }
      case "filter.resolved":
        this.filter = { ...this.filter, status: this.filter.status === "open" ? "all" : "open", newOnly: false };
        this.say(this.filter.status === "all" ? "showing all threads" : "showing open threads and drafts");
        return;
      case "filter.news":
        this.filter = { ...this.filter, newOnly: !this.filter.newOnly };
        this.say(this.filter.newOnly ? "showing only threads with news" : "showing every thread again");
        return;
      case "thread.next":
      case "thread.prev": {
        const next = stepThread(list(), cur, id === "thread.next" ? 1 : -1);
        if (next === cur) return this.say(id === "thread.next" ? "the last thread" : "the first thread");
        return this.openThread(next);
      }
      case "thread.nextFile":
      case "thread.prevFile": {
        const next = stepFile(threadGroups(this.data, this.filter, cur), cur, id === "thread.nextFile" ? 1 : -1);
        if (next === cur) return this.say(id === "thread.nextFile" ? "the last file" : "the first file");
        return this.openThread(next);
      }
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
      case "thread.reply":
        if (this.page.name === "thread") this.write({ kind: "reply", thread: this.page.id });
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
        if (c) this.openThread(c.threadId, "drafts");
        return;
      }
      case "drafts.edit": {
        const c = this.selectedDraft();
        if (c) this.write({ kind: "edit", comment: c.id, thread: c.threadId }, c.body);
        return;
      }
      case "drafts.discard":
        return void this.discard();
      case "drafts.summary":
        return this.write({ kind: "summary" });
      case "drafts.approve":
        return void this.approve();
      case "submit":
        if (this.page.name !== "drafts") return this.goDrafts();
        return void (this.data.drafts.length ? this.requestChanges() : this.approve());
      case "drafts":
        return this.goDrafts();
      case "refresh":
        return void this.refreshNow();
      case "help":
        return this.openHelp();
      case "help.down":
      case "help.up":
        if (this.help) this.help.top = Math.max(0, Math.min(this.help.lines.length - 1, this.help.top + (id === "help.down" ? 1 : -1)));
        return this.redraw();
      case "help.close":
        this.help = null;
        return this.redraw();
      case "choice.down":
      case "choice.up":
        if (this.choice) this.choice.at = (this.choice.at + (id === "choice.down" ? 1 : this.choice.options.length - 1)) % this.choice.options.length;
        return this.redraw();
      case "choice.pick":
        return this.pick(this.choice?.at ?? 0);
      case "choice.cancel":
        return this.pick(null);
    }
  }

  private async resolve(): Promise<void> {
    const d = this.data.detail;
    if (!d || !this.api || this.page.name !== "thread" || d.thread.id !== this.page.id) return;
    if (d.thread.draft) return this.say("a draft thread cannot be resolved: discard it on the drafts page (s)", "error");
    if (d.thread.status === "resolved") return this.say(`#${d.thread.id} is resolved already · X reopens it`);
    if (await this.guard(this.api.resolve(this.review, d.thread.id, null))) {
      this.say(`resolved #${d.thread.id} · X reopens it`);
      await this.reload();
    }
  }

  private async reopen(): Promise<void> {
    const d = this.data.detail;
    if (!d || !this.api || this.page.name !== "thread" || d.thread.id !== this.page.id) return;
    if (d.thread.status === "open") return this.say(`#${d.thread.id} is open`);
    if (await this.guard(this.api.reopen(this.review, d.thread.id))) {
      this.say(`reopened #${d.thread.id}`);
      await this.reload();
    }
  }

  private async discard(): Promise<void> {
    const c = this.selectedDraft();
    if (!c || !this.api) return;
    const ids = this.draftIds();
    const r = await this.guard(this.api.discardDraft(this.review, c.id));
    if (!r) return;
    this.draftSel = ids[ids.indexOf(c.id) + 1] ?? ids[ids.indexOf(c.id) - 1] ?? null;
    this.texts.set(`edit:${c.id}`, "");
    this.say(r.threadDeleted ? `discarded the draft thread #${r.thread}` : `discarded the draft reply on #${r.thread}`);
    await this.reload();
  }

  private async refreshNow(): Promise<void> {
    if (!this.api) return;
    const r = await this.guard(this.api.refreshNow(this.review));
    if (!r) return;
    this.say(r.changed ? "now: re-read the working tree" : "now: no changes in the working tree");
    await this.reload();
  }

  private ask(title: string, text: string, options: Choice["options"]): Promise<string | null> {
    return new Promise((done) => {
      this.choice = { title, text, options, at: 0, done };
      this.redraw();
    });
  }

  private pick(at: number | null): void {
    const c = this.choice;
    if (!c) return;
    this.choice = null;
    this.redraw();
    c.done(at === null ? null : (c.options[at]?.value ?? null));
  }

  private summary(): string {
    return this.texts.get("summary");
  }

  private settled(ids: number[]): string {
    return ids.length ? `; ${ids.map((id) => `#${id}`).join(" ")} resolved with your message` : "";
  }

  private async afterSubmit(): Promise<void> {
    this.texts.set("summary", "");
    this.page = { name: "threads" };
    await this.reload();
  }

  private async requestChanges(): Promise<void> {
    if (!this.api) return;
    if (this.data.drafts.length === 0) return this.say("no drafts to submit", "error");
    const r = await this.guard(this.api.submit(this.review, this.summary()));
    if (!r) return;
    this.say(`changes requested: ${plural(r.comments, "comment")} in ${plural(r.threads.length, "thread")} went to the agent${this.settled(r.settled)}`);
    await this.afterSubmit();
  }

  /** As the web approves: drafts go along as nits if you say so, and you pick what happens to the other open threads. */
  private async approve(): Promise<void> {
    if (!this.api) return;
    const mine = this.data.drafts;
    if (mine.length > 0) {
      const how = await this.ask(`Approve with ${plural(mine.length, "draft")}?`, "Approving says this version is done. The drafts can go with it as nits, or as a request for changes and a new round.", [
        { value: "nits", label: "Approve; drafts go as nits (the agent fixes them without a new round)" },
        { value: "changes", label: "Send as Request changes" },
      ]);
      if (how === null) return;
      if (how === "changes") return this.requestChanges();
    }
    const inReview = new Set(mine.map((c) => c.threadId));
    const open = this.data.threads.filter((t) => t.status === "open" && !t.draft && !inReview.has(t.id));
    let keep: "keep" | "resolve" | undefined;
    if (open.length > 0) {
      const list = open.slice(0, 5).map((t) => `#${t.id} ${t.title.split("\n")[0]}`).join("; ");
      const how = await this.ask(`${plural(open.length, "thread")} still open`, `Approve and leave ${open.length === 1 ? "it" : "them"} open, or resolve ${open.length === 1 ? "it" : "them all"} first: ${list}${open.length > 5 ? ` and ${open.length - 5} more` : ""}`, [
        { value: "keep", label: "Approve anyway" },
        { value: "resolve", label: "Resolve all and approve" },
      ]);
      if (how === null) return;
      keep = how as "keep" | "resolve";
    }
    const r = await this.guard(this.api.submit(this.review, this.summary(), { verdict: "approved", open: keep }));
    if (!r) return;
    const nits = r.comments ? `; ${plural(r.comments, "comment")} went to the agent as nits` : "";
    this.say(`approved v${r.version}${nits}${r.resolved.length ? `; resolved ${plural(r.resolved.length, "thread")}` : ""}${this.settled(r.settled)}`);
    await this.afterSubmit();
  }

  // --- composer

  private write(w: Writing, initial = ""): void {
    const key = textKey(w);
    const d = this.data.detail;
    const draftThread = w.kind === "reply" && d?.thread.id === w.thread && d.thread.draft;
    const title =
      w.kind === "reply" ? `reply to #${w.thread} · ^S save draft · ^G send now · esc leave` : w.kind === "edit" ? `edit the draft on #${w.thread} · ^S save · esc leave` : "summary for the whole review · ^S keep · esc leave";
    const placeholder = w.kind === "reply" ? (draftThread ? "Add to this draft thread…" : "Reply to the thread…") : w.kind === "edit" ? "" : "Optional summary for the whole review";
    this.writing = w;
    this.matcher.reset();
    this.composer.show(title, placeholder, this.texts.get(key) || initial, (text) => this.texts.set(key, text));
    if (this.page.name === "thread") this.threadTop = Number.MAX_SAFE_INTEGER;
    this.redraw();
  }

  private leave(): void {
    this.composer.hide();
    this.writing = null;
    this.redraw();
  }

  private async send(mode: "draft" | "now"): Promise<void> {
    const w = this.writing;
    const api = this.api;
    if (!w || !api) return;
    const text = this.composer.text;
    const key = textKey(w);
    if (w.kind === "summary") {
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
      return this.reload();
    }
    const r = await this.guard(api.reply(this.review, w.thread, { body: text, draft: mode === "draft" }));
    if (!r) return;
    this.texts.set(key, "");
    this.leave();
    this.say(mode === "draft" ? "draft reply saved · the agent sees it after you submit the review (S)" : "reply sent to the agent");
    await this.reload();
    this.scroll("bottom");
  }

  // --- keys

  private scopes(): Scope[] {
    if (this.help) return ["help"];
    if (this.choice) return ["choice"];
    return [this.page.name, "global"];
  }

  private key(k: KeyEvent): void {
    // Ctrl+C is OpenTUI's: it destroys the renderer, and the app ends on that.
    if (k.ctrl && k.name === "c") return;
    const token = this.keys.token(k);
    if (token === null) return;
    if (this.composer.open) return this.composerKey(k, token);
    k.preventDefault();
    if (this.choice && /^[1-9]$/.test(token)) {
      const at = Number(token) - 1;
      if (at < this.choice.options.length) this.pick(at);
      return;
    }
    const m = this.matcher.feed(token, this.scopes());
    if ("fire" in m) this.run(m.fire.id);
    else this.redraw();
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
    else void this.send(row.id === "composer.now" ? "now" : "draft");
  }

  private openHelp(): void {
    const scope = this.page.name;
    const lines: Line[] = [];
    const seen = new Set<string>();
    for (const sc of [scope, "global"] as const) {
      const rows = KEYS.filter((r) => r.scope === sc);
      if (!rows.length) continue;
      if (lines.length) lines.push(line());
      lines.push(line(s(sc === "global" ? "Everywhere" : `This page`, { bold: true })));
      const byDesc = new Map<string, string[]>();
      for (const r of rows) {
        const labels = r.keys.filter((x) => !seen.has(`${sc}:${x}`)).map(keyLabel);
        r.keys.forEach((x) => seen.add(`${sc}:${x}`));
        byDesc.set(r.desc, [...(byDesc.get(r.desc) ?? []), ...labels]);
      }
      for (const [desc, labels] of byDesc) lines.push(line(s(`  ${labels.join(" ").padEnd(14)}`, { bold: true }), s(` ${desc}`)));
    }
    lines.push(line(), line(s("  Ctrl+C quits from anywhere", { tone: "muted" })));
    this.help = { top: 0, lines };
    this.redraw();
  }

  // --- frame

  private frame(w: number, h: number): Frame {
    this.size = { w, h };
    const bodyH = this.bodyHeight();
    const header = headerLine(this.data, w, this.connecting);
    const body = this.body(w, bodyH);
    const footer = footerLine(w, { toast: this.toast, prefix: this.prefix(), next: this.matcher.prefix.length ? this.matcher.next(this.scopes()) : [], hints: this.hints() });
    return { header, body, footer, overlay: this.overlay(w, h) };
  }

  private prefix(): string | null {
    const p = this.matcher.prefix;
    return p.length ? keyLabel(p.join("")) : null;
  }

  private hints(): string[] {
    if (this.composer.open) {
      const w = this.writing;
      return w?.kind === "reply" ? ["^S save draft", "^G send now", "esc leave (text kept)"] : w?.kind === "edit" ? ["^S save", "esc leave (text kept)"] : ["^S keep", "esc leave"];
    }
    const out: string[] = [];
    for (const sc of this.scopes()) for (const r of KEYS) if (r.scope === sc && r.hint) out.push(r.hint);
    return out;
  }

  private window(lines: Line[], top: number, height: number): { top: number; lines: Line[] } {
    const max = Math.max(0, lines.length - height);
    const t = Math.max(0, Math.min(max, top));
    return { top: t, lines: lines.slice(t, t + height) };
  }

  /** The list's window: the selected line stays in sight with a line of margin. */
  private follow(ids: (number | null)[], selected: number | null, top: number, height: number): number {
    const at = ids.indexOf(selected);
    if (at === -1) return top;
    if (at - 1 < top) return Math.max(0, at - 2);
    if (at + 1 >= top + height) return at + 2 - height;
    return top;
  }

  private body(w: number, height: number): Line[] {
    if (this.connecting && !this.data.status) return [line(), line(s(`  ${this.connecting}`, { tone: "muted" }))];
    if (!this.data.status) return [line(), line(s("  loading…", { tone: "muted" }))];
    const p = this.page;
    if (p.name === "threads") {
      const ids = this.listIds();
      if (this.selected === null || !ids.includes(this.selected)) this.selected = ids[0] ?? null;
      const page = threadsPage(this.data, this.filter, this.selected, w);
      this.listTop = this.follow(page.ids, this.selected, this.listTop, height);
      const v = this.window(page.lines, this.listTop, height);
      this.listTop = v.top;
      return v.lines;
    }
    if (p.name === "drafts") {
      const ids = this.draftIds();
      if (this.draftSel === null || !ids.includes(this.draftSel)) this.draftSel = ids[0] ?? null;
      const page = draftsPage(this.data, this.draftSel, this.summary(), w);
      this.draftsTop = this.follow(page.ids, this.draftSel, this.draftsTop, height);
      const v = this.window(page.lines, this.draftsTop, height);
      this.draftsTop = v.top;
      return v.lines;
    }
    const d = this.data.detail;
    if (!d || d.thread.id !== p.id) return [line(), line(s(`  loading thread #${p.id}…`, { tone: "muted" }))];
    const page = threadPage(d, this.fresh?.thread === d.thread.id ? this.fresh.ids : new Set(), w);
    if (this.toNews && page.newAt !== null) this.threadTop = Math.max(0, page.newAt - 1);
    this.toNews = false;
    const v = this.window(page.lines, this.threadTop, height);
    this.threadTop = v.top;
    return v.lines;
  }

  private overlay(w: number, h: number): Overlay | null {
    if (this.help) {
      const rows = Math.max(1, h - 4);
      this.help.top = Math.max(0, Math.min(this.help.top, this.help.lines.length - rows));
      return { title: `keys · ${this.page.name === "threads" ? "threads" : this.page.name === "thread" ? "thread" : "drafts"}`, lines: this.help.lines, top: this.help.top };
    }
    const c = this.choice;
    if (!c) return null;
    const inner = Math.min(w - 8, 72);
    const lines: Line[] = wrap(c.text, inner).map((x) => line(s(x, { tone: "muted" })));
    lines.push(line());
    c.options.forEach((o, i) => lines.push({ spans: [s(` ${i + 1} `, { bold: true }), s(o.label)], selected: i === c.at }));
    return { title: c.title, lines, top: 0 };
  }
}

/** The terminal UI on a review, until q on the threads page, Ctrl+C or a signal; the terminal is restored on every way out. */
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
