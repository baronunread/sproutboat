import { createFileRoute } from "@tanstack/react-router";
import { relativeTime, useProject } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name/")({ component: ProjectOverview });

function ProjectOverview() {
  const { deployments, active } = useProject();
  const activeVersion = deployments.find((deployment) => deployment.active);
  return (
    <section className="data-panel settings-panel">
      <h2>Overview</h2>
      <dl className="detail-grid">
        <div><dt>Route</dt><dd>{active ? <a className="text-link" href={`https://${active.hostname}`}>{active.hostname}</a> : "Not serving — every version is superseded"}</dd></div>
        <div><dt>Active version</dt><dd>{activeVersion ? <code>{activeVersion.id}</code> : "None"}</dd></div>
        <div><dt>Artifact digest</dt><dd>{activeVersion ? <code>{activeVersion.artifact}</code> : "—"}</dd></div>
        <div><dt>Deployed</dt><dd>{activeVersion ? relativeTime(activeVersion.deployedAt) : "—"}</dd></div>
        <div><dt>Total versions</dt><dd>{deployments.length}</dd></div>
      </dl>
    </section>
  );
}
