import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Metric } from "../components";

export const Route = createFileRoute("/admin/")({ component: AdminOverview });

type Overview = {
  owners: number; projects: number; activeProjects: number; deployments: number; artifacts: number;
  bannedOwners: number; requests24h: number; errors24h: number; since: string;
};

function AdminOverview() {
  const [data, setData] = useState<Overview>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let ignore = false;
    const load = async () => {
      try {
        const response = await fetch("/api/admin/overview", { credentials: "include" });
        if (ignore) return;
        if (!response.ok) { setState("error"); return; }
        // SAFETY: a 2xx from /api/admin/overview is the Overview contract.
        const body = await response.json() as Overview;
        if (ignore) return;
        setData(body); setState("ready");
      } catch { if (!ignore) setState("error"); }
    };
    void load();
    return () => { ignore = true; };
  }, []);

  if (state === "loading") return <section className="data-panel loading-state" aria-live="polite">Loading platform status…</section>;
  if (state === "error" || !data) return <p className="form-error" role="alert">Could not load platform status. Refresh and try again.</p>;

  return (
    <section className="metrics" aria-label="Platform statistics">
      <Metric label="Accounts" value={String(data.owners)} detail="With at least one project" />
      <Metric label="Active projects" value={String(data.activeProjects)} detail="Routes currently serving" />
      <Metric label="Deployments" value={String(data.deployments)} detail="Immutable versions" />
      <Metric label="Artifacts" value={String(data.artifacts)} detail="Stored on disk" />
      <Metric label="Requests" value={String(data.requests24h)} detail="Last 24 hours, all routes" />
      <Metric label="Errors" value={String(data.errors24h)} detail="5xx, last 24 hours" tone={data.errors24h > 0 ? "warning" : "neutral"} />
      <Metric label="Banned accounts" value={String(data.bannedOwners)} detail="Routes stopped" tone={data.bannedOwners > 0 ? "warning" : "neutral"} />
    </section>
  );
}
