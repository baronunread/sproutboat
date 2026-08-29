import { createFileRoute, Link } from "@tanstack/react-router";
import { relativeTime, useProject } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name/deployments")({ component: ProjectDeployments });

function ProjectDeployments() {
  const { name, deployments } = useProject();
  return (
    <section className="data-panel">
      <div className="panel-heading"><div><h2>Deployments</h2><p>Every immutable version, newest first.</p></div></div>
      <ul className="record-list deployment-list">
        {deployments.map((deployment) => (
          <li key={deployment.id}>
            <div>
              <Link className="record-title" to="/projects/$name/deployments/$id" params={{ name, id: deployment.id }}>{deployment.id.slice(0, 8)}</Link>
              <small>{deployment.hostname}</small>
            </div>
            <code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code>
            <span>{relativeTime(deployment.deployedAt)}</span>
            <b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b>
          </li>
        ))}
      </ul>
    </section>
  );
}
