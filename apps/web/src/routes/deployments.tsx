import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Shell } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";
import { EmptyDeployment } from "./index";

export const Route = createFileRoute("/deployments")({ component: Deployments, head: () => ({ meta: [{ title: "Deployments · Sproutboat" }] }) });
function Deployments() {
  const { data, state, refresh } = useOverview();
  const [rollingBack, setRollingBack] = useState<string>();
  const [error, setError] = useState("");
  const rollback = async (project: string, id: string) => {
    if (!confirm(`Roll back ${project} to this deployment?`)) return;
    setError(""); setRollingBack(id);
    const response = await fetch(`/api/projects/${encodeURIComponent(project)}/deployments/${encodeURIComponent(id)}/activate`, { method: "POST", credentials: "include" });
    setRollingBack(undefined);
    if (!response.ok) return setError("Rollback failed. Refresh and try again.");
    await refresh();
  };
  return <Shell><section className="page-heading"><div><h1>Deployments</h1><p>Immutable artifacts, ordered by their deployment time.</p></div></section>{error || state === "error" ? <p className="form-error" role="alert">{error || "Could not load deployments. Refresh and try again."}</p> : data?.deployments.length ? <section className="data-panel"><ul className="record-list deployment-list">{data.deployments.map((deployment) => <li key={deployment.id}><div><strong>{deployment.project}</strong><small>Deployment {deployment.id.slice(0, 8)} · {deployment.hostname}</small></div><code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code><span>{relativeTime(deployment.deployedAt)}</span><b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b>{deployment.active ? <span /> : <button className="rollback-button" type="button" disabled={rollingBack === deployment.id} onClick={() => void rollback(deployment.project, deployment.id)}>{rollingBack === deployment.id ? "Rolling back…" : "Roll back"}</button>}</li>)}</ul></section> : <section className="data-panel"><EmptyDeployment /><ol className="deploy-steps"><li><code>sproutboat init hello</code></li><li><code>sproutboat login</code></li><li><code>sproutboat deploy hello</code></li></ol></section>}</Shell>;
}
