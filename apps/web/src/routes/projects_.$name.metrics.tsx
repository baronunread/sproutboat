import { createFileRoute } from "@tanstack/react-router";
import { useProject } from "../dashboard-data";
import { TrafficCharts } from "../traffic-charts";

/** #76 — Metrics is its own tab, the way Cloudflare separates it from Logs. */
export const Route = createFileRoute("/projects_/$name/metrics")({ component: ProjectMetrics });

function ProjectMetrics() {
  const { name, active } = useProject();
  return (
    <>
      {!active && (
        <p className="status-message info" role="status">
          This project has no active route right now — these charts cover past traffic only.
        </p>
      )}
      <TrafficCharts name={name} />
    </>
  );
}
