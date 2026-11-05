import {
  Button,
  CopyId,
  EmptyState,
  Field,
  Input,
  Link,
  MetricTile,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  formatBytes,
  formatNumber,
} from "@sproutboat/ikada";
import { Sparkline } from "@sproutboat/ikada/charts";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import { relativeTime, useProject } from "../dashboard-data";
import { FilterSelect, Section, fullTime } from "../project-ui";
import { RollbackDialog } from "../rollback-dialog";
import type { RollbackTarget } from "../rollback-dialog";

export const Route = createFileRoute("/projects_/$name/deployments")({ component: ProjectDeployments });

const STATE_OPTIONS = [
  { value: "all", label: "All versions" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];
const PAGE = 20;

function Tiles({
  sizes,
  compiles,
  versions,
  inactive,
}: {
  sizes: number[];
  compiles: number[];
  versions: number;
  inactive: number;
}) {
  const latest = sizes.at(-1) ?? 0;
  const previous = sizes.at(-2) ?? latest;
  const difference = latest - previous;
  const compile = compiles.at(-1);
  return (
    <section aria-label="Version statistics" className="grid gap-3 sm:grid-cols-3">
      <MetricTile
        label="Binary size"
        noData={sizes.length === 0}
        value={formatBytes(latest)}
        hint={
          difference === 0
            ? "No change vs previous"
            : `${difference > 0 ? "+" : "-"}${formatBytes(Math.abs(difference))} vs previous`
        }
        sparkline={
          sizes.length > 1 ? (
            <Sparkline
              data={sizes}
              ariaLabel="Binary size per version, oldest to newest"
              formatValue={(value) => formatBytes(value)}
              formatPoint={(index) => `Version ${index + 1} of ${sizes.length}`}
            />
          ) : undefined
        }
      />
      <MetricTile
        label="Compile time"
        noData={compile === undefined}
        value={compile === undefined ? "-" : formatNumber(compile)}
        unit="ms"
        hint="Latest version"
        sparkline={
          compiles.length > 1 ? (
            <Sparkline
              data={compiles}
              color="series"
              ariaLabel="Compile time per version, oldest to newest"
              formatValue={(value) => `${formatNumber(value)} ms`}
              formatPoint={(index) => `Version ${index + 1} of ${compiles.length}`}
            />
          ) : undefined
        }
      />
      <MetricTile label="Versions" value={String(versions)} hint={`${inactive} inactive, kept for roll back`} />
    </section>
  );
}

function ProjectDeployments() {
  const { name, deployments, refresh } = useProject();
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [target, setTarget] = useState<RollbackTarget | null>(null);

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
  const compiles = deployments
    .flatMap((deployment) => (deployment.compileMs === null ? [] : [deployment.compileMs]))
    .reverse();

  return (
    <div className="flex flex-col gap-4">
      <Tiles
        sizes={sizes}
        compiles={compiles}
        versions={deployments.length}
        inactive={deployments.filter((deployment) => !deployment.active).length}
      />

      <Section
        id="versions"
        title="Deployments"
        description={`${deployments.length} immutable version${deployments.length === 1 ? "" : "s"}, newest first.`}
      >
        <search className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="State"
            value={status}
            options={STATE_OPTIONS}
            onValueChange={(value) => {
              setStatus(value);
              setShown(PAGE);
            }}
          />
          <Field label="Search" className="sm:max-w-md sm:flex-1">
            <Input
              type="search"
              placeholder="Match version id, artifact digest or hostname"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setShown(PAGE);
              }}
            />
          </Field>
        </search>

        {matching.length === 0 ? (
          <EmptyState as="h3" title="No versions match" description="Change the filters to see more versions." />
        ) : (
          <>
            <Table label="Versions" containerClassName="shadow-none ring-1 ring-hairline">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Version</TableHead>
                  <TableHead hideBelow="lg">Artifact</TableHead>
                  <TableHead hideBelow="2xl" className="text-end">
                    Size
                  </TableHead>
                  <TableHead hideBelow="md">Deployed</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-end">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((deployment) => (
                  <TableRow key={deployment.id}>
                    <TableCell className="min-w-0">
                      <Link
                        render={
                          <RouterLink to="/projects/$name/deployments/$id" params={{ name, id: deployment.id }} />
                        }
                        className="font-mono text-sm"
                      >
                        {deployment.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell hideBelow="lg">
                      <CopyId
                        value={deployment.artifact}
                        display={deployment.artifact.slice(0, 12)}
                        label={`Copy artifact digest of ${deployment.id.slice(0, 8)}`}
                      />
                    </TableCell>
                    <TableCell hideBelow="2xl" className="text-end whitespace-nowrap tabular-nums text-fg-muted">
                      {deployment.binarySize === null ? "-" : formatBytes(deployment.binarySize)}
                      {deployment.compileMs === null ? "" : `, ${deployment.compileMs} ms compile`}
                    </TableCell>
                    <TableCell hideBelow="md" className="whitespace-nowrap text-fg-muted tabular-nums">
                      <span title={fullTime(deployment.deployedAt)}>{relativeTime(deployment.deployedAt)}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {deployment.active ? (
                        <StatusDot status="success" live label="Active" />
                      ) : (
                        <StatusDot status="neutral" label="Inactive" />
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      {deployment.active ? null : (
                        <Button
                          size="sm"
                          aria-label={`Roll back to ${deployment.id.slice(0, 8)}`}
                          onClick={() => setTarget({ id: deployment.id, hostname: deployment.hostname })}
                        >
                          Roll back
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {visible.length === 0 ? <TableEmpty colSpan={6}>No versions.</TableEmpty> : null}
              </TableBody>
            </Table>
            {matching.length > visible.length && (
              <div>
                <Button onClick={() => setShown((current) => current + PAGE)}>
                  Show more ({matching.length - visible.length} left)
                </Button>
              </div>
            )}
          </>
        )}
      </Section>

      <RollbackDialog name={name} target={target} onClose={() => setTarget(null)} onDone={refresh} />
    </div>
  );
}
