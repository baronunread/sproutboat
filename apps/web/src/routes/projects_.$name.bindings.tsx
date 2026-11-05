import {
  Badge,
  Banner,
  CopyId,
  EmptyState,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useJson, useProject } from "../dashboard-data";
import { LoadingLine, Section } from "../project-ui";

/**
 * #76 - what the active version can actually reach: the bindings baked into its
 * artifact, the account resources they resolve to, and the secret names set for
 * the project. Bindings are immutable per version (they come from the artifact),
 * so this view is read-only by construction; secrets are managed in Settings.
 */
export const Route = createFileRoute("/projects_/$name/bindings")({ component: ProjectBindings });

type ResourceRef = { binding: string; kind: string; id: string };
type Bindings = {
  kv: string[];
  secrets: string[];
  d1: string[];
  r2: string[];
  queues: string[];
  analytics: string[];
  crons: string[];
  assets: string | null;
  durableObjects: Array<{ binding: string; className: string }>;
  resources: ResourceRef[];
  /** Older artifacts predate vars in bindings.json, so this can be absent. */
  vars?: Record<string, string>;
};
type Resource = { id: string; kind: string; name: string };
type Detail = { id: string; bindings: Bindings | null; resources: Resource[]; manifestError: string | null };

const KIND_LABEL = new Map([
  ["kv", "KV namespace"],
  ["d1", "D1 database"],
  ["r2", "R2 bucket"],
  ["queue", "Queue"],
  ["secret", "Secret"],
  ["analytics", "Analytics dataset"],
  ["assets", "Static assets"],
  ["do", "Durable Object"],
  ["cron", "Cron trigger"],
  ["var", "Variable"],
]);

type Row = { binding: string; kind: string; target: string; resourceId: string | null };

/** #77 - each kind now has its own product page to link a bound resource to. */
const KIND_PAGE = new Map([
  ["kv", "/kv"],
  ["d1", "/d1"],
  ["r2", "/r2"],
  ["queue", "/queues"],
]);

/** Flattens the artifact's binding set into one table the way Cloudflare lists them. */
function rowsFor(bindings: Bindings, resources: Resource[]): Row[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const resourceFor = (binding: string): ResourceRef | undefined =>
    bindings.resources.find((ref) => ref.binding === binding);

  const fromNames = (names: string[], kind: string): Row[] =>
    names.map((binding) => {
      const ref = resourceFor(binding);
      const resource = ref ? byId.get(ref.id) : undefined;
      return {
        binding,
        kind,
        target: resource ? resource.name : ref ? ref.id : "Provisioned with the deployment",
        resourceId: ref?.id ?? null,
      };
    });

  return [
    ...fromNames(bindings.kv, "kv"),
    ...fromNames(bindings.d1, "d1"),
    ...fromNames(bindings.r2, "r2"),
    ...fromNames(bindings.queues, "queue"),
    ...bindings.secrets.map((binding) => ({ binding, kind: "secret", target: "Value hidden", resourceId: null })),
    ...bindings.analytics.map((binding) => ({
      binding,
      kind: "analytics",
      target: "Written on first use",
      resourceId: null,
    })),
    ...bindings.durableObjects.map((entry) => ({
      binding: entry.binding,
      kind: "do",
      target: entry.className,
      resourceId: null,
    })),
    ...(bindings.assets
      ? [{ binding: bindings.assets, kind: "assets", target: "Files served from the artifact", resourceId: null }]
      : []),
    // Plain baked config, shown with its value - unlike a secret, whose value
    // the API never returns.
    ...Object.entries(bindings.vars ?? {}).map(([binding, value]) => ({
      binding,
      kind: "var",
      target: value,
      resourceId: null,
    })),
  ];
}

function ProjectBindings() {
  const { name, deployments } = useProject();
  const activeVersion = deployments.find((deployment) => deployment.active);
  const { data, state } = useJson<Detail>(
    activeVersion
      ? `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(activeVersion.id)}`
      : null,
  );

  if (!activeVersion) {
    return (
      <Section id="bindings" title="Bindings" description="What the running version can reach.">
        <EmptyState
          as="h3"
          title="No active version"
          description={
            <>
              Bindings are declared in <code>sproutboat.jsonc</code> and baked into an artifact at build time, so they
              appear here once a version is serving.
            </>
          }
        />
      </Section>
    );
  }

  const bindings = data?.bindings;
  const rows = bindings ? rowsFor(bindings, data?.resources ?? []) : [];

  return (
    <div className="flex flex-col gap-4">
      <Section
        id="bindings"
        title="Bindings"
        description={
          <>
            Declared by the active version&apos;s artifact. Change <code>sproutboat.jsonc</code> and redeploy to alter
            them.
          </>
        }
      >
        {state === "loading" ? (
          <LoadingLine label="Loading bindings…" />
        ) : state === "error" ? (
          <Banner tone="danger">Could not load bindings. Refresh and try again.</Banner>
        ) : !bindings ? (
          <EmptyState
            as="h3"
            title="No bindings declared"
            description={
              <>
                This version declares no bindings{data?.manifestError ? ` (${data.manifestError})` : ""}. Add them under{" "}
                <code>bindings</code> in <code>sproutboat.jsonc</code> and redeploy.
              </>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState as="h3" title="No bindings declared" description="This version declares no bindings." />
        ) : (
          <Table label="Bindings declared by the active version" containerClassName="shadow-none ring-1 ring-hairline">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Binding</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.kind}:${row.binding}:${row.target}`}>
                  <TableCell className="font-mono text-sm">{row.binding}</TableCell>
                  <TableCell>
                    <Badge tone="neutral">{KIND_LABEL.get(row.kind) ?? row.kind}</Badge>
                  </TableCell>
                  <TableCell className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      {row.resourceId && KIND_PAGE.has(row.kind) ? (
                        <Link render={<RouterLink to={KIND_PAGE.get(row.kind) ?? "/"} />}>{row.target}</Link>
                      ) : (
                        <span className="break-all">{row.target}</span>
                      )}
                      {row.resourceId ? (
                        <CopyId value={row.resourceId} label={`Copy ${row.binding} resource ID`} />
                      ) : null}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {bindings && bindings.crons.length > 0 && (
        <Section
          id="crons"
          title="Declared cron triggers"
          description="Frozen in the artifact, and fired against the active version. Run history is not surfaced yet (#81)."
        >
          <Table label="Declared cron triggers" containerClassName="shadow-none ring-1 ring-hairline">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Schedule</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bindings.crons.map((expression) => (
                <TableRow key={expression}>
                  <TableCell className="font-mono text-sm">{expression}</TableCell>
                  <TableCell>
                    <Badge tone="info">Scheduled</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </div>
  );
}
