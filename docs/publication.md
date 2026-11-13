# Local publication checks

Stet can prepare an exact commit for a reviewer to authorize in the existing review UI. Code approval
and publication consent are separate. Ordinary `review submit --approve` and `wait: approved` retain
their review-loop meaning; neither permits publication.

This first increment supports **one unsigned local commit** from a worktree/index version. Push, MR,
merge, already-authored commit ranges, runtime hooks and Protected approval are unavailable. The
[implementation plan](approval-and-publication-plan.md) tracks those later packages.

## Prepare the action

Hand over a version, then prepare a JSON file outside the repository. Supply exact metadata; the server
derives the repository, branch, parent, reviewed tree, snapshot and version identity.

```json
{
  "schema": 1,
  "review": 1,
  "version": 2,
  "protection": "local",
  "actions": ["commit"],
  "commit": {
    "message": "Fix the queue\n\nPreserve pending jobs on retry.\n",
    "author": { "name": "Author", "email": "author@example.com" },
    "committer": { "name": "Publisher", "email": "publisher@example.com" },
    "signing": "none",
    "timestamps": "execution"
  }
}
```

```sh
stet publication prepare --file /path/outside/repository/plan.json --json
stet publication show <plan-id> --json
stet gate --plan <plan-id> --action commit --json
```

Preparation and inspection never stage files, update authored branch refs, grant permission or contact
a remote. They may create internal Git objects through a temporary index. Repeating preparation creates
a new immutable plan with a new digest and invalidates earlier consent for that review.

For a worktree review, explicitly stage the exact reviewed files before consent. Both the fresh
worktree tree and the frozen index must equal the reviewed tree. For an index review, unrelated
unstaged/untracked files remain outside the operation. A gate never stages or discards them.

## Authorize in the review UI

The prepared plan appears on **Round** and **Drafts**, with a **Publication** link in the header. Review
the version, source branch, exact message and attribution; check **Allow one commit** and press
**Approve vN and authorize commit**. The checkbox always starts unchecked. This action approves the
named version and grants that exact commit for 24 hours. It does not execute it.

Unsubmitted drafts, unresolved published threads and settled instructions block consent. Nits can
still accompany ordinary code approval, but their final edited content needs a new version and fresh
publication consent. A stale tab cannot approve a newer plan or version accidentally: submission binds
the digest, version ID and eligibility revision.

**Pause publication** stops future dispatch while composing a review. **Resume publication** permits
fresh authorization; it does not revive the old grant. **Revoke permission** withdraws an existing grant.
Read marks, viewed-file preferences and private drafts do not secretly invalidate existing consent.
New versions, published reviewer instructions, thread-state changes and closing/moving a review do.

## Execute and inspect the receipt

```sh
stet publish --plan <plan-id> --through commit --operation <stable-operation-id> --json
stet publication show <plan-id> --json
stet publication revoke <plan-id> --as reviewer --json
stet doctor --approval --json
```

The executor repeats the gate, reserves one operation, creates a commit from the approved immutable
tree and metadata, checks eligibility again, then updates only the planned branch with its expected
old SHA. The index is left intact. Repository hooks do not run: validation must already have been done
before review, and hooks must not alter the artifact or metadata after consent. Timestamps use the
reservation time. Internal `refs/stet/publication/<operation-id>` retain generated objects for recovery.

Use the same operation ID on retry. A confirmed operation returns its receipt. A dispatched operation
is reconciled against the recorded branch and commit even if consent has since expired or been revoked;
this does not dispatch again. An ambiguous result stays `outcome_unknown`. A reservation interrupted
before dispatch is not automatically resumed; inspect it and prepare a new plan with fresh consent.
Creating another operation against the same plan is refused. Revocation cannot recall an already
dispatched update and does not reset a branch or erase receipts.

`gate` uses exit 0 only when allowed, exit 3 for policy denial, and other nonzero exits for invalid
invocation or operational errors. Its versioned JSON includes blockers, remedies and candidate
identities. A successful inspection is diagnostic evidence, not a reusable authorization token.

## Limits

The UI labels this mode **Local checks**. The same OS user can alter the local database, select the
reviewer role, disable these tools or publish through Git/API commands directly. Existing server
authentication protects local requests; it does not distinguish the human from an unrestricted agent
running as that user. No credentials, OS accounts, sandbox settings or hooks are installed.

Complete tree equality covers file bytes, executable bits, symlinks and deletions. Replacements,
grafts, shallow history, sparse/assume-unchanged entries, in-progress merges/rebases, submodules and
LFS pointers are refused. A version must have been captured from the current worktree/index parent;
reparenting unchanged bytes does not transfer consent. Unknown schemas and unsupported actions deny.

Protected approval needs an independently authenticated reviewer and an isolated authority/executor
that controls governed refs and publication credentials. Until that environment and its negative
tests exist, Stet makes no non-bypassable human-approval claim.
