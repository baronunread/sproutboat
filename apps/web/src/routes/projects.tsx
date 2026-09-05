import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { DeleteProject, Panel, StatusMessage, TextField } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";
import { EmptyDeployment } from "./index";

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
      <section className="mb-8 flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-border pb-7 [&_h1]:m-0 [&_h1]:flex [&_h1]:items-center [&_h1]:gap-2.5 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&>div>p]:mt-1.5 [&>div>p]:max-w-[44rem] [&>div>p]:text-[0.875rem] [&>div>p]:leading-normal [&>div>p]:text-muted-foreground">
        <div>
          <h1>Sprouts</h1>
          <p>Every project serving a route from this box. Deploy one with <code>sproutboat deploy</code>.</p>
        </div>
      </section>

      {removed && <StatusMessage tone="success">Deleted {removed} and every deployed version.</StatusMessage>}

      {error ? (
        <StatusMessage tone="error">Could not load sprouts. Refresh and try again.</StatusMessage>
      ) : data?.projects.length ? (
        <section>
          <div className="mb-4 max-w-[30rem]">
            <TextField label="Search sprouts" hideLabel type="search" fieldClassName="min-w-0 flex-[1_1_16rem]"
              placeholder="Search sprouts…" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>

          {projects.length === 0 ? (
            <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">Nothing matches “{query.trim()}”.</p>
          ) : (
            <ul className="m-0 grid list-none gap-3 p-0" aria-label="Sprouts">
              {projects.map((project) => (
                <li key={project.name} className="group relative rounded-lg border border-border bg-card transition-[border-color,background] duration-150 hover:border-line-strong hover:bg-accent focus-within:border-sky">
                  {/* The name's ::after covers the card, so the whole surface
                      opens the sprout while the a11y tree keeps one link. Every
                      other control sits above it on its own stacking context. */}
                  <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-start gap-x-4 px-5 py-[1.1rem] max-[640px]:grid-cols-[minmax(0,1fr)_auto]">
                    <div className="[&>small]:mt-1.5 [&>small]:block [&>small]:text-[0.75rem] [&>small]:text-muted-foreground">
                      <Link className="text-[0.95rem] font-semibold tracking-tight after:absolute after:inset-0 after:content-[''] focus-visible:outline-none" to="/projects/$name" params={{ name: project.name }}>
                        {project.name}
                      </Link>
                      <small>
                        <a className="relative z-1 hover:underline hover:underline-offset-2" href={`https://${project.hostname}`}>{project.hostname}</a>
                        {(project.domains ?? 0) > 0 && ` + ${project.domains} custom domain${project.domains === 1 ? "" : "s"}`}
                      </small>
                    </div>
                    <span className="text-[0.75rem] whitespace-nowrap text-muted-foreground tabular-nums max-[640px]:col-start-1">{relativeTime(project.deployedAt)}</span>
                    <div className="relative z-1">
                      <DeleteProject name={project.name} triggerLabel="Delete" triggerVariant="quiet"
                        onDeleted={() => { setRemoved(project.name); void refresh(); }} />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-border px-5 py-3">
                    <Link className="relative z-1 text-[0.78rem] text-sky underline-offset-2 hover:underline" to="/projects/$name/deployments" params={{ name: project.name }}>
                      View deployments →
                    </Link>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[0.75rem] text-muted-foreground tabular-nums">
                      <span>{project.versions ?? 0} version{project.versions === 1 ? "" : "s"}</span>
                      <span>{(project.requests24h ?? 0).toLocaleString()} requests</span>
                      <span>{project.latencyP50 ? `${project.latencyP50} ms` : "—"} p50</span>
                      {(project.errors24h ?? 0) > 0 && <span className="text-coral">{project.errors24h} errors</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <Panel variant="bare">
          <EmptyDeployment />
          <ol className="m-0 list-none px-5 pb-5 [&_code]:text-[0.8rem] [&_code]:text-muted-foreground [&_li]:flex [&_li]:items-center [&_li]:gap-4 [&_li]:border-t [&_li]:border-border [&_li]:py-2.5">
            <li><code>sproutboat init hello</code></li>
            <li><code>sproutboat login</code></li>
            <li><code>sproutboat deploy hello</code></li>
          </ol>
        </Panel>
      )}
    </>
  );
}
