import { createFileRoute, Link } from "@tanstack/react-router";
import { DataTable, Panel, PanelHeading, RecordList, RecordRow, StatusMessage } from "../components";
import { useJson, useProject } from "../dashboard-data";

/**
 * #76 — what the active version can actually reach: the bindings baked into its
 * artifact, the account resources they resolve to, and the secret names set for
 * the project. Bindings are immutable per version (they come from the artifact),
 * so this view is read-only by construction; secrets are managed in Settings.
 */
export const Route = createFileRoute("/projects_/$name/bindings")({ component: ProjectBindings });

type ResourceRef = { binding: string; kind: string; id: string };
type Bindings = {
  kv: string[];
  secrets: string[];
  outbound: string[];
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
  ["outbound", "Outbound fetch"],
  ["analytics", "Analytics dataset"],
  ["assets", "Static assets"],
  ["do", "Durable Object"],
  ["cron", "Cron trigger"],
  ["var", "Variable"],
]);

type Row = { binding: string; kind: string; target: string; resourceId: string | null };

/** #77 — each kind now has its own product page to link a bound resource to. */
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
    ...bindings.outbound.map((host) => ({ binding: "fetch", kind: "outbound", target: host, resourceId: null })),
    // Plain baked config, shown with its value — unlike a secret, whose value
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
      <Panel>
        <PanelHeading title="Bindings" description="What the running version can reach." />
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
          No active version. Bindings are declared in <code>sproutboat.jsonc</code> and baked into an artifact at build
          time, so they appear here once a version is serving.
        </p>
      </Panel>
    );
  }

  const bindings = data?.bindings;
  const rows = bindings ? rowsFor(bindings, data?.resources ?? []) : [];

  return (
    <>
      <Panel variant="wide">
        <PanelHeading
          title="Bindings"
          description={
            <>
              Declared by the active version&apos;s artifact. Change <code>sproutboat.jsonc</code> and redeploy to alter
              them.
            </>
          }
        />

        {state === "loading" ? (
          <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">
            Loading bindings…
          </p>
        ) : state === "error" ? (
          <StatusMessage tone="error">Could not load bindings. Refresh and try again.</StatusMessage>
        ) : !bindings ? (
          <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
            This version declares no bindings{data?.manifestError ? ` (${data.manifestError})` : ""}. Add them under{" "}
            <code>bindings</code> in <code>sproutboat.jsonc</code> and redeploy.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
            This version declares no bindings.
          </p>
        ) : (
          <DataTable
            caption="Bindings declared by the active version"
            head={
              <tr>
                <th scope="col">Binding</th>
                <th scope="col">Type</th>
                <th scope="col">Target</th>
              </tr>
            }
          >
            {rows.map((row) => (
              <tr key={`${row.kind}:${row.binding}:${row.target}`}>
                <td>
                  <code>{row.binding}</code>
                </td>
                <td>{KIND_LABEL.get(row.kind) ?? row.kind}</td>
                <td>
                  {row.resourceId && KIND_PAGE.has(row.kind) ? (
                    <Link
                      className="text-[0.8rem] text-sky underline-offset-2 hover:underline"
                      to={KIND_PAGE.get(row.kind)!}
                    >
                      {row.target}
                    </Link>
                  ) : (
                    row.target
                  )}
                  {row.resourceId && (
                    <small className="text-muted-foreground">
                      {" "}
                      · <code>{row.resourceId}</code>
                    </small>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        )}
      </Panel>

      {bindings && bindings.crons.length > 0 && (
        <Panel>
          <PanelHeading
            title="Declared cron triggers"
            description="Frozen in the artifact, and fired against the active version. Run history is not surfaced yet (#81)."
          />
          <RecordList>
            {bindings.crons.map((expression) => (
              <RecordRow key={expression}>
                <div>
                  <code>{expression}</code>
                </div>
                <span>Scheduled</span>
              </RecordRow>
            ))}
          </RecordList>
        </Panel>
      )}
    </>
  );
}
