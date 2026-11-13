import type { Blocker, CandidateEvidence, GateDecision, PublicationAction, PublicationGrant, PublicationPlan } from "./types.ts";

export interface GateFacts {
  plan: PublicationPlan;
  action: PublicationAction;
  revision: number;
  grant: PublicationGrant | null;
  evidence: CandidateEvidence | null;
  blockers: Blocker[];
  now: number;
  requireGrant: boolean;
}

/** Pure rules shared by inspection, consent and execution; no result is an execution capability. */
export function evaluatePublication(f: GateFacts): GateDecision {
  const { plan: p, action, grant: g, evidence: e } = f;
  const blockers = [...f.blockers];
  const deny = (code: Blocker["code"], message: string, remedy: string) => blockers.push({ code, message, remedy });
  if (!e && !blockers.some((b) => b.code === "candidate_unavailable")) deny("candidate_unavailable", "Fresh candidate evidence is missing.", "Inspect the current worktree and index before requesting publication.");
  if (action !== "commit" || !p.actions.includes(action)) {
    deny("action_not_allowed", `This plan does not authorize ${action}.`, "Prepare a plan using an implemented operation; this release supports one exact commit.");
  }
  if (f.requireGrant) {
    if (!g) deny("no_grant", "Code approval does not grant publication permission.", "Ask the reviewer to authorize the prepared action in Stet.");
    else {
      if (g.provenance !== "local") deny("provenance_untrusted", "Unsupported grant provenance.", "Use an available approval authority.");
      if (g.revokedAt) deny("grant_revoked", "Publication permission was revoked.", "Request fresh consent for the current plan.");
      if (!Number.isFinite(Date.parse(g.expiresAt)) || Date.parse(g.expiresAt) <= f.now) deny("grant_expired", "Publication permission has expired.", "Request fresh consent for the current plan.");
      if (!g.actions.includes(action)) deny("action_not_allowed", `The reviewer did not allow ${action}.`, "Request consent for that specific action.");
      if (g.plan !== p.id || g.digest !== p.digest || g.versionId !== p.versionId || g.revision !== f.revision) {
        deny("approval_stale", "The plan or review changed after publication consent.", "Review the changes and authorize the current plan again.");
      }
    }
  }
  if (e) {
    if (e.worktree !== p.worktree || e.gitDir !== p.gitDir || e.objectFormat !== p.objectFormat) {
      deny("repository_mismatch", "The candidate belongs to a different worktree or object format.", "Prepare a new plan in the enrolled worktree.");
    }
    if (e.ref !== p.ref || e.head !== p.head) deny("ref_changed", "The source branch or HEAD changed.", "Hand over the new history and prepare a new plan.");
    if (e.reviewedTree !== p.tree) deny("metadata_changed", "The reviewed object no longer matches this plan.", "Prepare a new plan from a valid reviewed version.");
    if (e.indexTree !== p.tree || (p.source === "worktree" && e.worktreeTree !== p.tree)) {
      deny("candidate_tree_mismatch", "The commit candidate differs from the reviewed tree.", p.source === "index"
        ? "Prepare the intended index and hand over a new version if its content changed."
        : "Prepare the exact reviewed files in the index; hand over a new version if their content changed.");
    }
  }
  return { schema: 1, allowed: blockers.length === 0, action, plan: p.id, review: p.review, reviewVersion: p.version,
    protection: "local", digest: p.digest, revision: f.revision, grant: g?.id ?? null, evidence: e, blockers };
}
