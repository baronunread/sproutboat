import { Banner } from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useProject } from "../dashboard-data";
import { TrafficCharts } from "../traffic-charts";

/** #76 - Metrics is its own tab, the way Cloudflare separates it from Logs. */
export const Route = createFileRoute("/projects_/$name/metrics")({ component: ProjectMetrics });

function ProjectMetrics() {
  const { name, active } = useProject();
  return (
    <div className="flex flex-col gap-4">
      {!active && (
        <Banner tone="info">This project has no active route right now. These charts cover past traffic only.</Banner>
      )}
      <TrafficCharts name={name} />
    </div>
  );
}
