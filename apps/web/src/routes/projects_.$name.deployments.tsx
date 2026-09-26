import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Button,
  FILTER_BAR,
  FILTER_FIELD,
  FILTER_SEARCH,
  Panel,
  PanelHeading,
  RECORD_TITLE,
  RecordList,
  RecordRow,
  SelectField,
  Status,
  TextField,
} from "../components";
import { relativeTime, useProject } from "../dashboard-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/projects_/$name/deployments")({ component: ProjectDeployments });

const STATE_OPTIONS = [
  ["all", "All versions"],
  ["active", "Active"],
  ["inactive", "Inactive"],
] as const;
const PAGE = 20;

function sizeLabel(value: number): string {
  if (Math.abs(value) < 1024) return `${value} B`;
  if (Math.abs(value) < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function SizeTrend({ sizes }: { sizes: number[] }) {
  const latest = sizes.at(-1)!;
  const previous = sizes.at(-2)!;
  const min = Math.min(...sizes);
  const spread = Math.max(...sizes) - min;
  const points = sizes
    .map((size, index) => `${(index / (sizes.length - 1)) * 100},${20 - (spread ? ((size - min) / spread) * 16 : 8)}`)
    .join(" ");
  const difference = latest - previous;
  return (
    <section className="mx-5 mb-5 border border-border px-4 py-3" aria-label="Binary size trend">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-semibold">Binary size trend</h2>
        <p className="text-sm tabular-nums">
          {sizeLabel(latest)} latest,{" "}
          {difference === 0 ? "no change" : `${difference > 0 ? "+" : ""}${sizeLabel(difference)} vs previous`}
        </p>
      </div>
      <svg className="mt-3 block h-12 w-full" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={points} fill="none" stroke="var(--sky)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="mt-2 text-xs text-muted-foreground">
        {sizes.length} versions, oldest to newest. Exact sizes are listed below.
      </p>
    </section>
  );
}

function ProjectDeployments() {
  const { name, deployments } = useProject();
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const needle = query.trim().toLowerCase();
  const matching = deployments.filter((deployment) => {
    if (status === "active" && !deployment.active) return false;
    if (status === "inactive" && deployment.active) return false;
    if (!needle) return true;
    return `${deployment.id} ${deployment.artifact} ${deployment.hostname}`.toLowerCase().includes(needle);
  });
  const visible = matching.slice(0, shown);
  const sizes = deployments
    .flatMap((deployment) => (deployment.binarySize === null ? [] : [deployment.binarySize]))
    .reverse();

  return (
    <Panel variant="bare">
      <PanelHeading
        title="Deployments"
        description={`${deployments.length} immutable version${deployments.length === 1 ? "" : "s"}, newest first.`}
      />

      {sizes.length > 1 && <SizeTrend sizes={sizes} />}

      <div className={cn(FILTER_BAR, "px-5")}>
        <SelectField
          label="State"
          fieldClassName={FILTER_FIELD}
          value={status}
          options={STATE_OPTIONS}
          onValueChange={(value) => {
            setStatus(value);
            setShown(PAGE);
          }}
        />
        <TextField
          label="Search"
          type="search"
          fieldClassName={FILTER_SEARCH}
          placeholder="Match version id, artifact digest or hostname"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setShown(PAGE);
          }}
        />
      </div>

      {matching.length === 0 ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
          No versions match these filters.
        </p>
      ) : (
        <>
          <RecordList aria-label="Versions">
            {visible.map((deployment) => (
              <RecordRow key={deployment.id}>
                <div>
                  <Link
                    className={RECORD_TITLE}
                    to="/projects/$name/deployments/$id"
                    params={{ name, id: deployment.id }}
                  >
                    {deployment.id.slice(0, 8)}
                  </Link>
                  <small>{deployment.hostname}</small>
                </div>
                <code title={`Artifact ${deployment.artifact}`}>Artifact {deployment.artifact.slice(0, 12)}</code>
                <span className="tabular-nums">
                  Size {deployment.binarySize === null ? "unavailable" : sizeLabel(deployment.binarySize)}
                  <br />
                  Compile {deployment.compileMs === null ? "unavailable" : `${deployment.compileMs} ms`}
                </span>
                <span>{relativeTime(deployment.deployedAt)}</span>
                <Status live={deployment.active}>{deployment.active ? "Active" : "Inactive"}</Status>
              </RecordRow>
            ))}
          </RecordList>
          {matching.length > visible.length && (
            <div className="mx-5 my-4">
              <Button variant="quiet" onClick={() => setShown((current) => current + PAGE)}>
                Show more ({matching.length - visible.length} left)
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
