import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell } from "../components";
import { relativeTime, useOverview } from "../dashboard-data";
import { EmptyDeployment } from "./index";

export const Route = createFileRoute("/projects")({ component: Projects, head: () => ({ meta: [{ title: "Projects · Sproutboat" }] }) });
function Projects() { const { data, error } = useOverview(); return <Shell><section className="page-heading"><div><h1>Projects</h1><p>Each active deployment owns one routed project.</p></div></section>{error ? <p className="form-error">Could not load projects. Refresh and try again.</p> : data?.projects.length ? <section className="data-panel"><ul className="record-list">{data.projects.map((project) => <li key={project.name}><div><strong>{project.name}</strong><small>{project.hostname}</small></div><span>Deployed {relativeTime(project.deployedAt)}</span><a className="text-link" href={`https://${project.hostname}`}>Open route</a></li>)}</ul></section> : <section className="data-panel"><EmptyDeployment /><Link className="button primary" to="/deployments">Deployment guide</Link></section>}</Shell>; }
