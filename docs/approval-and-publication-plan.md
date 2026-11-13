# Approval and publication control implementation plan

Status: implementation started on 10 November 2026. The first increment implements local plans, a
shared gate, explicit UI consent and one exact commit with receipts. See [Local publication checks](publication.md)
for the implemented contract. Push/MR/merge, runtime adapters and the isolated authority remain planned.
No credentials, hooks, OS accounts or protected service are installed. Baseline inspected on 6 November 2026.

The delivered slice covers P0 and the single-commit parts of P1–P3/P7: immutable local plans and grants,
fresh worktree/index trees, stale-consent checks, explicit action selection, pause/revoke, one exact
unsigned commit, expected-old-value branch updates and retained receipts. Unknown outcomes are never
redispatched automatically. Existing code-approval and `wait` semantics remain unchanged.
Runtime/helper enforcement (P4), protected isolation (P5), remote publication (P6), validation-evidence
policy, informational-thread waivers and metadata comparisons remain open in [TODO](../TODO.md).
This is not completion of the full design below.

Stet should let a human review large changes once, in the existing review interface, and authorize
specific follow-up actions there. A coding agent should be able to prepare everything without being
able to turn its own claim of approval into a commit, push, merge request or merge.

The recommendation is to build one approval evaluator, an explicit publication permission model and a
structured executor. Integrate those with agent runtimes for protection against omitted checks. Add an
isolated approval authority and executor before claiming that a human approval cannot be forged or the
publication check bypassed. Those are distinct delivery milestones, with distinct guarantees.

Reading order: sections 2–4 explain the current gaps and guarantees; sections 5–11 define the records,
user flow and enforcement; sections 12–16 cover migration, delivery and acceptance.

## 1. Problem and intended outcome

An agent can read a rule requiring approval, follow the formatting parts of a workflow, and still treat
"finish the task and create an MR" as permission to skip the approval step. More prose in the same
instructions does not make that step execute. A publication helper can also push internally, so
checking only the obvious `git push` or MR command misses the actual side effect.

The intended workflow is:

1. The agent finishes and validates the change, prepares publication metadata and creates a Stet version.
2. The human reviews the code in Stet, including changes of 10,000–15,000 lines, using existing versions,
   guides, threads and interdiffs.
3. The human approves that version and explicitly selects the permitted publication actions in Stet.
4. An executor checks the approval and exact candidate immediately before each action.
5. The human and agent see what was allowed, what actually happened and why anything was blocked.

The human must not have to review the entire diff again in chat, a command approval dialog or a second
application. A compact action summary is enough for publication consent. Code approval, publication
consent and remote merge readiness must remain separate concepts.

### Scope

Include code approval validity, publication plans, explicit permissions, commit/push/MR execution,
separate merge authorization, revocation, recovery, audit, CLI/API/UI contracts, agent integrations and
an optional protected deployment.

Keep normal local review available without a publisher or external account. Build and test execution
remain in existing tools; Stet can bind their evidence to a candidate without becoming a build system.
Release tags, deployment, messages to colleagues and arbitrary shell execution are outside this initial
permission set. They never inherit permission from "create MR" or "merge".

## 2. Current behavior and why it is insufficient

These are observations about the current implementation, not descriptions of the proposed features.

| Current behavior | Evidence | Consequence for this work |
|---|---|---|
| `lastSubmission` is a computed DTO over the latest reviewer submission. `changedAfter` is calculated when status is read. | [`submissionTimes` and `status`](../src/core/service.ts), [`SubmissionDto`](../src/core/types.ts) | It is useful review state, not a separately protected approval object. |
| Review rows, submissions and versions live in the common Git directory's `stet/review.db`, shared across worktrees. Directory permissions are `0700`; database files are `0600`. | [`Store.openInCommonDir`](../src/core/store/db.ts), [schema](../src/core/store/migrations.ts) | An agent running as the same OS user can still write the store. File permissions do not distinguish it from the reviewer. |
| CLI role comes from options or `STET_ROLE`; author is also configurable. | [`openContext`](../src/core/context.ts), [CLI documentation](../README.md#cli) | `--as reviewer` is a role selector, not independent evidence of a human decision. |
| The CLI and web submission route call `submitReview`. The service rejects approval for an agent role. | [`submitReview`](../src/core/service.ts), [`POST /api/review/submit`](../src/server/api.ts) | The role check is useful in the normal workflow but cannot authenticate a human against a process that chooses its role. |
| `standingApproval`, used by `wait`, checks the last verdict and latest version ID, without comparing current content. | [`standingApproval`](../src/core/service.ts), [approval tests](../test/approve.test.ts) | A standing approval is a review-loop signal. `wait` must not be treated as permission to publish current files. Add a direct dirty-worktree regression test for this distinction. |
| Status can return `now: null` after a snapshot error. Web status can use a pinned `now`; snapshot capture also has a short-lived in-process cache. | [`status`](../src/core/service.ts), [`GET /api/review`](../src/server/api.ts), [`takeNow`](../src/core/snapshot.ts) | The gate needs fresh evidence and must deny when the candidate cannot be established. A false `changedAfter` alone is insufficient. |
| Approval can carry nits, keep other threads open and include resolved-with-message instructions. The documented agent loop fixes nits without another full review round. | [Drafts and approval](ui.md#drafts-and-approval), [approval tests](../test/approve.test.ts), [resolve-with-message tests](../test/resolve-message.test.ts) | Completing the review does not automatically authorize publishing the later edited tree. Preserve the review loop and add a separate final permission. |
| Snapshots can omit ignored, secret-looking, large untracked or configured excluded files. A snapshot commit is not the eventual authored commit. | [`snapshot.ts`](../src/core/snapshot.ts), [Security](../SECURITY.md) | Compare complete candidate trees and history, not snapshot commit IDs, file counts or the fact that a branch is clean. |
| The server token is stored beside the review database and can be obtained by a client with the existing local access. | [`serverToken`](../src/server/info.ts), [security tests](../test/security.test.ts) | Reusing this token for a new "human-only" endpoint would not create a new trust boundary. |

The existing design deliberately serves a local review loop. Its same-user trust model is not a defect
that an extra boolean can repair; publication enforcement adds a stronger, opt-in requirement.

## 3. Product decisions

| Decision | Reason |
|---|---|
| Keep Stet as the code review surface. | Large diffs already need its threads, versions and interdiffs; duplicating them adds work without improving consent. |
| Code approval does not itself grant commit, push, MR or merge permission. | A reviewer may accept the implementation while wanting to publish later or personally. |
| Bind permission to both content and a structured action plan. | An approved tree must not be sent to another project, branch or audience. Commit and MR text also need the required human preview. |
| Bind identities and refs, not display names or paths alone. | Worktree moves, branch name reuse and fork/upstream remotes must not transfer permission. |
| Every executor step revalidates its inputs. | A successful earlier check is neither a lock nor a reusable bypass token. |
| Default to denial on absent, stale, unsupported or unreadable evidence. | An unavailable reviewer service must not silently become permission. |
| Keep review acceptance after nits, but require consent for the final edited candidate. | This preserves the existing review semantics without guessing which unreviewed edits are harmless. |
| Give merge a separate scope and readiness check. | Opening an MR does not authorize changing the target branch. |
| Report the effective protection level. | A writable local hook must not be presented as a non-bypassable human approval mechanism. |
| Store operation receipts and reconcile uncertain outcomes. | A lost response must not produce a second commit, duplicate MR or destructive retry. |

## 4. Protection levels and threat model

### Local workflow mode

Run on the current machine and under the current user. Store plans and grants locally, evaluate them
consistently, integrate the evaluator with the executor, Git hooks, publication helpers and supported
agent tool hooks.

This mode targets accidental omission, stale approvals and unintended helper side effects. It is useful
without changing the user's environment. It does not prevent a process with the user's privileges from
editing the database, replacing the evaluator, disabling hooks, selecting the reviewer role or using
credentials through another program. Label it **Local checks**, not **Protected approval**.

### Protected mode

A trusted authority records the human decision. A trusted executor alone can update governed branch
refs and use publication credentials. The agent can propose plans, read permitted review state, edit
source and request execution, but cannot create grants, alter the policy or perform the governed
operations directly.

The reference deployment should use OS isolation: a publisher service under a separate principal and
an agent environment without its credentials, writable policy, authority database, process inspection
or control of the human approval session. An isolated host application integration can be another
adapter only if it demonstrates the same boundary. A different process under the same unrestricted
user is insufficient.

Protect all of the following together:

- Grant issuance, revocation state, trusted verification keys and policy distribution.
- The human authentication/session channel, including browser profiles and agent-accessible browser
  automation. If the agent can drive the trusted Approve action, a separate HTTP token is insufficient.
- Provider credentials, SSH agents, credential helpers and alternate GitLab/API/MCP write routes.
- Governed Git metadata and branch ref updates, plus the executor binary, configuration and dependencies.

An agent may create arbitrary Git objects in its own scratch space. The enforceable local promise is
control of the enrolled workstream's authored branch updates, not a ban on every possible `commit-tree`
on the machine. Stet's internal snapshot objects and `refs/stet/*` remain distinct from authored commits
and publication; the protected review service creates them through its own narrow operations.

Repository content, agent-supplied JSON and display names are untrusted inputs. A compromised OS,
provider administrator or human deliberately approving the wrong content is outside this boundary.
Protected mode is unavailable if isolation or required provider capabilities cannot be verified; it
must not fall back to local mode silently.

## 5. Records and identity

Keep review submissions as review history. Add separate immutable records for publication consent and
execution. Do not reinterpret old reviewer submissions as new grants.

### Publication plan

An agent may prepare and revise a plan before consent. Each revision has a stable ID, a versioned
canonical representation and a digest. Once granted, its contents are immutable; editing creates a new
revision that needs consent for the changed actions.

The plan contains:

- An authority-issued repository identity, Git object format, review identity and source mode
  (`worktree` or `index`). A filesystem path is a locator, not the identity.
- The reviewed version, snapshot object, full Git tree and resolved review-base commit.
- The governed source branch ref, expected source HEAD and allowed parent/history boundary.
- Provider host, stable source and target project identities, normalized remote destination, source ref,
  expected remote ref value and target branch. `origin` alone is not a destination identity.
- Selected operations and their dependencies; no wildcard "all future actions" permission.
- Exact commit message, attribution, author/signing policy, and the permitted treatment of timestamps.
- Exact MR title and description, draft state, reviewers/assignee, squash and source-removal settings.
  Final helper-generated text must be materialized before approval, not appended afterward.
- Required validation evidence/policy, such as checks for the reviewed tree and toolchain. Distinguish
  agent-reported local results from independently verified CI results.
- For an existing MR or merge request: its stable identity, expected source SHA and merge settings.
- Creation time, plan revision and a protected policy revision. Never put credentials in the plan.

Enrollment and governed refs need lifecycle generations. Deleting/recreating a governed branch or
reenrolling a repository invalidates older bindings even if the display name and commit are reused.
Protected ref-management operations update that generation; local mode cannot promise to detect
out-of-band metadata tampering.

The first implementation supports one authored commit for one exact tree and parent, or publication
of an explicit already-reviewed commit range. Multiple commits need an explicit ordered manifest.
Tip-tree equality does not approve hidden intermediate commits: pushing the range could expose
unreviewed or secret content later removed from the tip.

### Publication grant

The grant records the plan digest, review/version/tree/base identities, reviewer identity and the
source of its authentication, explicitly allowed operations, issue/expiry times, revocation generation
and relevant review-state revision. Use bounded validity, initially proposed as 24 hours, to allow an
asynchronous workday without creating a permanent branch permission. Policy may shorten it.

A grant is a bounded operation chain: commit once, push that recorded result once, and create or update
the named MR as specified. The executor records the resulting commit and MR identities. A grant cannot
be replayed to create another commit with a different message or push another ref.

Advance the eligibility revision for authorization-relevant events: a new version, published blocking
instructions, changed plan, pause, revocation or policy change. Read markers, viewed-file state and
panel preferences must not invalidate consent. Private drafts follow the explicit pause rules below.

In local mode, record provenance as local and writable. In protected mode, the authority's store is the
source of truth. If signed attestations cross process boundaries, use standard signing primitives and
versioned canonical serialization; pin the trust root in protected policy. A signature alone does not
solve stolen credentials, browser automation, revocation or bypass of the executor. A grant ID is a
reference, not a bearer permission to perform arbitrary actions.

### Execution and evidence records

For each operation, keep an operation ID, plan/grant revisions, expected inputs, timestamps, actor,
reservation state, result identity and reconciliation evidence. Record blockers and effective
protection mode without logging access tokens, private review drafts or credential-bearing URLs.

Persist grant/revocation/execution records in the protected authority's store in protected mode.
Mirroring their display into `.git/stet/review.db` is allowed, but that mirror is not authoritative.
Backups, key rotation and retention must preserve revocation and consumed-operation state; restoring
an older backup must not revive a spent grant. Rotate the authority generation after an unsafe restore.

## 6. Gate contract

Introduce a single evaluator shared by CLI, server, UI and executor. It evaluates an explicit plan and
operation, not whichever review a caller's environment happens to select.

The evaluator must:

1. Resolve the enrolled repository and worktree against trusted identity. Reject unknown, closed,
   mismatched or ambiguous reviews and unsupported Git states.
2. Verify the plan digest, policy revision, permitted operation, grant provenance, expiry, revocation
   and operation consumption. In protected mode, reject local-only grants and forged role claims.
3. Read the authoritative current review state. Require approval of the latest version and a valid
   publication grant for that exact version; `wait: approved` is not an input to this decision.
4. Require no pending instructions to the author, including resolved-with-message work. Default to no
   unresolved threads. Explicitly waivable informational threads need a reviewer-recorded waiver
   bound to their IDs and state revision; `--force` must not become a publication bypass.
5. Capture fresh candidate evidence without the UI pin or `takeNow` cache. Treat snapshot/Git/store
   errors, missing objects and invalid metadata as blockers. Do not rely only on `changedAfter`.
6. Compare the complete operation candidate tree with the reviewed tree, including modes, executable
   bits, symlinks, deletions, binary entries and submodule pointers. Validate Git object format and
   refuse replacement/graft mechanisms that could change object interpretation.
7. Check source HEAD, parent/history manifest, base identity and destination refs. Do not transfer a
   grant through rebase, amend, cherry-pick, a new review, branch reuse or another repository.
8. Evaluate action-specific metadata, validation and provider readiness. Produce stable reason codes
   and the evidence identities used by the decision.

An inspection does not grant permission or execute publication. Computing a candidate may create
internal Git objects or temporary indices, as snapshot capture already does; it must not change the
user's staging state, branch refs, review verdict or grant. Gate output is diagnostic evidence, not a
reusable permission token. The executor re-evaluates before dispatch.

### Worktree and index semantics

| Source | Publication requirement | Why |
|---|---|---|
| Worktree review | The fresh reviewed worktree candidate and the frozen commit/index candidate must equal the approved tree. | Prevent committing only part of the reviewed change or accidentally staging another file. |
| Index review | The frozen index candidate must equal the approved tree. Unstaged and untracked changes remain outside that operation and are shown as such. | Preserve `stet init --staged` without making unrelated unstaged work a reason to restage or discard it. |
| Existing commits | The exact commit IDs, order, parents and reachable range must match the approved manifest. | Publishing history is broader than publishing a final file tree. |

Excluded files are not silently added to publication. An excluded path newly staged or included in the
candidate causes a tree mismatch. If a configured exclusion conceals changes to tracked content that
will be published, the evaluator must detect the incomplete review and refuse until that content is
reviewed. Untracked ignored files left outside the candidate do not by themselves block an index review.
Submodule pointers and LFS pointer files require an explicit support statement: approval of a pointer
does not mean the pointed-to repository or external bytes were reviewed. Deny unsupported publication
formats by default; do not claim that tree equality verifies an LFS object upload.

For an exact candidate, an edit followed by an exact restoration can remove a content mismatch. A new
Stet version, a published request for changes, a plan revision, revocation or expired grant cannot be
undone merely by restoring old bytes.

### Machine-readable result

All fields and names below are proposed interfaces, not existing commands. A result should be versioned
and include the plan, review, grant, protection mode, candidate identities and blockers.

```json
{
  "schema": 1,
  "allowed": false,
  "action": "commit",
  "plan": "publication-plan-id",
  "protection": "local",
  "reviewVersion": 4,
  "blockers": [
    {
      "code": "candidate_tree_mismatch",
      "message": "The index differs from the approved version.",
      "remedy": "Prepare the intended candidate and hand over a new version if its content changed."
    }
  ]
}
```

Use exit `0` only for an allowed decision; reuse exit `3` for policy denial/conflict. Invalid invocation
and operational failures keep existing CLI conventions, always nonzero. Adapters treat every nonzero
exit, timeout, malformed or unsupported result as denial, with a useful diagnostic. A denied decision
must never be disguised as an empty successful response.

Reason codes should cover at least: `no_grant`, `action_not_allowed`, `approval_stale`,
`pending_review_work`, `candidate_unavailable`, `candidate_tree_mismatch`, `history_mismatch`,
`repository_mismatch`, `ref_changed`, `metadata_changed`, `validation_missing`, `provider_not_ready`,
`grant_revoked`, `grant_expired`, `operation_consumed`, `provenance_untrusted` and
`enforcement_unavailable`. Remediation must not suggest self-approval, `--force` or disabling protection.

## 7. Human interaction in Stet

### Review and authorize without a second full diff

Extend the existing Drafts/approval flow with a compact publication card:

- Reviewed version and source mode, plus whether current content still matches.
- Repository/project and source → target branch.
- Separate permissions for commit, push and MR creation/update. Selecting an action shows its
  dependencies; allowing a push never silently permits creating a commit first.
- Exact commit message and MR title/body, with expandable details and a metadata-only comparison when
  those change. Preserve repository-required previews within this card.
- Protection mode, expiry, pending checks and any instructions that prevent publication.

Keep **Approve code** distinct from **Approve and authorize selected actions**. No publication scope is
silently preselected or inherited from another review. Existing `S` behavior can approve code; publication
consent must use an explicit action whose label names what it authorizes. Keyboard users get the same
scope summary and intentional confirmation, without repeated chat gates.

Submission uses an expected version ID, plan digest and eligibility revision. If a new version or plan
arrives while the human is reading, refuse the stale submission and show what changed. Do not silently
approve the new latest version that happened to exist at click time. The server derives the tree and
other protected fields rather than trusting the submitted payload.

In protected mode, this action uses an independently authenticated reviewer channel. Define pairing,
session expiry, origin/CSRF protection and either isolation from agent browser control or an explicit
human-presence mechanism. The ordinary Stet bearer token and `--as reviewer` cannot mint a protected
grant. TUI or terminal authorization needs the same authority, not an exception based on the client UI.

### Nits and changes after approval

Preserve **approved with nits** as a review verdict. Show **publication blocked: final changes need
confirmation** while instructions remain or the candidate differs. After fixes, create the next
version and present its interdiff plus the compact publication card for final authorization. This is
confirmation of the resulting content, not an obligation to reread the whole branch or reopen resolved
threads. Neither `fixed` replies nor a model's assessment of a "comment-only" change transfer a grant.

Any policy for delegated automatic nit acceptance would require its own explicit, narrow future design;
it is not part of this plan.

### Status, pause and revocation

Show code-review state and publication state separately in the header and Round page. Useful messages
include **Code approved at v4**, **Authorized: commit, push, create draft MR**, **Blocked: changed index**,
**Expired**, **Revoked**, **Executing push** and **Completed: MR URL**.

Blockers link to the relevant version/interdiff, thread or changed action metadata so the human can
inspect the cause in context. Publish plan/grant/execution changes through the existing live-event
mechanism and refresh other tabs. Event delivery updates the display; the executor still obtains a
fresh authoritative decision and cannot depend on receiving every event.

A reviewer can revoke outstanding permissions without writing a dummy review comment or changing the
code verdict. A published request for changes invalidates remaining permissions. New published blocking
instructions suspend them until explicitly authorized again. Unsubmitted drafts retain current privacy
and do not secretly revoke a previously granted operation; provide a visible **Pause publication**
action for a reviewer who needs an immediate stop while composing a new review.

Revocation stops future dispatch. An action already sent to a provider may finish; show that boundary
and its result. Never automatically revert, reset, force-push or delete an MR to simulate revocation.

Closing a review blocks remaining execution but retains receipts. Closing does not reverse actions
already completed, and reopening does not restore old consumed or revoked grants.

## 8. Structured execution and races

Provide a structured executor API with fixed operation types and argument validation. Do not implement
`stet gate && arbitrary-command`: the shell command can publish something different from what the gate
checked. Never execute a plan-provided shell command.

An execution is a sequence, not one distributed transaction:

`prepared → reserved → dispatched → confirmed`

It may also become `blocked`, `failed` or `outcome_unknown`. Grant state is separate: an active grant
can have a completed commit and a blocked push. Preserve completed results while stopping the remaining
steps.

Reserve one operation per plan/branch in the authority store, freeze its exact inputs, recheck eligibility
and serialize conflicting executions. Source edits may continue elsewhere, but the executor must use
the immutable approved objects and reject a fresh review/candidate mismatch before each new operation.
A filesystem lock in an agent-writable directory is not the protected reservation.

The artifact and governed ref update are the protected inputs; ordinary source files are not locked
against all concurrent editing. Publishing immutable approved objects prevents a later file edit from
changing the dispatched artifact. Each following operation takes fresh evidence before it proceeds.

### Commit

Freeze the exact approved tree and commit metadata. Stage through an explicit operation or isolated
index, never `git add -A` on the user's live index as a hidden side effect. Create the authored commit
with the permitted parent(s), then update the governed branch only if its previous value still matches
the plan. Git provides an expected-old-value ref update; use that primitive and check its result.
See [git-update-ref](https://git-scm.com/docs/git-update-ref).

Do not equate the Stet snapshot SHA with the authored commit SHA: compare trees, then bind the new
commit's identity and parents in the receipt. Amend, automatic formatting, changed attribution or a
hook that edits the result cannot silently alter the authorized artifact. A branch-ref update and the
execution ledger need crash recovery; a local database transaction alone cannot make both atomic.

### Push

Push the recorded commit/range to the exact approved destination ref. Verify ancestry and prohibit
history rewrites by default. Bind the expected remote ref and use a server-checked update precondition
where supported; the explicit expected-value lease is one Git primitive. A lease does not itself grant
permission for a non-fast-forward update. Do not use a mutable tracking ref as the sole precondition.
See [git-push](https://git-scm.com/docs/git-push).

Exclude tag pushes, additional refs, recursive submodule pushes and unreviewed reachable history.
Verify the remote result afterward. A remote URL, credential helper or Git config change must not
redirect the approved push.

### Create or update an MR

Resolve stable provider project identities, including fork versus upstream, before consent. Send the
approved metadata and source/target refs; verify that the source ref still denotes the authorized
commit. Do not allow a helper to auto-push unless the grant also permits that push and the executor
performs it as a separate checked step. Planning, validation and dry-run paths must have no publication
side effects.

A provider MR-creation API may bind a moving branch rather than a commit. Close this race with verified
exclusive publication control of that branch or a provider-supported conditional operation. A pre/post
read can detect a race but does not prevent the wrong intermediate MR from appearing. Deny a protected
operation if the required guarantee cannot be enforced; do not silently weaken it to detection.

Reuse an existing matching MR instead of creating a duplicate. Metadata changes need their own approved
plan revision; unchanged code need not be rereviewed. Do not silently publish extra attribution,
reviewers, labels or links added by wrappers after consent.

A revised plan can reference a previously confirmed commit/push receipt when that exact result still
matches its preconditions. Authorizing a changed MR description must not create another commit or
silently grant already consumed actions again.

### Merge

Require a separate merge grant naming the MR, source SHA, target branch, strategy, squash text and
source-branch removal. Recheck remote approvals, blocking discussions, conflicts, draft state and the
required checks for that exact source or provider-generated merge candidate.

Define required CI jobs/sources in policy. An unrelated green pipeline, a skipped MR pipeline, a stale
approval left standing after a push or a provider's permissive `mergeable` flag is not sufficient evidence
for a stricter Stet policy. State explicitly whether approvals must postdate the last source change;
if the provider cannot establish the required binding, report it as unavailable. Optional manual jobs
do not become required unless policy says so.

Use a provider-side source-SHA condition; GitLab's merge endpoint accepts `sha` and rejects a mismatch.
See [GitLab merge API](https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request).
Target-head pinning is a separate capability: a source-SHA condition does not freeze the target branch.
If policy requires an exact target or merge-result check, use a supported protected merge queue/train or
other server-enforced condition; otherwise report strict merge support unavailable. A fresh read alone
does not make that condition atomic.

Wait for permitted conditions inside the executor if requested, but recheck grant expiry, revocation
and refs before dispatch. Do not enable provider auto-merge unless the provider enforces all selected
conditions and the grant explicitly covers that deferred action. Verify the merged state and resulting
commit. Never automatically merge another repository as a side effect.

### Crash and network recovery

Use stable operation IDs and store dispatch intent before side effects. After a lost response, inspect
local refs or the provider to determine whether the intended operation happened. Reconcile to the same
result; do not blindly retry a create request. If a provider lacks idempotency and the outcome cannot be
established uniquely, stop as `outcome_unknown` for a human decision.

Repeating a known operation ID returns its confirmed receipt or resumes reconciliation. Starting a new
operation against an already consumed permission is denied. This separates safe recovery from replay.

A deterministic branch/commit/MR lookup and provider receipts can support recovery, but must not be sold
as universal exactly-once delivery. Unsupported races and ambiguous results remain visible blockers.
Revocation and dispatch have a documented ordering point in the authority; it cannot recall a network
request already dispatched.

## 9. CLI and API surface

Proposed command shapes, to finalize alongside parser/API tests:

| Command | Purpose and authority |
|---|---|
| `stet publication prepare --file <plan.json> --json` | Validate and save a plan revision; agent allowed; no grant or remote writes. |
| `stet publication show <id> --json` | Show the plan, protection mode, grant state, blockers and operation receipts. |
| `stet gate --plan <id> --action commit\|push\|mr\|merge --json` | Evaluate current eligibility without dispatch. |
| `stet publish --plan <id> --through commit\|push\|mr --json` | Request the bounded chain; executor rechecks every permitted step. |
| `stet publish --plan <merge-plan-id> --through merge --json` | Execute only the separately authorized merge plan. |
| `stet publication revoke <id>` | Reviewer-authorized revocation; protected mode requires the authority's authenticated channel. |
| `stet doctor --approval --json` | Diagnose enrollment, identity, active integrations, protection mode and missing enforcement. |

Use additive versioned DTOs rather than changing `lastSubmission.verdict` or the existing `wait`
contract into a permission token. `status` can link to publication state and summarize blockers.

Equivalent API operations should separate plan preparation/inspection, grant issuance/revocation and
execution. Accept expected version/plan/review revisions for writes. Require authenticated capability
checks server-side; never trust a client-supplied `role: reviewer`. In protected mode, agent requests
cannot reach a grant-issuing handler through the ordinary API token, CLI override or alternate endpoint.

An API/client receiving an unknown schema or action must deny execution. Keep stderr/JSON output useful
for automation without parsing human prose, secret-bearing payloads or raw database rows.

## 10. Agent and helper integrations

Use thin adapters around the same gate and executor; do not duplicate approval logic in each hook.
Support Codex and Claude first, with a documented adapter contract for other runtimes.

- Tool hooks identify direct commit/push/MR/merge attempts and route them to the structured executor or
  deny them with the plan and blocker. Cover compound commands, `git -C`, wrappers and relevant API/MCP
  paths. Regex matching command text is an additional check, not the protected security boundary.
- Git `pre-commit`/`pre-push` checks protect ordinary local workflows and provide useful explanations.
  Document disabling hooks, `--no-verify`, alternate binaries and direct ref/API operations as bypasses
  in local mode. Do not block Stet's own internal snapshot operations as authored commits.
- Integrate publication helpers at their actual side-effect boundaries, including auto-push, metadata
  rewriting and dry-run behavior. Test with a helper that pushes before checking `--dry-run`.
- Update the shipped agent skill: approval is read from Stet, the agent cannot mint it, nits leave
  publication blocked until final confirmation, and execution goes through the plan. Do not require the
  model to remember to invoke a check for the only protection to work.
- Installation must report which active runtime/configuration layer it changed, preserve existing hooks
  and distinguish configured, trusted, loaded and actually tested integration. Generated host-runtime
  configuration should be changed through its owning integration, not by patching a disposable copy.

OpenAI documents `PreToolUse` interception, incomplete tool-path coverage and cases where callback
errors/timeouts or malformed output do not block a call. Therefore a hook adapter must translate gate
failures into supported denials, test the actual harness and still rely on credential/ref isolation for
protected execution. See [OpenAI Hooks documentation](https://learn.chatgpt.com/docs/hooks).

`doctor` should test harmless fixture operations, never submit a real review or push a real branch to
"check" protection. It must disclose a missing or bypassable boundary and avoid a misleading green
"protected" result based only on finding a hook configuration file.

## 11. Protected deployment and executor hardening

The protected architecture has three roles:

| Role | May do | Must not be able to do |
|---|---|---|
| Author/agent client | Edit allowed source, prepare plans, create review versions through allowed APIs, reply, inspect permitted state, request execution. | Issue/revoke human grants, change authority policy, access publisher credentials, mutate governed branch refs or control the trusted approval session. |
| Human approval authority | Authenticate the reviewer, render the bound action summary, grant/revoke, maintain the authoritative ledger. | Treat author-controlled role strings, local DB edits or a copied shared bearer as human authentication. |
| Publisher executor | Validate authority state, freeze candidates, update governed refs and call narrowly scoped provider operations. | Run arbitrary agent/repository commands with its credentials or bypass failed preconditions. |

Keep governed Git metadata outside the agent's write access. Where the agent needs staging, snapshot
or worktree management, expose narrow service operations or a separate author-side index and transfer
only verified immutable candidates. Do not leave a writable `.git` escape hatch for compatibility and
still claim that local commits are protected. Read-only metadata views must preserve ordinary build/Git
read requirements; enrollment verifies the actual filesystem and process boundary.

Sanitize executor environment and Git configuration. Repository hooks, filters, custom signing commands,
SSH commands, replacement objects and credential helpers must not turn a trusted Git operation into
arbitrary repository-controlled execution. Use fixed argv, trusted configuration and signing/credential
services. Enforce provider/ref allowlists and least-privilege credentials. Build/test processes never
inherit publisher credentials merely because their results appear in the plan.

Protect the authority UI from untrusted review content using the existing rendering/server safeguards
plus separate authentication, session and capability tests. Pairing and authority enrollment are explicit
human setup actions. Do not silently change OS users, global sandbox policy or existing credential stores
when installing a local Stet update.

Reference implementation acceptance requires an actual isolated environment, not only mocks. The agent
identity must fail to read signing/provider secrets, alter the authority store/configuration, control
the trusted reviewer session, write governed refs or publish through direct Git/API/MCP alternatives.
Only then enable the **Protected approval** label for the tested platform/adapter combination.

## 12. Compatibility and migration

- Default existing installations to review-only behavior. Enrollment into publication control is explicit.
  Local and protected modes display their different guarantees.
- Add migrations for plans, grants/revocations and executions; keep existing submissions and export
  history readable. Old approvals do not acquire publication scopes automatically.
- A human may authorize an existing unchanged version through the new card without recreating its code
  diff. Verify its current candidate and present the exact new action plan first.
- Preserve ordinary reviewer CLI and review-only TUI behavior in local mode. In protected mode, those
  role selectors do not create protected grants without independent authentication.
- Retain existing `wait: approved` semantics for the review loop. Add explicit publication eligibility
  instead of silently changing it and breaking consumers; update documentation and the skill together.
- Pin the minimum API/schema/policy version in protected enrollment. An older client, missing adapter,
  unsupported platform or unavailable authority cannot silently downgrade a governed operation.
- Review close/prune/backup operations must retain objects and receipts required by live grants or
  audit policy. Remove stale authorizations explicitly, not as an incidental cleanup side effect.
- Multiple worktrees share review history where appropriate, but plans are bound to the actual enrolled
  source/ref and candidate. Another worktree, clone, fork or reused branch name does not inherit them.
- Multi-repository tasks use separate plans/grants and receipts per repository. A parent task may show
  their status, but one repository's approval cannot approve a library or application elsewhere.

## 13. Implementation work packages

Each package should be independently reviewable. Do not combine a new security boundary, all UI work
and all provider integration into one opaque diff. This list is a proposed work breakdown, not permission
to implement or publish those changes.

| Package | Deliverable and rationale | Dependencies | Completion evidence |
|---|---|---|---|
| P0 Current behavior fixtures | Pin stale/dirty approval, cached/pinned `now`, nits, settled instructions, partial staging and same-user role behavior. | None | Focused regression tests explain the distinction between code verdict and publication permission. |
| P1 Evaluator and records | Versioned plans/grants/executions, identity binding, pure decision rules plus fresh evidence capture, reason codes and CLI gate. | P0 | No grant denies; exact authorized candidate passes; stale, partial, unreadable and wrong-ref cases deny. No publication occurs in inspection. |
| P2 Consent UI and lifecycle | Publication card, explicit scopes, stale-click checks, metadata previews, expiry, pause/revoke and separate state display. | P1 | Browser/keyboard tests cover intentional consent and nits; existing review-only workflow remains usable. |
| P3 Local structured executor | Single-commit/range flow, fixed operation inputs, branch preconditions, operation reservations/receipts and uncertain-outcome recovery. | P1–P2 | Disposable repositories and a fake provider prove correct artifacts, no hidden staging and no duplicate actions after injected failures. Label remains Local checks. |
| P4 Runtime/helper adapters | Codex/Claude/Git/helper integration, hook failure handling, non-mutating planning, skill update and `doctor`. | P3 | Actual runtime fixture tests distinguish configured hooks from effective blocking and report bypasses. |
| P5 Protected authority/executor | Independent reviewer authentication, isolated ledger/policy/credentials/ref updates, constrained author APIs and a reference OS-isolated deployment. | P1–P4 | Negative tests from the real agent identity prove the boundary. Missing isolation denies protected execution. This is the milestone for the non-forgeable approval claim. |
| P6 Provider and merge support | GitLab project/ref binding, MR recovery, separate merge grants, CI/approval policy and capability handling for source/target races. | P3; P5 for protected guarantees | Provider sandbox tests validate exact-SHA actions, stale approvals, skipped CI, changed refs and ambiguous responses. |
| P7 Compatibility and rollout | Migrations, old/new client behavior, exports, guide screenshots, operator setup/recovery docs and full checks. | Earlier packages | Fresh and upgraded fixtures pass; documented platform coverage and limitations match measured behavior. |

P3 can use a fake provider before real publication integration is ready. Do not mark the full feature
complete after P4: hooks alone leave the trust problem unresolved. Real remote writes during testing
use an explicitly authorized disposable project; normal developer tests use fixtures.

### Likely implementation locations

These are ownership boundaries for later tasks, not files to create blindly.

| Area | Existing integration points and likely additions |
|---|---|
| State and evaluator | `src/core/service.ts`, `src/core/types.ts`, `src/core/context.ts`, new approval/publication core files; avoid spreading the rules across handlers. |
| Storage | `src/core/store/db.ts`, `src/core/store/migrations.ts`; protected authority persistence must not merely reuse the writable local mirror as authority. |
| Candidate capture | `src/core/snapshot.ts`, `src/core/git.ts`, `src/core/gitstate.ts`, `src/core/worktrees.ts`; explicit fresh capture and immutable candidate handling. |
| CLI and API | `src/cli/commands.ts`, `src/cli/args.ts`, `src/server/api.ts`, `src/client/api.ts`; shared DTOs, capability enforcement and expected revisions. |
| UI | `web/views/Drafts.tsx`, existing header/Round state and shared UI models; retain the existing diff/guide surfaces. |
| Executor/adapters | New narrowly scoped publisher/provider/integration components; keep provider credentials and process boundaries out of the ordinary review client. |
| Agent and operator docs | Shipped skill source, `README.md`, `docs/ui.md`, `docs/guide`, `SECURITY.md`, and protected-deployment documentation. |
| Verification | Extend approval/security/staged/concurrency/client/UI tests; add focused gate, executor, recovery and isolated-enforcement suites. |

## 14. Verification and acceptance matrix

| Scenario | Required result |
|---|---|
| No review/version/grant, or review approved without publication scopes | No governed operation; precise blocker. |
| Latest exact version with correct operation, metadata, refs and valid authority | Only that operation or explicitly selected bounded chain succeeds. |
| A new version arrives, even with identical bytes | Previous version-bound grant does not silently transfer. |
| Worktree changes without a version | Fresh gate catches it despite standing approval or cached/pinned UI state. |
| Snapshot fails or `now` is unavailable | Deny; never infer unchanged from absent evidence. |
| Partial staging in worktree mode | Deny mismatch; do not stage or discard files automatically. |
| Index mode with unrelated unstaged files | Publish only the approved frozen index; keep unrelated work outside the operation. |
| Excluded tracked content or newly staged large/secret-looking file | Deny incomplete/mismatched candidate; never quietly publish omitted content. |
| Binary, executable bit, symlink, deletion or submodule pointer changes | Compare complete tree semantics; refuse unsupported object/publication formats. |
| Unreviewed intermediate commit removed at tip | Deny publication of the unapproved reachable history. |
| Nits, `fixed` replies, settled messages or forced-open threads | No implicit permission for edited content or unfinished instructions; explicit waiver/final consent required as specified. |
| Reviewer has an old tab; version/plan changes before click | Stale submission rejected; show delta without automatically approving new content. |
| Commit message, attribution, MR body, reviewers, remote or target changes | Affected action blocked until its plan revision is authorized. |
| Same branch name in another clone/fork/worktree | No permission inheritance; verify enrolled identity and candidate. |
| Two executors, concurrent staging/ref changes or helper auto-push | Serialize/check expected values; no unchecked side effect or duplicate execution. |
| Direct Git/API/MCP call, wrapper, `--no-verify`, changed hooks or role override | Local mode reports the bypass limits; protected mode prevents governed writes independently of command spelling. |
| Agent edits local DB/mirror or copies a local token | Cannot create a protected grant or change authoritative grant state. |
| Agent tries protected browser automation or session access | Cannot authenticate the human decision or activate the trusted approval channel. |
| Authority unavailable, hook timeout/crash, bad JSON or unknown schema | Gate/executor deny; runtime hook limitations are detected rather than advertised away. |
| Grant expires, is paused/revoked, or changes are requested | No future dispatch; already-dispatched work is reconciled and reported. |
| Network fails before/after remote success, process crashes after ref update | Recover the same result or stop as unknown; no blind duplicate MR, commit or push. |
| CI is green for another SHA, MR pipeline is skipped, provider permits unchecked merge | Enforce the plan's exact candidate/check policy; provider `mergeable` alone cannot pass it. |
| Source/target advances during MR creation or merge | Enforce supported server-side/exclusive-writer conditions; reject unsupported strict guarantees. |
| Upgrade, downgrade, backup restore, prune or review close | No accidental new authority, revived grant, missing live evidence or silent downgrade. |
| Large diff and many review versions | Consent uses existing diff/interdiff; gate avoids rendering/loading full diffs to validate identities. |

Measure gate latency on the existing large-repository/performance fixtures. Do not invent a latency
claim before measurement. Reuse Git object identities and incremental evidence safely, but never reuse
a cached eligibility decision across dispatch. Log timings without code content or secrets.

Implementation validation should follow [Contributing](../CONTRIBUTING.md): targeted suites while
building each package; then typecheck and relevant full tests. UI changes need the real Firefox
`ui-check` and updated guide screenshots. Security-boundary changes need real isolated-runtime tests
in addition to unit tests. Broaden checks when the changed scope or a failure warrants it.

## 15. Decisions to settle before protected implementation

The functional contract above should not be reopened implicitly during coding. Resolve these platform
questions in the P5 design and record the selected deployment:

1. The supported isolated reference environment: service principal, source/metadata sharing, staging
   proxy and compatibility with the actual agent host. Same-user unrestricted execution cannot satisfy
   the protected claim without changing that environment.
2. The reviewer authentication and human-presence boundary, including what browser/TUI automation the
   agent can access. Pairing must not expose an equivalent approval capability to the author client.
3. The provider capability matrix: exclusive branch writer, source-SHA preconditions, target/merge-result
   guarantees, credential scope and ambiguous-operation reconciliation on the deployed GitLab version.
4. Organizational policy for required CI, approval freshness, grant lifetime, thread waivers and audit
   retention. These are trusted enrollment settings, not agent-editable repository overrides.

No implementation may replace an unresolved requirement with a silent permissive default. Local mode
can still ship with accurately stated limits while the protected adapter remains unavailable.

## 16. Definition of complete

A human can review and authorize publication entirely in Stet; the exact artifact and action metadata
are bound to their consent; later changes block remaining execution; every completed operation has a
receipt; revocation and uncertain outcomes behave predictably; existing review-only users can continue
without a publisher.

For **Protected approval**, an agent that ignores every workflow instruction must still be unable to
mint the human grant or perform the governed operation through another route. This must be demonstrated
in the actual supported environment. A successful happy-path hook test is not enough.
