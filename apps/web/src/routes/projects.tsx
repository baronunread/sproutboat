import {
  Badge,
  Banner,
  Field,
  Input,
  Link,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
  nextSort,
  toast,
} from "@sproutboat/ikada";
import type { SortDirection } from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { relativeTime, useOverview } from "../dashboard-data";
import type { Overview } from "../dashboard-data";
import { DeleteProjectDialog } from "../delete-project-dialog";
import { EmptySprouts } from "../empty-sprouts";

/**
 * The Sprouts list: one row per sprout carrying its route, its traffic and a way into its
 * own deployments. A version list only makes sense inside the sprout it belongs to.
 */
export const Route = createFileRoute("/projects")({
  component: Projects,
  head: () => ({ meta: [{ title: "Sprouts · Sproutboat" }] }),
});

type Project = Overview["projects"][number];
type SortKey = "name" | "deployed" | "requests";

const sortValue = {
  name: (project: Project) => project.name,
  deployed: (project: Project) => Date.parse(project.deployedAt),
  requests: (project: Project) => project.requests24h ?? 0,
} satisfies Record<SortKey, (project: Project) => number | string>;

function sortProjects(projects: Project[], key: SortKey | undefined, direction: SortDirection | undefined) {
  if (!key || !direction) return projects;
  const sign = direction === "asc" ? 1 : -1;
  const value = sortValue[key];
  return projects.toSorted((a, b) => {
    const x = value(a);
    const y = value(b);
    return sign * (x < y ? -1 : x > y ? 1 : 0);
  });
}

function Projects() {
  const { data, state, error, refresh } = useOverview();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>();

  const needle = query.trim().toLowerCase();
  const rows = useMemo(() => {
    const matching = (data?.projects ?? []).filter(
      (project) => !needle || `${project.name} ${project.hostname}`.toLowerCase().includes(needle),
    );
    return sortProjects(matching, sort?.key, sort?.direction);
  }, [data, needle, sort]);

  const onSort = (key: SortKey) =>
    setSort((current) => {
      const direction = nextSort(current?.key === key ? current.direction : undefined);
      return direction ? { key, direction } : undefined;
    });
  const sortOf = (key: SortKey) => (sort?.key === key ? sort.direction : undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Sprouts"
        description={
          <>
            Every project serving a route from this box. Deploy one with <code>sproutboat deploy</code>.
          </>
        }
      />

      {error ? (
        <Banner tone="danger">Could not load sprouts. Refresh and try again.</Banner>
      ) : data && data.projects.length === 0 ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptySprouts />
        </div>
      ) : (
        <section aria-label="Sprouts list" className="flex flex-col gap-4">
          <div className="max-w-md">
            <Field label="Search sprouts" className="[&>label]:sr-only">
              <Input
                type="search"
                placeholder="Search sprouts…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
          </div>
          <Table label="Sprouts" aria-busy={state === "loading" || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead sortable sort={sortOf("name")} onSort={() => onSort("name")}>
                  Name
                </TableHead>
                <TableHead hideBelow="lg">Route</TableHead>
                <TableHead hideBelow="xl" className="text-end">
                  Versions
                </TableHead>
                <TableHead
                  hideBelow="lg"
                  className="text-end"
                  sortable
                  sort={sortOf("requests")}
                  onSort={() => onSort("requests")}
                >
                  Requests
                </TableHead>
                <TableHead hideBelow="2xl" className="text-end">
                  p50
                </TableHead>
                <TableHead hideBelow="md" sortable sort={sortOf("deployed")} onSort={() => onSort("deployed")}>
                  Deployed
                </TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableEmpty colSpan={7}>
                  {state === "loading" ? (
                    <span className="text-fg-muted">Loading sprouts…</span>
                  ) : (
                    <span className="text-fg-muted">Nothing matches “{query.trim()}”.</span>
                  )}
                </TableEmpty>
              ) : (
                rows.map((project) => (
                  <ProjectRow
                    key={project.name}
                    project={project}
                    onDeleted={() => {
                      toast.add({
                        tone: "success",
                        title: `Deleted ${project.name}`,
                        description: "The project and every deployed version are gone.",
                      });
                      void refresh();
                    }}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}

function ProjectRow({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const domains = project.domains ?? 0;
  const errors = project.errors24h ?? 0;
  return (
    <TableRow>
      <TableCell className="min-w-0">
        <Link render={<RouterLink to="/projects/$name" params={{ name: project.name }} />} className="font-semibold">
          {project.name}
        </Link>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted lg:hidden">
          <span className="break-all">{project.hostname}</span>
        </span>
      </TableCell>
      <TableCell hideBelow="lg" className="text-fg-muted">
        <Link href={`https://${project.hostname}`} className="break-all font-normal text-fg-muted" external>
          {project.hostname}
        </Link>
        {domains > 0 ? (
          <Badge tone="neutral" className="ms-2">
            +{domains} domain{domains === 1 ? "" : "s"}
          </Badge>
        ) : null}
      </TableCell>
      <TableCell hideBelow="xl" className="text-end tabular-nums">
        {project.versions ?? 0}
      </TableCell>
      <TableCell hideBelow="lg" className="text-end tabular-nums">
        {(project.requests24h ?? 0).toLocaleString()}
        {errors > 0 ? <span className="ms-2 text-danger-fg">{errors} errors</span> : null}
      </TableCell>
      <TableCell hideBelow="2xl" className="text-end tabular-nums text-fg-muted">
        {project.latencyP50 ? `${project.latencyP50} ms` : "-"}
      </TableCell>
      <TableCell hideBelow="md" className="whitespace-nowrap text-fg-muted tabular-nums">
        {relativeTime(project.deployedAt)}
      </TableCell>
      <TableCell className="text-end">
        <DeleteProjectDialog name={project.name} onDeleted={onDeleted} />
      </TableCell>
    </TableRow>
  );
}
