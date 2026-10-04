import type { ThreadSummary } from "../../src/core/types.ts";

export function thread(p: Partial<ThreadSummary> & { id: number; path: string }): ThreadSummary {
  return {
    status: "open",
    resolveReason: null,
    resolvedAt: null,
    resolvedBy: null,
    draft: false,
    side: "new",
    range: { start: 1, end: 1 },
    region: null,
    version: 1,
    anchorSha: "a".repeat(40),
    anchor: { state: "ok", path: p.path, range: p.range ?? { start: 1, end: 1 }, method: "identity", against: "b".repeat(40), againstLabel: "now" },
    excerpt: [],
    title: `thread ${p.id}`,
    author: { role: "reviewer", name: "alice" },
    createdAt: "2026-09-23T00:00:00.000Z",
    commentCount: 1,
    unread: false,
    needsReply: "agent",
    last: null,
    ...p,
  };
}
