import { createFileRoute, Link } from "@tanstack/react-router";
import { PanelHeading } from "../components";
import { useJson } from "../dashboard-data";

/**
 * #76 — the caps this box enforces, and how close the account is to each. They
 * were previously invisible until a request came back 429.
 */
export const Route = createFileRoute("/settings/usage")({ component: Usage });

type Limits = {
  limits: {
    projectsPerAccount: number; versionsPerProject: number; domainsPerProject: number;
    secretsPerProject: number; resourcesPerAccount: number;
    deployPerAccountPerMinute: number; deployPerIpPerMinute: number;
  };
  usage: {
    projects: number;
    resources: number;
    byProject: Array<{ name: string; versions: number; secrets: number; domains: number }>;
  };
};

function Meter({ label, used, cap, detail }: { label: string; used: number; cap: number; detail?: string }) {
  const percent = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  const tone = percent >= 90 ? "danger" : percent >= 70 ? "warn" : "ok";
  return (
    <div className="usage-meter" role="group" aria-label={label}>
      <div className="usage-meter-head">
        <span>{label}</span>
        <strong>{used.toLocaleString()} / {cap.toLocaleString()} <span className="visually-hidden">used ({percent}%)</span></strong>
      </div>
      {/* The count above carries the value; the bar is its visual echo. */}
      <div className={`usage-track tone-${tone}`} aria-hidden="true">
        <div className="usage-fill" style={{ width: `${percent}%` }} />
      </div>
      {detail && <p className="hint">{detail}</p>}
    </div>
  );
}

function Usage() {
  const { data, state } = useJson<Limits>("/api/limits");

  if (state === "loading") return <section className="data-panel loading-state" aria-live="polite">Loading limits…</section>;
  if (state === "error" || !data) return <p className="form-error" role="alert">Could not load limits. Refresh and try again.</p>;

  const { limits, usage } = data;
  return (
    <>
      <section className="data-panel settings-panel">
        <PanelHeading title="Account" description="Enforced by the control plane. An operator can raise these with environment variables." />
        <div className="usage-grid">
          <Meter label="Projects" used={usage.projects} cap={limits.projectsPerAccount} />
          <Meter label="Storage resources" used={usage.resources} cap={limits.resourcesPerAccount}
            detail="KV namespaces, D1 databases, R2 buckets and queues combined." />
        </div>
        <dl className="detail-grid">
          <div><dt>Deploy rate</dt><dd>{limits.deployPerAccountPerMinute} per minute per account · {limits.deployPerIpPerMinute} per minute per source IP</dd></div>
          <div><dt>Retained versions</dt><dd>{limits.versionsPerProject} per project — older superseded versions are pruned automatically</dd></div>
        </dl>
      </section>

      <section className="data-panel wide-panel">
        <PanelHeading title="Per project" description="Versions retained, secrets set, and custom domains attached." />
        {usage.byProject.length === 0 ? (
          <p className="empty-state">No projects yet. <Link className="text-link" to="/projects">Deploy one</Link> to see its usage here.</p>
        ) : (
          <div className="log-scroll">
            <table className="log-table">
              <caption className="visually-hidden">Per-project usage against the limits</caption>
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="num">Versions</th>
                  <th scope="col" className="num">Secrets</th>
                  <th scope="col" className="num">Domains</th>
                </tr>
              </thead>
              <tbody>
                {usage.byProject.map((project) => (
                  <tr key={project.name}>
                    <td>
                      <Link className="text-link" to="/projects/$name" params={{ name: project.name }}>{project.name}</Link>
                    </td>
                    <td className="num">{project.versions} / {limits.versionsPerProject}</td>
                    <td className="num">{project.secrets} / {limits.secretsPerProject}</td>
                    <td className="num">{project.domains} / {limits.domainsPerProject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
