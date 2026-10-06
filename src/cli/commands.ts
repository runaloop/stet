import pkg from "../../package.json" with { type: "json" };
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  StetError,
  conflict,
  ensureReview,
  initReview,
  openContext,
  requireLastReview,
  requireReview,
  reviewById,
  usage,
  type Ctx,
} from "../core/context.ts";
import { unifiedPatch } from "../core/diff.ts";
import { configKey, configValue } from "../core/config.ts";
import { guideMarkdown, parseGuide, requireGuide } from "../core/guide.ts";
import * as svc from "../core/service.ts";
import type { Intent, ResolveReason, Role } from "../core/store/db.ts";
import type { SubmittedDto } from "../core/types.ts";
import { bool, duration, int, list, parse, range, readBody, region, str, type Options, type Parsed } from "./args.ts";
import { formatBlame, formatCompare, formatStatus, formatThreadDetail, formatThreadList, formatVersions, regionText } from "./format.ts";

export const HELP = `stet — thread-first local code review between a human reviewer and a coding agent

Usage: stet <command> [options]    (JSON output when piped or with --json)

Review
  init [--staged] [--base <ref>|empty] [--worktree <path>]
                                                start a review for the current branch; --staged reviews
                                                the index against HEAD instead of the whole working tree;
                                                --base empty: every file is new, e.g. for the first commit
  status                                        versions, thread counts, the last review's verdict, UI url
  review submit [--body <text>] [--guide]       publish all your drafts as one review: request changes;
                                                --guide asks the agent for a guide to the next version
  review submit --approve [--body <text>] [--force|--resolve-all]
                                                approve the latest version; drafts go along as nits the
                                                agent fixes without a new round. With other threads open
                                                it refuses unless --force (they stay open) or
                                                --resolve-all (they are resolved first)
  review close | review move --to <branch>

Versions
  version create [--label <text>] [--allow-empty] [--at <commit>] [--guide <file>]
                                                a version of the working tree (or the index), or of a commit;
                                                --guide (experimental): a Markdown file that explains the
                                                change in numbered steps, each ending in its lines, one per
                                                line: path (the file's whole change) or path:a-b. The version
                                                is refused when a path or range is not in it
  versions list
  guide [<N>|latest]                            print a version's guide (default: the latest version's)
  versions diff <a> <b> [--patch]               refs: base, 1..N, latest, now, empty, <sha>
  blame <path>[:<a>[-<b>]] [--at N|latest|now]  where each line came from: the version that brought it (or
                                                base, or now), the round it answered and the threads that
                                                version answered: anchored on the line, else a reply that
                                                names the file (named), else a fix in the same file (same
                                                file); at the latest version by default

Threads
  threads list [--status open|resolved|all] [--state ok,moved,changed,outdated]
               [--needs-reply] [--unread] [--new-since <N>] [--file <glob>] [--drafts] [--against <ref>]
  thread show <id>                              comments, timeline, code then / now; a comment with
                                                \`restore\` asks to put back old lines exactly as they were
  comment add --file <path> --range <a-b> --body <text|-> [--at <ref>] [--side new|old] [--draft]
              --region <x,y,w,h> in place of --range: an area of an image, in pixels
  reply <id> --body <text|-> [--intent fixed|answered|disagree|question] [--to <commentId>] [--draft]
  resolve <id> [--reason fixed|wontfix|answered] | reopen <id>
  drafts list | drafts discard <commentId> | drafts edit <commentId> --body <text>
  read <id> | read --all                        mark threads as read

Agent loop
  wait --for review|reply|version|any [--timeout 30m] [--since <seq>]
  events [--since <seq>]

Tools
  serve [--port <n>] [--open] [--print-url]     local web UI; --open (or --detach) starts it on its own and
        [--detach] [--foreground] [--stop]      returns, so it outlives the shell; --stop stops it
  open <id> [--print]                           jump to the editor at the thread
  config get <key> | config set <key> <value> | config set <key> --unset
                                                keys: snapshot.exclude, snapshot.max_untracked_bytes,
                                                compare.tests, compare.skip_markers, compare.collapse,
                                                compare.order, compare.markdown (rendered or code: how
                                                Markdown files open on the Changes page; default rendered),
                                                agent.guide (on: the agent adds a guide to the first version
                                                and to rounds that changed more than the threads asked; off:
                                                only when a review asks with --guide; default on; also the
                                                Drafts page's "Guides in this repository" switch)
  prune [--dry-run]
  export [--all] [--out <file> [--force]] [--review <id>]
                                                the review as Markdown, also when piped (--json: the data):
                                                its decisions, one line per thread, for a merge request;
                                                --all: everything, for an archive or another agent.
                                                Without an active review, the branch's last closed one
  skill install [--for agents|claude|all] [--dir <path>]
                                                the agent's skill: ~/.agents/skills (Codex, Gemini CLI, Cursor,
                                                OpenCode, Copilot) and ~/.claude/skills when Claude Code is there
  skill show                                    print it, e.g. for an AGENTS.md

Global: -C/--repo <path>  -b/--branch <name>  --as reviewer|agent (default: $STET_ROLE or agent)
        --author <name> (default: $STET_AUTHOR)  --json
        --body-file <path> in place of --body wherever a body is taken

Environment
  STET_ROLE, STET_AUTHOR                          defaults for --as and --author
  STET_BRANCH                                    the review's branch when HEAD is detached (or instead of -b)
  STET_EDITOR                                    editor command for \`open\` and the UI's Editor button,
                                                e.g. "zed {file}:{line}"; {root} and {path} work too
  STET_WATCH_MS                                  how often \`serve\` checks the working tree (default 3000)
`;

async function context(p: Parsed, defaultRole?: Role): Promise<Ctx> {
  const as = str(p, "as");
  if (as && as !== "reviewer" && as !== "agent") throw usage("--as must be reviewer or agent");
  return openContext({
    cwd: str(p, "repo") ?? process.cwd(),
    role: (as as Role | undefined) ?? (process.env.STET_ROLE ? undefined : defaultRole),
    author: str(p, "author"),
  });
}

async function readGuide(file: string): Promise<string> {
  if (file === "-") return Bun.stdin.text();
  const f = Bun.file(file);
  if (!(await f.exists())) throw usage(`--guide: no file ${file}`);
  return f.text();
}

let pending: Promise<unknown> = Promise.resolve();

function out(text: string, stream: typeof Bun.stdout = Bun.stdout): void {
  pending = pending.then(() => Bun.write(stream, text.endsWith("\n") ? text : text + "\n"));
}

export function flushOutput(): Promise<unknown> {
  return pending;
}

function emit(p: Parsed, data: unknown, text?: () => string): void {
  if (bool(p, "json") || !process.stdout.isTTY || !text) out(JSON.stringify(data, null, 2));
  else out(text());
}

const INTENTS = ["fixed", "answered", "disagree", "question"];
const REASONS = ["fixed", "wontfix", "answered"];

const commands: Record<string, { options: Options; run: (p: Parsed) => Promise<number | void> }> = {
  init: {
    options: { base: { type: "string" }, worktree: { type: "string" }, staged: { type: "boolean" } },
    async run(p) {
      const ctx = await context(p);
      const r = await initReview(ctx, { branch: str(p, "branch"), base: str(p, "base"), worktree: str(p, "worktree"), staged: bool(p, "staged") });
      if (!r.created && bool(p, "staged") && r.review.source !== "index") {
        throw usage(`review ${r.review.id} for ${r.review.branch} already reviews the working tree: run \`stet review close\` first`);
      }
      emit(p, { review: svc.reviewDto(r.review), created: r.created }, () =>
        `${r.created ? "started" : "already active:"} review ${r.review.id} for ${r.review.branch} of ${r.review.source === "index" ? "staged changes" : "the working tree"} (base ${r.review.base_ref ?? "none"})`);
    },
  },

  status: {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const s = await svc.status(ctx, review);
      const { readServerInfo, reviewUrl } = await import("../server/info.ts");
      const server = await readServerInfo(ctx.repo.commonDir);
      const url = server ? reviewUrl(server, review.id) : undefined;
      emit(p, { ...s, server: url ? { url } : null }, () => formatStatus(s, url));
    },
  },

  "version create": {
    options: { label: { type: "string" }, "allow-empty": { type: "boolean" }, at: { type: "string" }, guide: { type: "string" } },
    async run(p) {
      const file = str(p, "guide");
      const guide = file ? parseGuide(await readGuide(file)) : undefined;
      const ctx = await context(p);
      const review = await ensureReview(ctx, str(p, "branch"));
      const v = await svc.createVersion(ctx, review, { label: str(p, "label"), allowEmpty: bool(p, "allow-empty"), at: str(p, "at"), guide });
      const warning = v.guideRequested && !guide ? "the reviewer asked for a guide to this version and it has none: explain the change step by step in your report" : null;
      emit(p, { version: v, ...(warning ? { warning } : {}) }, () =>
        `created v${v.number} (${v.snapshot.slice(0, 10)})${guide ? ` with a guide of ${guide.steps.length} step${guide.steps.length === 1 ? "" : "s"}` : ""}${warning ? `\nwarning: ${warning}` : ""}`);
    },
  },

  guide: {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const at = await svc.resolveRef(ctx, review, p.positionals[0] ?? "latest");
      if (!at.version) throw usage(`a guide belongs to a version, not to '${p.positionals[0]}'`);
      const g = requireGuide(ctx, review.id, at.version.number);
      emit(p, g, () => guideMarkdown(g));
    },
  },

  "versions list": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const vs = svc.versionRows(ctx, review.id).map(svc.versionDto);
      emit(p, vs, () => formatVersions(vs));
    },
  },

  "versions diff": {
    options: { patch: { type: "boolean" } },
    async run(p) {
      const [a, b] = p.positionals;
      if (!a || !b) throw usage("usage: stet versions diff <a> <b>");
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const d = await svc.compare(ctx, review, a, b);
      if (bool(p, "patch")) {
        const patch = await unifiedPatch(ctx.repo.cwd, d.from.sha, d.to.sha, []);
        if (!bool(p, "json") && process.stdout.isTTY) {
          out(patch);
          return;
        }
        emit(p, { ...d, patch });
        return;
      }
      emit(p, d, () => formatCompare(d));
    },
  },

  blame: {
    options: { at: { type: "string" } },
    async run(p) {
      const arg = p.positionals[0];
      if (!arg) throw usage("usage: stet blame <path>[:<a>[-<b>]] [--at N|latest|now]");
      const m = /^(.*):(\d+(?:-\d+)?)$/.exec(arg);
      const lines = m ? range(m[2]) : null;
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const { blame } = await import("../core/blame.ts");
      const d = await blame(ctx, review, { path: await svc.normalizePath(ctx, m ? m[1]! : arg), start: lines?.start, end: lines?.end, at: str(p, "at") });
      emit(p, d, () => formatBlame(d));
    },
  },

  "threads list": {
    options: {
      status: { type: "string" },
      state: { type: "string", multiple: true },
      "needs-reply": { type: "boolean" },
      unread: { type: "boolean" },
      "new-since": { type: "string" },
      file: { type: "string" },
      drafts: { type: "boolean" },
      against: { type: "string" },
    },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const status = str(p, "status") ?? "open";
      if (!["open", "resolved", "all"].includes(status)) throw usage("--status must be open, resolved or all");
      const ns = str(p, "new-since");
      const threads = await svc.listThreads(
        ctx,
        review,
        {
          status: status as "open" | "resolved" | "all",
          state: list(p, "state"),
          needsReply: bool(p, "needs-reply"),
          unread: bool(p, "unread"),
          newSince: ns ? int(ns.replace(/^v/, ""), "--new-since") : undefined,
          file: str(p, "file"),
          drafts: bool(p, "drafts"),
        },
        { against: str(p, "against") },
      );
      emit(p, threads, () => formatThreadList(threads));
    },
  },

  "thread show": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const d = await svc.threadDetail(ctx, review, int(p.positionals[0], "thread id"));
      const image = d.thread.region ? await svc.imageFiles(ctx, review, d.thread.id) : null;
      if (image) d.image = image;
      emit(p, d, () => formatThreadDetail(d));
    },
  },

  "comment add": {
    options: {
      file: { type: "string", short: "f" },
      range: { type: "string", short: "r" },
      region: { type: "string" },
      body: { type: "string", short: "m" },
      "body-file": { type: "string" },
      at: { type: "string" },
      side: { type: "string" },
      draft: { type: "boolean" },
    },
    async run(p) {
      const ctx = await context(p);
      const review = await ensureReview(ctx, str(p, "branch"));
      const file = str(p, "file");
      if (!file) throw usage("missing --file <path>");
      const area = str(p, "region");
      const r = area ? { start: 1, end: 1 } : range(str(p, "range"));
      const side = str(p, "side") ?? "new";
      if (side !== "new" && side !== "old") throw usage("--side must be new or old");
      const t = await svc.addThread(ctx, review, {
        path: await svc.normalizePath(ctx, file),
        start: r.start,
        end: r.end,
        side,
        at: str(p, "at"),
        body: await readBody(p),
        draft: bool(p, "draft"),
        region: area ? region(area) : null,
      });
      emit(p, t, () => `created thread #${t.id}${t.draft ? " (draft)" : ""} on ${t.path}${t.region ? ` area ${regionText(t.region)}` : `:${t.range.start}-${t.range.end}`}`);
    },
  },

  reply: {
    options: {
      body: { type: "string", short: "m" },
      "body-file": { type: "string" },
      intent: { type: "string" },
      to: { type: "string" },
      draft: { type: "boolean" },
      at: { type: "string" },
    },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const intent = str(p, "intent");
      if (intent && !INTENTS.includes(intent)) throw usage(`--intent must be one of ${INTENTS.join(", ")}`);
      const to = str(p, "to");
      const cm = await svc.addReply(ctx, review, int(p.positionals[0], "thread id"), {
        body: await readBody(p),
        intent: (intent as Intent | undefined) ?? null,
        parentId: to ? int(to, "--to") : null,
        draft: bool(p, "draft"),
        at: str(p, "at"),
      });
      emit(p, cm, () => `replied #${cm.id} in thread #${cm.threadId}${cm.draft ? " (draft)" : ""}`);
    },
  },

  resolve: {
    options: { reason: { type: "string" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const reason = str(p, "reason");
      if (reason && !REASONS.includes(reason)) throw usage(`--reason must be one of ${REASONS.join(", ")}`);
      const ids = p.positionals.map((x) => int(x, "thread id"));
      if (ids.length === 0) throw usage("usage: stet resolve <id> [<id>...]");
      for (const id of ids) svc.resolveThread(ctx, review, id, (reason as ResolveReason | undefined) ?? null);
      emit(p, { resolved: ids }, () => `resolved ${ids.map((i) => "#" + i).join(" ")}`);
    },
  },

  reopen: {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const ids = p.positionals.map((x) => int(x, "thread id"));
      for (const id of ids) svc.reopenThread(ctx, review, id);
      emit(p, { reopened: ids }, () => `reopened ${ids.map((i) => "#" + i).join(" ")}`);
    },
  },

  "review submit": {
    options: { body: { type: "string", short: "m" }, approve: { type: "boolean" }, force: { type: "boolean" }, "resolve-all": { type: "boolean" }, guide: { type: "boolean" } },
    async run(p) {
      const approve = bool(p, "approve");
      if (!approve && (bool(p, "force") || bool(p, "resolve-all"))) throw usage("--force and --resolve-all go with --approve");
      if (approve && bool(p, "guide")) throw usage("--guide asks for a guide to the next version: it goes with a request for changes, not with --approve");
      if (bool(p, "force") && bool(p, "resolve-all")) throw usage("--force or --resolve-all, not both");
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      let r: SubmittedDto;
      try {
        r = svc.submitReview(ctx, review, {
          body: str(p, "body"),
          verdict: approve ? "approved" : "changes",
          open: bool(p, "force") ? "keep" : bool(p, "resolve-all") ? "resolve" : undefined,
          guide: bool(p, "guide"),
        });
      } catch (e) {
        if (e instanceof StetError && e.code === "open_threads") {
          throw conflict(`${e.message}. Resolve the open threads first, or add --resolve-all to resolve them and approve, or --force to approve and leave them open`);
        }
        throw e;
      }
      const sent = `${r.comments} comment${r.comments === 1 ? "" : "s"} in ${r.threads.length} thread${r.threads.length === 1 ? "" : "s"}`;
      emit(p, r, () =>
        r.verdict === "approved"
          ? `approved v${r.version}${r.comments ? `; ${sent} went to the agent as nits` : ""}${r.resolved.length ? `; resolved ${r.resolved.map((i) => "#" + i).join(" ")}` : ""}`
          : `submitted review ${r.submission}: ${sent}${r.guide ? "; asked for a guide to the next version" : ""}`);
    },
  },

  "review close": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const { closeReview } = await import("../core/maintenance.ts");
      closeReview(ctx, review);
      emit(p, { closed: review.id }, () => `closed review ${review.id} (${review.branch})`);
    },
  },

  "review move": {
    options: { to: { type: "string" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const to = str(p, "to");
      if (!to) throw usage("missing --to <branch>");
      const { moveReview } = await import("../core/maintenance.ts");
      moveReview(ctx, review, to);
      emit(p, { moved: review.id, to }, () => `review ${review.id} now tracks ${to}`);
    },
  },

  "drafts list": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const d = svc.listDrafts(ctx, review);
      emit(p, d, () => (d.length ? d.map((x) => `#${x.id} thread #${x.threadId}: ${[svc.firstLine(x.body), x.restore ? svc.restoreTitle(x.restore) : ""].filter(Boolean).join(" · ")}`).join("\n") : "no drafts"));
    },
  },

  "drafts discard": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const r = svc.discardDraft(ctx, review, int(p.positionals[0], "comment id"));
      emit(p, r, () => (r.threadDeleted ? `discarded draft thread #${r.thread}` : `discarded draft in thread #${r.thread}`));
    },
  },

  "drafts edit": {
    options: { body: { type: "string", short: "m" }, "body-file": { type: "string" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const id = int(p.positionals[0], "comment id");
      svc.editDraft(ctx, review, id, await readBody(p));
      emit(p, { edited: id }, () => `edited draft #${id}`);
    },
  },

  read: {
    options: { all: { type: "boolean" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      if (bool(p, "all")) {
        const n = svc.markAllRead(ctx, review);
        emit(p, { read: n }, () => `marked ${n} threads read`);
        return;
      }
      const ids = p.positionals.map((x) => int(x, "thread id"));
      for (const id of ids) svc.markRead(ctx, review, id);
      emit(p, { read: ids }, () => `marked ${ids.map((i) => "#" + i).join(" ")} read`);
    },
  },

  wait: {
    options: { for: { type: "string" }, timeout: { type: "string" }, since: { type: "string" } },
    async run(p) {
      const kind = str(p, "for") ?? "any";
      if (!["review", "reply", "version", "any"].includes(kind)) throw usage("--for must be review, reply, version or any");
      const ctx = await context(p, kind === "reply" ? "reviewer" : undefined);
      const review = await requireReview(ctx, str(p, "branch"));
      const since = str(p, "since");
      const ac = new AbortController();
      process.once("SIGINT", () => ac.abort());
      process.once("SIGTERM", () => ac.abort());
      const r = await svc.waitFor(ctx, review, kind as svc.WaitKind, {
        since: since === undefined ? undefined : Number(since),
        timeoutMs: duration(str(p, "timeout")),
        signal: ac.signal,
      });
      emit(p, r, () =>
        r.reason === "timeout"
          ? "timed out"
          : `${r.reason === "approved" ? `approved v${r.version}` : r.reason}: threads ${r.threads.map((i) => "#" + i).join(" ") || "-"}${r.guide === "requested" ? "; the reviewer asked for a guide to the next version" : ""}`);
      return r.reason === "timeout" ? 5 : 0;
    },
  },

  events: {
    options: { since: { type: "string" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const ev = svc.eventsSince(ctx, review, Number(str(p, "since") ?? 0));
      emit(p, ev, () => ev.map((e) => `${e.seq} ${e.createdAt} ${e.role} ${e.type}${e.threadId ? ` #${e.threadId}` : ""}${e.version ? ` v${e.version}` : ""}`).join("\n"));
    },
  },

  serve: {
    options: { port: { type: "string" }, open: { type: "boolean" }, "print-url": { type: "boolean" }, detach: { type: "boolean" }, foreground: { type: "boolean" }, stop: { type: "boolean" } },
    async run(p) {
      const ctx = await context(p, "reviewer");
      const { serve, stopServer } = await import("../server/server.ts");
      if (bool(p, "stop")) {
        const stopped = await stopServer(ctx);
        emit(p, { stopped }, () => (stopped ? "stopped" : "no server is running"));
        return;
      }
      return serve(ctx, {
        detach: bool(p, "detach") || (bool(p, "open") && !bool(p, "foreground")),
        port: str(p, "port") ? Number(str(p, "port")) : 0,
        open: bool(p, "open"),
        printUrlOnly: bool(p, "print-url"),
        branch: str(p, "branch"),
        json: bool(p, "json"),
      });
    },
  },

  open: {
    options: { print: { type: "boolean" } },
    async run(p) {
      const ctx = await context(p);
      const review = await requireReview(ctx, str(p, "branch"));
      const { editorCommand } = await import("../core/jump.ts");
      const cmd = await editorCommand(ctx, review, int(p.positionals[0], "thread id"));
      if (bool(p, "print") || bool(p, "json") || !process.stdout.isTTY) {
        emit(p, cmd);
        return;
      }
      const r = spawnSync(cmd.argv[0]!, cmd.argv.slice(1), { stdio: "inherit", cwd: cmd.cwd });
      return r.status ?? 1;
    },
  },

  prune: {
    options: { "dry-run": { type: "boolean" } },
    async run(p) {
      const ctx = await context(p);
      const { prune } = await import("../core/maintenance.ts");
      const r = await prune(ctx, { dryRun: bool(p, "dry-run") });
      emit(p, r, () => `${bool(p, "dry-run") ? "would remove" : "removed"} ${r.refs.length} snapshot refs, ${r.rows} snapshot rows`);
    },
  },

  "config get": {
    options: {},
    async run(p) {
      const ctx = await context(p);
      const key = configKey(p.positionals[0], "usage: stet config get <key>");
      const value = ctx.store.meta(key);
      emit(p, { key, value }, () => value ?? "");
    },
  },

  "config set": {
    options: { unset: { type: "boolean" } },
    async run(p) {
      const ctx = await context(p);
      const [rawKey, value] = p.positionals;
      const key = configKey(rawKey, "usage: stet config set <key> <value> | --unset <key>");
      if (value === undefined && !bool(p, "unset")) throw usage("usage: stet config set <key> <value> | --unset <key>");
      ctx.store.setMeta(key, configValue(key, bool(p, "unset") ? null : value!));
      emit(p, { key, value: bool(p, "unset") ? null : value }, () => `${key} = ${value ?? "(unset)"}`);
    },
  },

  "skill install": {
    options: { dir: { type: "string" }, for: { type: "string" } },
    async run(p) {
      const { installSkill } = await import("../core/skill.ts");
      const installed = installSkill({ dir: str(p, "dir"), for: str(p, "for") });
      emit(p, { installed }, () => installed.map((s) => `installed ${s.path}${s.harnesses.length ? `  (${s.harnesses.join(", ")})` : ""}`).join("\n"));
    },
  },

  "skill show": {
    options: {},
    async run() {
      const { SKILL_TEXT } = await import("../core/skill.ts");
      out(SKILL_TEXT);
    },
  },

  export: {
    options: { all: { type: "boolean" }, out: { type: "string" }, force: { type: "boolean" }, review: { type: "string" } },
    async run(p) {
      const file = str(p, "out");
      if (bool(p, "force") && !file) throw usage("--force goes with --out");
      const ctx = await context(p);
      const id = str(p, "review");
      const review = id ? reviewById(ctx.store, int(id, "--review")) : await requireLastReview(ctx, str(p, "branch"));
      const { collectExport, exportMarkdown } = await import("../core/export.ts");
      const data = await collectExport(ctx, review);
      const text = bool(p, "json") ? JSON.stringify(data, null, 2) + "\n" : exportMarkdown(data, { all: bool(p, "all") });
      if (!file) {
        out(text);
        return;
      }
      const path = resolve(file);
      try {
        writeFileSync(path, text, { flag: bool(p, "force") ? "w" : "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw conflict(`${file} already exists: add --force to overwrite it`);
        throw e;
      }
      emit(p, { out: path }, () => `wrote ${path}`);
    },
  },
};

const GROUPS = new Set(["version", "versions", "threads", "thread", "comment", "review", "drafts", "config", "skill"]);

export async function main(argv: string[]): Promise<number> {
  const [first, second, ...rest] = argv;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    out(HELP);
    return 0;
  }
  if (first === "--version" || (first === "version" && second === undefined)) {
    out(`stet ${pkg.version}`);
    return 0;
  }
  let name = first;
  let args = [second, ...rest].filter((x): x is string => x !== undefined);
  if (GROUPS.has(first) && second && commands[`${first} ${second}`]) {
    name = `${first} ${second}`;
    args = rest;
  }
  const cmd = commands[name];
  if (!cmd) {
    out(`unknown command: ${[first, GROUPS.has(first) ? second : undefined].filter(Boolean).join(" ")}\n\n${HELP}`, Bun.stderr);
    return 1;
  }
  const p = parse(args, cmd.options);
  if (bool(p, "help")) {
    out(HELP);
    return 0;
  }
  const code = await cmd.run(p);
  return typeof code === "number" ? code : 0;
}

export function reportError(e: unknown, json: boolean): number {
  const err = e instanceof StetError
    ? { code: e.code, message: e.message, exit: e.exitCode }
    : (e as Error)?.name === "GitError"
      ? { code: "git", message: (e as Error).message, exit: 4 }
      : { code: "internal", message: (e as Error)?.stack ?? String(e), exit: 1 };
  if (json || !process.stderr.isTTY) out(JSON.stringify({ error: { code: err.code, message: err.message } }), Bun.stderr);
  else out(`stet: ${err.message}`, Bun.stderr);
  return err.exit;
}
