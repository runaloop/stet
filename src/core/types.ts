import type { AnchorState, Method, OutdatedReason } from "./reanchor.ts";
import type { EventType, Intent, ResolveReason, Role, Verdict } from "./store/db.ts";

export type { AnchorState, EventType, Intent, Method, OutdatedReason, ResolveReason, Role, Verdict };

export interface Range {
  start: number;
  end: number;
}

/** An area of an image in its pixels; `iw` × `ih` is the image's size when the thread was written. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  iw: number;
  ih: number;
}

export interface ReviewDto {
  id: number;
  branch: string;
  baseRef: string | null;
  worktreeHint: string | null;
  state: "active" | "closed";
  source: "worktree" | "index";
  createdAt: string;
}

export interface VersionDto {
  number: number;
  snapshot: string;
  baseSha: string | null;
  label: string | null;
  role: Role;
  author: string;
  createdAt: string;
  files?: number | null;
}

export interface SubmissionDto {
  at: string;
  /** The version on screen when the review was submitted. */
  version: number | null;
  /** `changes`: the drafts went to the agent for the next round; `approved`: that version is done. */
  verdict: Verdict;
  /** The summary written with it. */
  body: string | null;
}

export interface SubmittedDto {
  submission: number;
  verdict: Verdict;
  version: number | null;
  threads: number[];
  comments: number;
  /** Open threads resolved before an approval. */
  resolved: number[];
}

export interface AnchorDto {
  state: AnchorState;
  path: string | null;
  range: Range | null;
  method: Method | null;
  reason?: OutdatedReason;
  against: string;
  againstLabel: string;
}

export interface ThreadSummary {
  id: number;
  status: "open" | "resolved";
  resolveReason: ResolveReason | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  draft: boolean;
  path: string;
  side: "new" | "old";
  range: Range;
  /** Set for a thread on an area of an image; `range` is then 1-1. */
  region: Region | null;
  version: number | null;
  anchorSha: string;
  anchor: AnchorDto;
  excerpt: string[];
  title: string;
  author: { role: Role; name: string };
  createdAt: string;
  commentCount: number;
  unread: boolean;
  needsReply: Role | null;
  last: { role: Role; name: string; at: string; intent: Intent | null; preview: string } | null;
}

export interface CommentDto {
  id: number;
  threadId: number;
  parentId: number | null;
  role: Role;
  author: string;
  body: string;
  intent: Intent | null;
  draft: boolean;
  snapshot: string | null;
  version: number | null;
  createdAt: string;
  updatedAt: string | null;
  step: number;
  /** Published by the other side after your last read of the thread. */
  unread: boolean;
}

export interface Excerpt {
  sha: string;
  path: string;
  start: number;
  end: number;
  firstLine: number;
  lines: string[];
}

export interface TimelineStepDto {
  index: number;
  kind: "anchor" | "version" | "now";
  label: string;
  sha: string;
  version: number | null;
  state: AnchorState;
  method: Method | null;
  reason?: OutdatedReason;
  path: string | null;
  range: Range | null;
  excerpt: Excerpt | null;
  commentIds: number[];
}

export interface ThreadEventDto {
  type: "resolved" | "reopened";
  role: Role;
  at: string;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  comments: CommentDto[];
  events: ThreadEventDto[];
  timeline: TimelineStepDto[];
  /** `then` is null for a thread on an image. */
  code: { then: Excerpt | null; now: Excerpt | null; interdiff: string | null };
  /** Files written by `stet thread show` for a thread on an image. */
  image?: ImageFiles;
}

export interface ImageFiles {
  /** The image with the area framed. */
  shot: string;
  /** The area and a margin around it, at full size. */
  crop: string | null;
}

export interface EventDto {
  seq: number;
  type: EventType;
  role: Role;
  threadId: number | null;
  commentId: number | null;
  version: number | null;
  submissionId: number | null;
  /** Set on `review.submitted`. */
  verdict?: Verdict;
  createdAt: string;
}

export interface CompareFile {
  path: string;
  oldPath: string | null;
  status: "A" | "M" | "D" | "R" | "T";
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** For an image (SVG too): its size and bytes on each side (null where the file is absent). */
  image?: { old: ImageInfo | null; new: ImageInfo | null };
}

export interface ImageInfo {
  w: number | null;
  h: number | null;
  bytes: number;
}

export interface ComparePlacement {
  threadId: number;
  side: "additions" | "deletions";
  path: string;
  range: Range;
  state: AnchorState;
}

export interface CompareDto {
  from: { ref: string; sha: string; label: string };
  to: { ref: string; sha: string; label: string };
  files: CompareFile[];
  placements: ComparePlacement[];
  outside: number[];
}

export interface StatusDto {
  review: ReviewDto;
  versions: number;
  latest: VersionDto | null;
  now: { sha: string; changedSinceLatest: boolean; excluded: string[]; files?: number | null } | null;
  counts: {
    open: number;
    resolved: number;
    outdated: number;
    changed: number;
    drafts: number;
    needsAgent: number;
    needsReviewer: number;
    unread: number;
  };
  /**
   * The reviewer's latest submission: its verdict stands until the next one. `changedAfter`: a newer version
   * exists, or "now" differs from the version it was about.
   */
  lastSubmission: (SubmissionDto & { changedAfter: boolean }) | null;
  lastSeq: number;
}

export interface NowStateDto {
  /** "now" as the worktree is at this moment. */
  sha: string;
  /** "now" as the pages show it until someone re-reads it. */
  pinned: string;
  /** Files that differ between the two. */
  files: number | null;
}

export interface GitFileDto {
  path: string;
  /** Changes added to the index (`git add`) and not committed. */
  staged: boolean;
  /** Changes in the working tree that are not in the index. */
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  /** Changed by commits of the branch that its upstream does not have. */
  unpushed: boolean;
}

export interface GitStateDto {
  branch: string;
  /** The worktree that holds the branch; null when "now" is the branch tip. */
  worktree: string | null;
  /** The worktree's HEAD is not on the branch (detached, as under jj). */
  detached: boolean;
  tip: string | null;
  upstream: string | null;
  /** The upstream is set for the branch; otherwise it is a remote branch of the same name. */
  tracking: boolean;
  /** The upstream is set but the remote branch is gone. */
  gone: boolean;
  ahead: number;
  behind: number;
  unpushed: { sha: string; subject: string }[];
  files: GitFileDto[];
  truncated: boolean;
}

export interface GrepLineDto {
  line: number;
  text: string;
  match: boolean;
}

export interface GrepFileDto {
  path: string;
  groups: GrepLineDto[][];
  matches: number;
}

export interface GrepResultDto {
  files: GrepFileDto[];
  total: number;
  truncated: boolean;
  error: string | null;
}

export interface ReviewedDto {
  sha: string;
  label: string;
  version: number | null;
  at: string;
}

export interface CursorsDto {
  reviewed: ReviewedDto | null;
  viewed: string[];
}

export interface CommitDto {
  sha: string;
  parent: string | null;
  author: string;
  date: string;
  subject: string;
  /** Versions taken at this commit (`exact`) or on top of it (working tree or index changes). */
  versions: { number: number; exact: boolean }[];
  onBranch: boolean;
}

export interface CommitsDto {
  tip: string | null;
  /** Where the branch leaves the main line, and the ref it was found against. */
  forkPoint: string | null;
  forkRef: string | null;
  commits: CommitDto[];
  more: boolean;
}

export interface BlameOriginDto {
  /** `base`: unchanged since the review's base, or brought by a newer base; `now`: in the working tree only, in no version yet. */
  kind: "base" | "version" | "now";
  version: number | null;
  label: string | null;
  createdAt: string | null;
}

/** The reviewer's review that the code answers: review `index`, counted from 1 as in `submissions`. */
export interface BlameRoundDto {
  index: number;
  at: string;
  verdict: Verdict;
  /** The version that review was about. */
  version: number | null;
}

/**
 * A thread the agent answered with the code of this origin. `match`, strongest first: `anchor`, a `fixed`
 * reply on a thread anchored on the line there; `named`, a `fixed` or `answered` reply that names the file
 * (and the line, when it gives lines); `file`, a `fixed` reply on a thread anchored in the same file.
 * A line gets the threads of its strongest kind only.
 */
export interface BlameThreadDto {
  id: number;
  title: string;
  status: "open" | "resolved";
  match: "anchor" | "named" | "file";
  /** The agent's reply that matched, its body cut short. */
  reply: { id: number; intent: "fixed" | "answered"; body: string; at: string };
}

/** Consecutive lines with the same origin and the same threads. */
export interface BlameRunDto {
  start: number;
  end: number;
  origin: BlameOriginDto;
  round: BlameRoundDto | null;
  threads: BlameThreadDto[];
  /** Where these lines are in the version (or "now") that brought them; null for `base`. */
  source: { path: string; start: number; end: number } | null;
}

export interface BlameDto {
  path: string;
  at: { ref: string; sha: string; label: string };
  /** Null for an empty file. */
  range: Range | null;
  runs: BlameRunDto[];
}
