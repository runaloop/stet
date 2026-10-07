import { batch, computed, effect, signal } from "@preact/signals";
import type { CommentDto, GitStateDto, NowStateDto, ReviewDto, ReviewedDto, ThreadDetail, ThreadSummary } from "../src/core/types.ts";
import { api, ApiError, getToken, setToken, subscribe, type ReviewStatus } from "./api.ts";
import { applyFilters, DEFAULT_FILTERS, type Filters } from "./lib/filters.ts";
import { DEFAULT_TEST_GLOBS, isTestPath, parseList } from "./lib/fold.ts";
import { FileOrder, parseOrder } from "./lib/order.ts";
import { parseHash, plainClick, routeHash as formatHash, type Route } from "./lib/route.ts";
import type { DiffBase } from "./lib/timeline.ts";
import { rounds } from "./lib/versions.ts";
import { flatten, groupByFile } from "./lib/tree.ts";

export type { Route };
export { parseHash };

export const route = signal<Route>({ name: "home" });
export const reviews = signal<ReviewDto[]>([]);
export const reviewId = signal<number | null>(null);
export const status = signal<ReviewStatus | null>(null);
export const threads = signal<ThreadSummary[]>([]);
export const detail = signal<ThreadDetail | null>(null);
export const drafts = signal<CommentDto[]>([]);
export const reviewedCursor = signal<ReviewedDto | null>(null);
export const viewedKeys = signal<Set<string>>(new Set());
export const filters = signal<Filters>(loadFilters());
export const selectedStep = signal<number | null>(null);
export const codeMode = signal<"diff" | "then" | "now">("diff");
export const diffBase = signal<DiffBase>("then");
export const diffStyle = signal<"split" | "unified">(loadPref("diffStyle", "split") as "split" | "unified");
export const wrap = signal(loadPref("wrap", "1") === "1");
export const showResolved = signal(loadPref("showResolved", "0") === "1");
export const lastCompare = signal<{ from: string; to: string } | null>(null);
export const compareFocus = signal<number | null>(null);
export const banner = signal<{ text: string; version: number } | null>(null);
export const toast = signal<{ text: string; tone: "info" | "error"; link?: { label: string; route: Route } } | null>(null);
export const helpOpen = signal(false);
export const composerFocus = signal(0);
export const replyQuote = signal<{ seq: number; text: string } | null>(null);
export const loading = signal(true);
/** The review whose threads and drafts have arrived; set once each time a review is shown. */
export const loadedReview = signal<number | null>(null);
export const fatal = signal<string | null>(null);
/** False while the server does not answer. */
export const online = signal(true);
export const nowState = signal<NowStateDto | null>(null);
export const gitInfo = signal<GitStateDto | null>(null);
export const gitFiles = computed(() => new Map((gitInfo.value?.files ?? []).map((f) => [f.path, f])));

export const currentThreadId = computed(() => (route.value.name === "thread" ? route.value.id : null));
export const visibleThreads = computed(() => {
  const list = applyFilters(threads.value, filters.value);
  const cur = currentThreadId.value;
  if (cur === null || list.some((t) => t.id === cur)) return list;
  const here = threads.value.find((t) => t.id === cur);
  return here ? [...list, here] : list;
});
export const testGlobs = computed(() => parseList(status.value?.ui?.tests, DEFAULT_TEST_GLOBS));
export const fileOrder = computed(() => new FileOrder(parseOrder(status.value?.ui?.order)));
export const groups = computed(() => {
  const order = fileOrder.value;
  const tests = testGlobs.value;
  return groupByFile(visibleThreads.value, (p) => order.rank(p, isTestPath(p, tests)));
});
export const ordered = computed(() => flatten(groups.value));
export const versions = computed(() => status.value?.versionsList ?? []);
export const versionRounds = computed(() => rounds(versions.value, status.value?.submissions ?? []));
export const multiReview = computed(() => reviews.value.length > 1);

function loadPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(`stet.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`stet.${key}`, value);
  } catch {
    return;
  }
}

function loadFilters(): Filters {
  try {
    const raw = sessionStorage.getItem("stet.filters");
    return raw ? { ...DEFAULT_FILTERS, ...JSON.parse(raw) } : DEFAULT_FILTERS;
  } catch {
    return DEFAULT_FILTERS;
  }
}

effect(() => {
  try {
    sessionStorage.setItem("stet.filters", JSON.stringify(filters.value));
  } catch {
    return;
  }
});
effect(() => savePref("diffStyle", diffStyle.value));
effect(() => savePref("wrap", wrap.value ? "1" : "0"));
effect(() => savePref("showResolved", showResolved.value ? "1" : "0"));
effect(() => {
  const r = route.value;
  if (r.name === "compare") lastCompare.value = { from: r.from, to: r.to };
});

export function routeHash(r: Route): string {
  return formatHash(r, multiReview.value ? reviewId.value : null);
}

export const jumpHooks: (() => void)[] = [];

export function noteJump(): void {
  for (const f of jumpHooks) f();
}

let navigating: string | null = null;

export function navigate(r: Route): void {
  const hash = routeHash(r);
  noteJump();
  if (location.hash !== hash) {
    navigating = hash;
    location.hash = hash;
  } else route.value = r;
}

export function expectNavigation(hash: string): void {
  navigating = hash;
}

export function ownNavigation(hash: string): boolean {
  const mine = navigating === hash;
  navigating = null;
  return mine;
}

export function link(r: Route, onPlain?: () => void): { href: string; onClick: (e: MouseEvent) => void } {
  return {
    href: routeHash(r),
    onClick: (e: MouseEvent) => {
      if (!plainClick(e)) return;
      e.preventDefault();
      if (onPlain) onPlain();
      else navigate(r);
    },
  };
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, tone: "info" | "error" = "info", link?: { label: string; route: Route }): void {
  toast.value = { text, tone, link };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), tone === "error" || link ? 8000 : 5000);
}

export async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    // The header says the server is away; a toast per failed call would only repeat it.
    if (online.value) notify((e as Error).message, "error");
    return undefined;
  }
}

export async function loadStatus(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const s = await guard(api.review(id));
  if (s) status.value = s;
}

export async function loadThreads(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const list = await guard(api.threads(id));
  if (list) threads.value = list;
}

export async function loadDetail(): Promise<void> {
  const id = reviewId.value;
  const r = route.value;
  if (id === null || r.name !== "thread") {
    detail.value = null;
    return;
  }
  const d = await guard(api.thread(id, r.id));
  if (d && route.value.name === "thread" && route.value.id === r.id) {
    const changedThread = detail.value?.thread.id !== d.thread.id;
    batch(() => {
      detail.value = d;
      if (changedThread) {
        selectedStep.value = null;
        codeMode.value = "diff";
      }
    });
  }
}

export async function loadDrafts(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const list = await guard(api.drafts(id));
  if (list) drafts.value = list;
}

export async function loadCursors(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const c = await guard(api.cursors(id));
  if (!c) return;
  batch(() => {
    reviewedCursor.value = c.reviewed;
    viewedKeys.value = new Set(c.viewed);
  });
}

export async function loadGit(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const g = await api.git(id).catch(() => null);
  if (g && reviewId.value === id) gitInfo.value = g;
}

export async function reloadAll(): Promise<void> {
  await Promise.all([loadStatus(), loadThreads(), loadDetail(), loadDrafts(), loadCursors(), loadGit()]);
}

/** The worktree moved away from the "now" this page shows: files that differ, or 0 when only the pin moved. */
export const nowMoved = computed(() => {
  const n = nowState.value;
  const shown = status.value?.pinnedNow;
  return n && shown && n.sha !== shown ? (n.pinned === shown ? (n.files ?? 0) : 0) : null;
});

export async function refreshNow(): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const r = await guard(api.refreshNow(id));
  if (!r) return;
  banner.value = null;
  notify(r.changed ? "now: re-read the working tree" : "now: no changes in the working tree");
  await reloadAll();
}

export async function markReviewed(ref: string, quiet = false): Promise<void> {
  const id = reviewId.value;
  if (id === null) return;
  const r = await guard(api.markReviewed(id, ref));
  if (!r) return;
  reviewedCursor.value = r;
  if (!quiet) notify(`remembered: you went through the code up to ${r.label}. “Since I last looked” starts there next time`);
}

let unsubscribe: (() => void) | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

export function startLive(): void {
  unsubscribe?.();
  const id = reviewId.value;
  if (id === null) return;
  const reload = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadAll(), 150);
  };
  unsubscribe = subscribe(id, status.value?.lastSeq ?? 0, {
    change(_seq, events) {
      const created = events.find((e) => e.type === "version.created" && e.role === "agent");
      if (created) {
        const n = (status.value?.versions ?? 0) + 1;
        banner.value = { text: `The agent handed over v${n}. Click here (or Space r v) to see what changed since you last looked.`, version: n };
      }
      reload();
    },
    now: (n) => (nowState.value = n),
    git: (g) => (gitInfo.value = g),
    connection(up) {
      online.value = up;
      if (up) reload();
    },
  });
}

export async function selectReview(id: number): Promise<void> {
  reviewId.value = id;
  try {
    sessionStorage.setItem("stet.review", String(id));
  } catch {
    return;
  }
}

export async function switchReview(id: number): Promise<void> {
  if (reviewId.value === id || !reviews.value.some((r) => r.id === id)) return;
  await selectReview(id);
  batch(() => {
    detail.value = null;
    threads.value = [];
    drafts.value = [];
    nowState.value = null;
    gitInfo.value = null;
  });
  await reloadAll();
  if (reviewId.value === id) loadedReview.value = id;
  startLive();
}

async function authorize(): Promise<{ reviews: ReviewDto[]; default: number | null } | null> {
  type Reviews = { reviews: ReviewDto[]; default: number | null };
  const first: Reviews | Error | null = getToken() ? await api.reviews().catch((e: Error) => e) : null;
  if (first && !(first instanceof Error)) return first;
  if (first && !(first instanceof ApiError && first.status === 401)) return null;
  const s = await api.session().catch(() => null);
  if (!s) return null;
  setToken(s.token);
  return api.reviews().catch(() => null);
}

export async function boot(): Promise<void> {
  const r = await authorize();
  if (!r) {
    fatal.value = getToken()
      ? "Cannot reach the stet server. Is `stet serve` still running, and did you open the URL it printed?"
      : "Open the URL that `stet serve` printed (it carries the access token). Later tabs of this browser work without it.";
    loading.value = false;
    return;
  }
  void api.startSession().catch(() => null);
  reviews.value = r.reviews;
  let saved: number | null = null;
  try {
    saved = Number(sessionStorage.getItem("stet.review")) || null;
  } catch {
    saved = null;
  }
  const wanted = route.value.review ?? saved;
  const pick = r.reviews.find((x) => x.id === wanted)?.id ?? r.default ?? r.reviews[0]?.id ?? null;
  if (pick === null) {
    fatal.value = "No active review in this repository yet. Run `stet init` on the branch, or let the agent run `stet version create`.";
    loading.value = false;
    return;
  }
  await selectReview(pick);
  await reloadAll();
  batch(() => {
    loadedReview.value = pick;
    loading.value = false;
  });
  startLive();
}

export function setFilters(patch: Partial<Filters>): void {
  filters.value = { ...filters.value, ...patch };
}

export function refOptions(): { value: string; label: string }[] {
  return [
    { value: "base", label: "base" },
    ...versions.value.map((v) => ({ value: String(v.number), label: `v${v.number}${v.label ? ` · ${v.label}` : ""}` })),
    { value: "now", label: status.value?.now?.changedSinceLatest === false ? "now (= latest)" : "now" },
  ];
}

export const nowDirty = computed(() => versions.value.length === 0 || !!status.value?.now?.changedSinceLatest);

export function tipRef(): string {
  const n = versions.value.length;
  return nowDirty.value || n === 0 ? "now" : String(n);
}

export function reviewedRef(): string | null {
  const rv = reviewedCursor.value;
  if (!rv) return null;
  const n = versions.value.length;
  if (rv.version !== null) {
    if (rv.version > n || (rv.version === n && !nowDirty.value)) return null;
    return String(rv.version);
  }
  if (rv.sha === status.value?.now?.sha) return null;
  return rv.sha;
}

export interface Preset {
  id: "since" | "after" | "round" | "branch";
  label: string;
  from: string;
  to: string;
}

export function presets(): Preset[] {
  const n = versions.value.length;
  const tip = tipRef();
  const out: Preset[] = [];
  const seen = new Set<string>();
  const add = (p: Preset) => {
    const key = `${p.from}..${p.to}`;
    if (p.from === p.to || seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  const rv = reviewedRef();
  if (rv) add({ id: "since", label: "since I last looked", from: rv, to: tip });
  if (n >= 1 && nowDirty.value) add({ id: "after", label: `after v${n} (no version yet)`, from: String(n), to: "now" });
  if (n >= 1) add({ id: "round", label: `what changed in v${n}`, from: n >= 2 ? String(n - 1) : "base", to: String(n) });
  add({ id: "branch", label: "whole branch", from: "base", to: tip });
  return out;
}

export function defaultCompare(): { from: string; to: string } {
  const p = presets();
  const pick = p.find((x) => x.id === "since") ?? p.find((x) => x.id === "after") ?? p.find((x) => x.id === "round") ?? p[0];
  return pick ? { from: pick.from, to: pick.to } : { from: "base", to: "now" };
}

export function shiftRef(ref: string, dir: 1 | -1): string {
  const opts = refOptions().map((o) => o.value);
  const i = opts.indexOf(ref);
  const j = Math.max(0, Math.min(opts.length - 1, (i === -1 ? opts.length - 1 : i) + dir));
  return opts[j]!;
}

effect(() => {
  if (route.value.name !== "home" || !status.value || loading.value) return;
  const target: Route = { name: "compare", ...defaultCompare() };
  history.replaceState(null, "", location.pathname + location.search + routeHash(target));
  route.value = target;
});
