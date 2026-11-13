import { useEffect, useRef, useState } from "preact/hooks";
import type { PublicationView } from "../../src/core/publication/types.ts";
import { api } from "../api.ts";
import { drafts, gitInfo, guard, nowState, notify, reviewId, status } from "../state.ts";

/** Prepared actions appear only after the author supplies a publication plan. Nothing is preselected. */
export function PublicationCard() {
  const rid = reviewId.value;
  const seq = status.value?.lastSeq;
  const now = nowState.value;
  const git = gitInfo.value;
  const [view, setView] = useState<PublicationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedDigest, setSelectedDigest] = useState<string | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);

  const refresh = async () => {
    const n = ++request.current;
    if (rid === null) return;
    setLoading(true);
    try {
      const data = await api.publication(rid);
      if (n !== request.current) return;
      setView(data?.plan?.id ? data : null);
      setError("");
    } catch {
      if (n === request.current) setError("Publication state is unavailable. Refresh before authorizing any action.");
    } finally {
      if (n === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => { request.current++; };
  }, [rid, seq, now, git]);

  if (error) return <section class="publication-card"><h3>Publication</h3><p role="alert">{error}</p><button class="btn" onClick={() => void refresh()}>Refresh publication</button></section>;
  if (!view || view.plan.review !== rid) return null;
  const { plan: p, grant, decision, receipts, paused } = view;
  const selected = selectedDigest === p.digest;
  const receipt = receipts[0];
  const granted = decision.allowed;
  const latest = status.value?.latest?.number;
  const blockers = decision.blockers.filter((b) => !["no_grant", "grant_expired", "grant_revoked"].includes(b.code) && !(b.code === "approval_stale" && latest === p.version));
  const canAuthorize = !loading && !busy && !paused && !receipt && !blockers.length && !drafts.value.length && latest === p.version;
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      if (await guard(action())) {
        notify(message);
        setSelectedDigest(null);
      }
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <section class="publication-card" aria-label="Publication permissions" aria-busy={loading || busy} onKeyDown={(e) => {
      // The Drafts keymap binds Enter and Space too. Keep intentional control activation here.
      if (e.key !== "Enter" && e.key !== " ") return;
      const control = (e.target as Element).closest<HTMLElement>("button, input, summary, a");
      if (!control) return;
      e.stopPropagation();
      if (control.tagName === "BUTTON" || (control instanceof HTMLInputElement && control.type === "checkbox" && e.key === " ")) {
        e.preventDefault();
        if (!e.repeat) control.click();
      }
    }}>
      <div class="publication-heading"><h3>Publication</h3><span class="badge">Local checks</span></div>
      <p class="note">These checks prevent mistakes in Stet's executor. Processes running as your OS user can bypass them. Protected approval is unavailable.</p>
      <p><b>Reviewed v{p.version}</b> · {p.source === "index" ? "staged changes" : "working tree"} · branch <code>{p.ref.slice(11)}</code></p>
      <div class="publication-status" role="status">
        {loading ? "Checking current content…" : receipt ? `Commit ${receipt.state}${receipt.commit ? ` · ${receipt.commit.slice(0, 10)}` : ""}`
          : paused ? "Publication paused" : granted ? "Authorized: one commit" : grant?.revokedAt ? "Permission revoked"
          : decision.blockers.some((b) => b.code === "grant_expired") ? "Permission expired" : "Publication blocked"}
      </div>
      {grant ? <p class="note">Permission expires {new Date(grant.expiresAt).toLocaleString()}.{grant.revokedAt ? " Revoked." : ""}</p> : <p class="note">Code approval grants no publication permission.</p>}
      <details open>
        <summary>Exact commit message and attribution</summary>
        <pre class="publication-message">{p.commit.message}</pre>
        <p>Author: {p.commit.author.name} &lt;{p.commit.author.email}&gt;<br />Committer: {p.commit.committer.name} &lt;{p.commit.committer.email}&gt;</p>
        <p class="note">Unsigned commit · timestamps set at execution · parent {p.head?.slice(0, 10) ?? "none (first commit)"}</p>
      </details>
      {!loading && decision.blockers.length ? <ul class="publication-blockers">{decision.blockers.map((b, i) => <li key={`${b.code}-${i}`}><b>{b.message}</b> {b.remedy}</li>)}</ul> : null}
      {drafts.value.length ? <p class="note">Submit your drafts before authorizing publication.</p> : null}
      {receipt?.detail ? <p class="note">{receipt.detail}</p> : null}
      {!receipt && !granted ? <>
        <label class="publication-scope"><input type="checkbox" checked={selected} disabled={loading || busy || paused} onChange={(e) => setSelectedDigest(e.currentTarget.checked ? p.digest : null)} /> Allow one commit with the message and attribution above</label>
        <p class="note">No push, MR or merge permission. Permission lasts 24 hours and stops if the review changes.</p>
        <button class="btn approve" disabled={!selected || !canAuthorize} onClick={() => void run(
          () => api.authorizePublication(p.id, { digest: p.digest, versionId: p.versionId, revision: decision.revision }, ["commit"]),
          `approved v${p.version} and authorized one commit`,
        )}>Approve v{p.version} and authorize commit</button>
      </> : null}
      {!receipt || receipt.state !== "confirmed" ? <div class="publication-controls">
        <button class="btn" disabled={busy || loading} onClick={() => void run(() => api.pausePublication(rid!, !paused), paused ? "publication resumed; fresh authorization is required" : "publication paused")}>{paused ? "Resume publication" : "Pause publication"}</button>
        {grant && !grant.revokedAt ? <button class="btn danger" disabled={busy || loading} onClick={() => void run(() => api.revokePublication(p.id), "publication permission revoked")}>Revoke permission</button> : null}
        <button class="btn" disabled={busy || loading} onClick={() => void refresh()}>Refresh publication</button>
      </div> : null}
    </section>
  );
}
