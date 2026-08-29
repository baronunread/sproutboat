import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { relativeTime, useProject } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name/deployments_/$id")({
  component: DeploymentDetail,
  head: ({ params }) => ({ meta: [{ title: `${params.id.slice(0, 8)} · ${params.name} · Sproutboat` }] }),
});

type Manifest = {
  schemaVersion: number; target: string; runtime: string; capabilityProfile: string;
  porfforVersion: string; esbuildVersion: string; buildImage: string;
  sourceHash: string; binaryHash: string; binarySize: number; builtAt: string;
};
type Detail = {
  id: string; hostname: string; artifact: string; deployedAt: string; active: boolean;
  manifest: Manifest | null; manifestError: string | null;
};

function DeploymentDetail() {
  const { name, id } = Route.useParams();
  const { refresh } = useProject();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail>();
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [busy, setBusy] = useState<"" | "rollback" | "delete">("");
  const [error, setError] = useState("");

  const base = `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(base, { credentials: "include" });
      if (response.status === 404) { setState("missing"); return; }
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx from the deployment-detail endpoint is the Detail contract.
      setDetail(await response.json() as Detail);
      setState("ready");
    } catch { setState("error"); }
  }, [base]);
  useEffect(() => { void load(); }, [load]);

  const rollback = async () => {
    setError(""); setBusy("rollback");
    try {
      const response = await fetch(`${base}/activate`, { method: "POST", credentials: "include" });
      if (!response.ok) { setBusy(""); setError("Rollback failed. Refresh and try again."); return; }
      await Promise.all([load(), refresh()]);
      setBusy("");
    } catch { setBusy(""); setError("Could not reach the control plane. Try again."); }
  };

  const remove = async () => {
    if (!confirm("Delete this superseded version? Its artifact is removed if nothing else references it.")) return;
    setError(""); setBusy("delete");
    try {
      const response = await fetch(base, { method: "DELETE", credentials: "include" });
      if (!response.ok) {
        setBusy("");
        setError(response.status === 409 ? "This is the active version — roll back or replace it before deleting." : "Delete failed. Refresh and try again.");
        return;
      }
      await refresh();
      void navigate({ to: "/projects/$name/deployments", params: { name } });
    } catch { setBusy(""); setError("Could not reach the control plane. Try again."); }
  };

  return (
    <>
      <p className="crumb"><Link to="/projects/$name/deployments" params={{ name }}>Deployments</Link> <span>/</span> {id.slice(0, 8)}</p>

      {state === "loading" ? (
        <section className="data-panel loading-state" aria-live="polite">Loading deployment…</section>
      ) : state === "missing" ? (
        <section className="data-panel empty-state">
          <h2>Deployment not found</h2>
          <p>This version may have been deleted.</p>
          <Link className="button primary" to="/projects/$name/deployments" params={{ name }}>Back to deployments</Link>
        </section>
      ) : state === "error" || !detail ? (
        <p className="form-error" role="alert">Could not load this deployment. Refresh and try again.</p>
      ) : (
        <>
          <section className="data-panel settings-panel">
            <h2>
              Version {detail.id.slice(0, 8)}{" "}
              <b className={detail.active ? "status live" : "status"}>{detail.active ? "Active" : "Superseded"}</b>
            </h2>
            <dl className="detail-grid">
              <div><dt>Deployment ID</dt><dd><code>{detail.id}</code></dd></div>
              <div><dt>Route</dt><dd><code>{detail.hostname}</code></dd></div>
              <div><dt>Artifact digest</dt><dd><code>{detail.artifact}</code></dd></div>
              <div><dt>Deployed</dt><dd>{new Date(detail.deployedAt).toLocaleString()} · {relativeTime(detail.deployedAt)}</dd></div>
            </dl>
          </section>

          <section className="data-panel settings-panel">
            <h2>Artifact manifest</h2>
            {detail.manifest ? (
              <dl className="detail-grid">
                <div><dt>Schema version</dt><dd>{detail.manifest.schemaVersion}</dd></div>
                <div><dt>Target</dt><dd><code>{detail.manifest.target}</code></dd></div>
                <div><dt>Runtime</dt><dd><code>{detail.manifest.runtime}</code></dd></div>
                <div><dt>Capability profile</dt><dd><code>{detail.manifest.capabilityProfile}</code></dd></div>
                <div><dt>Porffor</dt><dd><code>{detail.manifest.porfforVersion}</code></dd></div>
                <div><dt>esbuild</dt><dd><code>{detail.manifest.esbuildVersion}</code></dd></div>
                <div><dt>Build image</dt><dd><code>{detail.manifest.buildImage}</code></dd></div>
                <div><dt>Source hash</dt><dd><code>{detail.manifest.sourceHash}</code></dd></div>
                <div><dt>Binary hash</dt><dd><code>{detail.manifest.binaryHash}</code></dd></div>
                <div><dt>Binary size</dt><dd>{detail.manifest.binarySize.toLocaleString()} bytes</dd></div>
                <div><dt>Built</dt><dd>{new Date(detail.manifest.builtAt).toLocaleString()}</dd></div>
              </dl>
            ) : (
              <p className="form-status">Artifact metadata is unavailable{detail.manifestError ? `: ${detail.manifestError}` : "."}</p>
            )}
          </section>

          <section className="data-panel settings-panel">
            <h2>Actions</h2>
            {detail.active ? (
              <p className="form-status">The active version can't be rolled back or deleted. Roll back another version, or replace it with a new deploy.</p>
            ) : (
              <div className="danger-confirm-row">
                <button type="button" className="button quiet" disabled={busy !== ""} onClick={() => void rollback()}>
                  {busy === "rollback" ? "Rolling back…" : "Roll back to this version"}
                </button>
                <button type="button" className="button danger" disabled={busy !== ""} onClick={() => void remove()}>
                  {busy === "delete" ? "Deleting…" : "Delete version"}
                </button>
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </section>
        </>
      )}
    </>
  );
}
