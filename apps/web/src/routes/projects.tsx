import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DeleteProject, Shell } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";
import { EmptyDeployment } from "./index";

export const Route = createFileRoute("/projects")({ component: Projects, head: () => ({ meta: [{ title: "Projects · Sproutboat" }] }) });

function Projects() {
  const { data, error, refresh } = useOverview();
  const [removed, setRemoved] = useState("");

  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Projects</h1><p>Each active deployment owns one routed project.</p></div>
      </section>
      {removed && <p className="form-status" role="status">Deleted {removed} and every deployed version.</p>}
      {error ? (
        <p className="form-error" role="alert">Could not load projects. Refresh and try again.</p>
      ) : data?.projects.length ? (
        <section className="data-panel">
          <ul className="record-list">
            {data.projects.map((project) => (
              <li key={project.name}>
                <div>
                  <Link className="record-title" to="/projects/$name" params={{ name: project.name }}>{project.name}</Link>
                  <small>{project.hostname}</small>
                </div>
                <span>Deployed {relativeTime(project.deployedAt)}</span>
                <Link className="text-link" to="/projects/$name" params={{ name: project.name }}>Open project</Link>
                <DeleteProject name={project.name} triggerLabel="Delete" triggerVariant="quiet"
                  onDeleted={() => { setRemoved(project.name); void refresh(); }} />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="data-panel">
          <EmptyDeployment />
          <Link className="button primary" to="/deployments">Deployment guide</Link>
        </section>
      )}
    </Shell>
  );
}
