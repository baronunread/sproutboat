import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ConfirmButton, Shell, StatusMessage } from "../components";
import { mutate, relativeTime, useOverview } from "../dashboard-data";
import { EmptyDeployment } from "./index";

export const Route = createFileRoute("/deployments")({
  component: Deployments,
  head: () => ({ meta: [{ title: "Deployments · Sproutboat" }] }),
});

function Deployments() {
  const { data, state, refresh } = useOverview();
  const [error, setError] = useState("");

  const rollback = async (project: string, id: string) => {
    setError("");
    const failure = await mutate(
      `/api/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}/activate`,
      { method: "POST" },
    );
    if (failure) { setError(failure); return; }
    await refresh();
  };

  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Deployments</h1><p>Immutable artifacts across every project, newest first.</p></div>
      </section>

      {error && <StatusMessage tone="error">{error}</StatusMessage>}

      {state === "error" ? (
        <p className="form-error" role="alert">Could not load deployments. Refresh and try again.</p>
      ) : data?.deployments.length ? (
        <section className="data-panel">
          <ul className="record-list deployment-list">
            {data.deployments.map((deployment) => (
              <li key={deployment.id}>
                <div>
                  <Link className="record-title" to="/projects/$name/deployments/$id"
                    params={{ name: deployment.project, id: deployment.id }}>{deployment.project}</Link>
                  <small>Deployment {deployment.id.slice(0, 8)} · {deployment.hostname}</small>
                </div>
                <code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code>
                <span>{relativeTime(deployment.deployedAt)}</span>
                <b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b>
                {deployment.active ? <span /> : (
                  <ConfirmButton
                    label="Roll back"
                    busyLabel="Rolling back…"
                    variant="quiet"
                    title={`Roll back ${deployment.project}?`}
                    description={<>Version <code>{deployment.id.slice(0, 8)}</code> starts serving <code>{deployment.hostname}</code> immediately, and the current active version becomes superseded.</>}
                    confirmLabel="Roll back"
                    onConfirm={() => rollback(deployment.project, deployment.id)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="data-panel">
          <EmptyDeployment />
          <ol className="deploy-steps">
            <li><code>sproutboat init hello</code></li>
            <li><code>sproutboat login</code></li>
            <li><code>sproutboat deploy hello</code></li>
          </ol>
        </section>
      )}
    </Shell>
  );
}
