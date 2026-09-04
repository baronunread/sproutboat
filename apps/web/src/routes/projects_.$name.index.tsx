import { createFileRoute } from "@tanstack/react-router";
import { relativeTime, useProject } from "../dashboard-data";
import { Panel } from "../components";

export const Route = createFileRoute("/projects_/$name/")({ component: ProjectOverview });

function ProjectOverview() {
  const { deployments, active } = useProject();
  const activeVersion = deployments.find((deployment) => deployment.active);
  return (
    <Panel variant="wide">
      <h2>Overview</h2>
      <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
        <div>
          <dt>Route</dt>
          <dd>
            {active ? (
              <a
                className="text-[0.8rem] text-sky underline-offset-2 hover:underline"
                href={`https://${active.hostname}`}
              >
                {active.hostname}
              </a>
            ) : (
              "Not serving — every version is superseded"
            )}
          </dd>
        </div>
        <div>
          <dt>Active version</dt>
          <dd>{activeVersion ? <code>{activeVersion.id}</code> : "None"}</dd>
        </div>
        <div>
          <dt>Artifact digest</dt>
          <dd>{activeVersion ? <code>{activeVersion.artifact}</code> : "—"}</dd>
        </div>
        <div>
          <dt>Deployed</dt>
          <dd>{activeVersion ? relativeTime(activeVersion.deployedAt) : "—"}</dd>
        </div>
        <div>
          <dt>Total versions</dt>
          <dd>{deployments.length}</dd>
        </div>
      </dl>
    </Panel>
  );
}
