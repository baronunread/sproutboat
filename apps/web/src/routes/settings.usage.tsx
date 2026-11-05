import {
  DescriptionList,
  EmptyState,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  UsageMeter,
} from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useJson } from "../dashboard-data";
import { LoadError, LoadingBlock, Section } from "../page-state";

/**
 * The caps this box enforces, and how close the account is to each. They were previously
 * invisible until a request came back 429. The route keeps its `/settings/usage` path; the
 * page is called Limits because that is what it is: caps that protect the box, not plan tiers.
 */
export const Route = createFileRoute("/settings/usage")({ component: Limits });

type LimitsData = {
  limits: {
    projectsPerAccount: number;
    versionsPerProject: number;
    domainsPerProject: number;
    secretsPerProject: number;
    resourcesPerAccount: number;
    deployPerAccountPerMinute: number;
    deployPerIpPerMinute: number;
  };
  usage: {
    projects: number;
    resources: number;
    byProject: Array<{ name: string; versions: number; secrets: number; domains: number }>;
  };
};

function Limits() {
  const { data, state, refresh } = useJson<LimitsData>("/api/limits");

  if (state === "loading") return <LoadingBlock label="limits" />;
  if (state === "error" || !data) return <LoadError what="limits" onRetry={() => void refresh()} />;

  const { limits, usage } = data;
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Account"
        description="These caps protect the box, not a plan: they keep one account from starving the rest. An operator can raise them with environment variables."
      >
        <div className="grid gap-6 sm:grid-cols-2">
          <UsageMeter label="Projects" used={usage.projects} limit={limits.projectsPerAccount} />
          <UsageMeter label="Storage resources" used={usage.resources} limit={limits.resourcesPerAccount} />
        </div>
        <p className="text-sm text-fg-muted">KV namespaces, D1 databases, R2 buckets and queues count together.</p>
        <DescriptionList
          items={[
            {
              id: "rate",
              term: "Deploy rate",
              details: `${limits.deployPerAccountPerMinute} per minute per account, ${limits.deployPerIpPerMinute} per minute per source IP`,
            },
            {
              id: "versions",
              term: "Retained versions",
              details: `${limits.versionsPerProject} per project; older inactive versions are pruned automatically`,
            },
          ]}
        />
      </Section>

      <Section title="Per project" description="Versions retained, secrets set, and custom domains attached.">
        {usage.byProject.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description={
              <>
                <Link render={<RouterLink to="/projects" />}>Deploy one</Link> to see its usage here.
              </>
            }
          />
        ) : (
          <Table label="Per-project usage against the limits">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Project</TableHead>
                <TableHead className="text-end">Versions</TableHead>
                <TableHead className="text-end">Secrets</TableHead>
                <TableHead className="text-end">Domains</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.byProject.map((project) => (
                <TableRow key={project.name}>
                  <TableCell>
                    <Link render={<RouterLink to="/projects/$name" params={{ name: project.name }} />}>
                      {project.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {project.versions} / {limits.versionsPerProject}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {project.secrets} / {limits.secretsPerProject}
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {project.domains} / {limits.domainsPerProject}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </div>
  );
}
