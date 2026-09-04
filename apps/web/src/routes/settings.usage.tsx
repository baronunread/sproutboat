import { createFileRoute, Link } from "@tanstack/react-router";
import { DataTable, Panel, PanelHeading, StatusMessage } from "../components";
import { useJson } from "../dashboard-data";
import { cn } from "@/lib/utils";

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
    <div role="group" aria-label={label}>
      <div className="flex items-baseline justify-between text-[0.8rem] [&_strong]:tabular-nums">
        <span>{label}</span>
        <strong>{used.toLocaleString()} / {cap.toLocaleString()} <span className="sr-only">used ({percent}%)</span></strong>
      </div>
      {/* The count above carries the value; the bar is its visual echo. */}
      <div className="mt-2 h-[0.45rem] overflow-hidden rounded-full bg-secondary" aria-hidden="true">
        <div className={cn("h-full min-w-0.5 rounded-[inherit] transition-[width] duration-200", tone === "danger" ? "bg-coral" : tone === "warn" ? "bg-[#f6c344]" : "bg-sky")} style={{ width: `${percent}%` }} />
      </div>
      {detail && <p className="mt-3 text-[0.75rem] text-muted-foreground">{detail}</p>}
    </div>
  );
}

function Usage() {
  const { data, state } = useJson<Limits>("/api/limits");

  if (state === "loading") return <Panel variant="bare" className="min-h-56 px-5 pt-12 text-muted-foreground" aria-live="polite">Loading limits…</Panel>;
  if (state === "error" || !data) return <StatusMessage tone="error">Could not load limits. Refresh and try again.</StatusMessage>;

  const { limits, usage } = data;
  return (
    <>
      <Panel variant="wide">
        <PanelHeading title="Account" description="Enforced by the control plane. An operator can raise these with environment variables." />
        <div className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-6">
          <Meter label="Projects" used={usage.projects} cap={limits.projectsPerAccount} />
          <Meter label="Storage resources" used={usage.resources} cap={limits.resourcesPerAccount}
            detail="KV namespaces, D1 databases, R2 buckets and queues combined." />
        </div>
        <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
          <div><dt>Deploy rate</dt><dd>{limits.deployPerAccountPerMinute} per minute per account · {limits.deployPerIpPerMinute} per minute per source IP</dd></div>
          <div><dt>Retained versions</dt><dd>{limits.versionsPerProject} per project — older superseded versions are pruned automatically</dd></div>
        </dl>
      </Panel>

      <Panel variant="wide">
        <PanelHeading title="Per project" description="Versions retained, secrets set, and custom domains attached." />
        {usage.byProject.length === 0 ? (
          <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No projects yet. <Link className="text-[0.8rem] text-sky underline-offset-2 hover:underline" to="/projects">Deploy one</Link> to see its usage here.</p>
        ) : (
          <DataTable caption="Per-project usage against the limits"
              head={<tr>
                  <th scope="col">Project</th>
                  <th scope="col" className="text-end tabular-nums">Versions</th>
                  <th scope="col" className="text-end tabular-nums">Secrets</th>
                  <th scope="col" className="text-end tabular-nums">Domains</th>
                </tr>}
            >
              {usage.byProject.map((project) => (
                  <tr key={project.name}>
                    <td>
                      <Link className="text-[0.8rem] text-sky underline-offset-2 hover:underline" to="/projects/$name" params={{ name: project.name }}>{project.name}</Link>
                    </td>
                    <td className="text-end tabular-nums">{project.versions} / {limits.versionsPerProject}</td>
                    <td className="text-end tabular-nums">{project.secrets} / {limits.secretsPerProject}</td>
                    <td className="text-end tabular-nums">{project.domains} / {limits.domainsPerProject}</td>
                  </tr>
                ))}
            </DataTable>
        )}
      </Panel>
    </>
  );
}
