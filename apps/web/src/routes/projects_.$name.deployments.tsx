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
  ["superseded", "Superseded"],
] as const;
const PAGE = 20;

function ProjectDeployments() {
  const { name, deployments } = useProject();
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const needle = query.trim().toLowerCase();
  const matching = deployments.filter((deployment) => {
    if (status === "active" && !deployment.active) return false;
    if (status === "superseded" && deployment.active) return false;
    if (!needle) return true;
    return `${deployment.id} ${deployment.artifact} ${deployment.hostname}`.toLowerCase().includes(needle);
  });
  const visible = matching.slice(0, shown);

  return (
    <Panel variant="bare">
      <PanelHeading
        title="Deployments"
        description={`${deployments.length} immutable version${deployments.length === 1 ? "" : "s"}, newest first.`}
      />

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
                <span>{relativeTime(deployment.deployedAt)}</span>
                <Status live={deployment.active}>{deployment.active ? "Active" : "Superseded"}</Status>
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
