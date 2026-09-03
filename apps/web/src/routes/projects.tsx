import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DeleteProject, StatusMessage, TextField } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";

/**
 * #78 — the Sprouts list, the way Cloudflare's Workers & Pages lists
 * applications: one row per sprout carrying its route, its traffic and a way
 * into its own deployments. The account-wide deployments page is gone; a
 * version list only makes sense inside the sprout it belongs to.
 */
export const Route = createFileRoute("/projects")({
  component: Projects,
  head: () => ({ meta: [{ title: "Sprouts · Sproutboat" }] }),
});

function Projects() {
  const { data, error, refresh } = useOverview();
  const [removed, setRemoved] = useState("");
  const [query, setQuery] = useState("");

  const needle = query.trim().toLowerCase();
  const projects = (data?.projects ?? [])
    .filter((project) => !needle || `${project.name} ${project.hostname}`.toLowerCase().includes(needle));

  return (
    <>
      <section className="product-heading">
        <div>
          <h1>Sprouts</h1>
          <p>Every project serving a route from this box. Deploy one with <code>sproutboat deploy</code>.</p>
        </div>
      </section>

      {removed && <StatusMessage tone="success">Deleted {removed} and every deployed version.</StatusMessage>}

      {error ? (
        <p className="form-error" role="alert">Could not load sprouts. Refresh and try again.</p>
      ) : data?.projects.length ? (
        <section>
          <div className="sprout-search">
            <TextField label="Search sprouts" hideLabel type="search" fieldClassName="grow"
              placeholder="Search sprouts…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>

          {projects.length === 0 ? (
            <p className="empty-state">Nothing matches “{query.trim()}”.</p>
          ) : (
            <ul className="sprout-cards" aria-label="Sprouts">
              {projects.map((project) => (
                <li key={project.name} className="sprout-card">
                  {/* The name's ::after covers the card, so the whole surface
                      opens the sprout while the a11y tree keeps one link. Every
                      other control sits above it on its own stacking context. */}
                  <div className="sprout-card-head">
                    <div className="sprout-main">
                      <Link className="sprout-name" to="/projects/$name" params={{ name: project.name }}>
                        {project.name}
                      </Link>
                      <small>
                        <a className="sprout-route" href={`https://${project.hostname}`}>{project.hostname}</a>
                        {(project.domains ?? 0) > 0 && ` + ${project.domains} custom domain${project.domains === 1 ? "" : "s"}`}
                      </small>
                    </div>
                    <span className="sprout-deployed">{relativeTime(project.deployedAt)}</span>
                    <div className="sprout-card-actions">
                      <DeleteProject name={project.name} triggerLabel="Delete" triggerVariant="quiet"
                        onDeleted={() => { setRemoved(project.name); void refresh(); }} />
                    </div>
                  </div>

                  <div className="sprout-card-foot">
                    <Link className="text-link sprout-deployments" to="/projects/$name/deployments" params={{ name: project.name }}>
                      View deployments →
                    </Link>
                    <div className="sprout-stats">
                      <span>{project.versions ?? 0} version{project.versions === 1 ? "" : "s"}</span>
                      <span>{(project.requests24h ?? 0).toLocaleString()} requests</span>
                      <span>{project.latencyP50 ? `${project.latencyP50} ms` : "—"} p50</span>
                      {(project.errors24h ?? 0) > 0 && <span className="sprout-errors">{project.errors24h} errors</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section className="data-panel">
          <div className="empty-state">
            <h2>Deploy your first sprout</h2>
            <p>Deploy from a project directory and its route, version history and traffic appear here.</p>
            <code>sproutboat deploy hello</code>
          </div>
          <ol className="deploy-steps">
            <li><code>sproutboat init hello</code></li>
            <li><code>sproutboat login</code></li>
            <li><code>sproutboat deploy hello</code></li>
          </ol>
        </section>
      )}
    </>
  );
}
