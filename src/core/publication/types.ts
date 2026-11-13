/** Additive publication contracts. Code approval alone never creates a publication grant. */
export type PublicationAction = "commit" | "push" | "mr" | "merge";
export type BlockerCode = "no_grant" | "action_not_allowed" | "approval_stale" | "pending_review_work"
  | "candidate_unavailable" | "candidate_tree_mismatch" | "history_mismatch" | "repository_mismatch"
  | "ref_changed" | "metadata_changed" | "validation_missing" | "provider_not_ready" | "grant_revoked"
  | "grant_expired" | "operation_consumed" | "provenance_untrusted" | "enforcement_unavailable";

export interface Blocker { code: BlockerCode; message: string; remedy: string }
export interface Identity { name: string; email: string }
export interface CommitMetadata {
  message: string;
  author: Identity;
  committer: Identity;
  signing: "none";
  timestamps: "execution";
}
export interface PreparePublication {
  schema: 1;
  review: number;
  version: number;
  protection: "local";
  actions: ["commit"];
  commit: CommitMetadata;
}
export interface PublicationPlan extends PreparePublication {
  id: string;
  repository: string;
  worktree: string;
  gitDir: string;
  objectFormat: "sha1" | "sha256";
  source: "worktree" | "index";
  versionId: number;
  snapshot: string;
  tree: string;
  base: string | null;
  baseRef: string | null;
  ref: string;
  head: string | null;
  policy: 1;
  createdAt: string;
  digest: string;
}
export interface PublicationGrant {
  id: string;
  plan: string;
  digest: string;
  versionId: number;
  revision: number;
  actions: PublicationAction[];
  reviewer: string;
  provenance: "local";
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
export interface CandidateEvidence {
  worktree: string;
  gitDir: string;
  ref: string;
  head: string | null;
  objectFormat: "sha1" | "sha256";
  indexTree: string;
  worktreeTree: string | null;
  reviewedTree: string;
}
export interface GateDecision {
  schema: 1;
  allowed: boolean;
  action: PublicationAction;
  plan: string;
  review: number;
  reviewVersion: number;
  protection: "local";
  digest: string;
  revision: number;
  grant: string | null;
  evidence: CandidateEvidence | null;
  blockers: Blocker[];
}
export interface ConsentExpectation { digest: string; versionId: number; revision: number }
export interface PublicationReceipt {
  id: string;
  plan: string;
  grant: string;
  action: "commit";
  state: "reserved" | "dispatched" | "confirmed" | "blocked" | "failed" | "outcome_unknown";
  commit: string | null;
  createdAt: string;
  updatedAt: string;
  detail: string | null;
}
export interface PublicationView {
  plan: PublicationPlan;
  grant: PublicationGrant | null;
  paused: boolean;
  decision: GateDecision;
  receipts: PublicationReceipt[];
}
