import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, PanelHeading, SelectField, TextField } from "../components";
import { relativeTime, useProject } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name/deployments")({ component: ProjectDeployments });

const STATE_OPTIONS = [["all", "All versions"], ["active", "Active"], ["superseded", "Superseded"]] as const;
const PAGE = 20;

function ProjectDeployments() {
  const { name, deployments } = useProject();
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const needle = query.trim().toLowerCase();
  const matching = deployments.filter((deployment) => {
    if (status === "active" && !deployment.active) return false;
    if (status === "superseded" && deployment.active) return false;
    if (!needle) return true;
    return `${deployment.id} ${deployment.artifact} ${deployment.hostname}`.toLowerCase().includes(needle);
  });
  const visible = matching.slice(0, shown);

  return (
    <section className="data-panel">
      <PanelHeading
        title="Deployments"
        description={`${deployments.length} immutable version${deployments.length === 1 ? "" : "s"}, newest first.`}
      />

      <div className="log-filters">
        <SelectField label="State" value={status} options={STATE_OPTIONS}
          onChange={(event) => { setStatus(event.target.value); setShown(PAGE); }} />
        <TextField label="Search" type="search" fieldClassName="grow" placeholder="Match version id, artifact digest or hostname"
          value={query} onChange={(event) => { setQuery(event.target.value); setShown(PAGE); }} />
      </div>

      {matching.length === 0 ? (
        <p className="empty-state">No versions match these filters.</p>
      ) : (
        <>
          <ul className="record-list deployment-list">
            {visible.map((deployment) => (
              <li key={deployment.id}>
                <div>
                  <Link className="record-title" to="/projects/$name/deployments/$id" params={{ name, id: deployment.id }}>
                    {deployment.id.slice(0, 8)}
                  </Link>
                  <small>{deployment.hostname}</small>
                </div>
                <code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code>
                <span>{relativeTime(deployment.deployedAt)}</span>
                <b className={deployment.active ? "status live" : "status"}>{deployment.active ? "Active" : "Superseded"}</b>
              </li>
            ))}
          </ul>
          {matching.length > visible.length && (
            <div className="form-actions start pager-actions">
              <Button variant="quiet" onClick={() => setShown((current) => current + PAGE)}>
                Show more ({matching.length - visible.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
