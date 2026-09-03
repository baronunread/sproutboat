import { createFileRoute, Link } from "@tanstack/react-router";
import { PanelHeading } from "../components";
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
  kv: string[]; secrets: string[]; outbound: string[]; d1: string[]; r2: string[];
  queues: string[]; analytics: string[]; crons: string[];
  assets: string | null;
  durableObjects: Array<{ binding: string; className: string }>;
  resources: ResourceRef[];
};
type Resource = { id: string; kind: string; name: string };
type Detail = { id: string; bindings: Bindings | null; resources: Resource[]; manifestError: string | null };

const KIND_LABEL = new Map([
  ["kv", "KV namespace"], ["d1", "D1 database"], ["r2", "R2 bucket"], ["queue", "Queue"],
  ["secret", "Secret"], ["outbound", "Outbound fetch"], ["analytics", "Analytics dataset"],
  ["assets", "Static assets"], ["do", "Durable Object"], ["cron", "Cron trigger"],
]);

type Row = { binding: string; kind: string; target: string; resourceId: string | null };

/** #77 — each kind now has its own product page to link a bound resource to. */
const KIND_PAGE = new Map([["kv", "/kv"], ["d1", "/d1"], ["r2", "/r2"], ["queue", "/queues"]]);

/** Flattens the artifact's binding set into one table the way Cloudflare lists them. */
function rowsFor(bindings: Bindings, resources: Resource[]): Row[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const resourceFor = (binding: string): ResourceRef | undefined =>
    bindings.resources.find((ref) => ref.binding === binding);

  const fromNames = (names: string[], kind: string): Row[] => names.map((binding) => {
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
    ...bindings.analytics.map((binding) => ({ binding, kind: "analytics", target: "Written on first use", resourceId: null })),
    ...bindings.durableObjects.map((entry) => ({ binding: entry.binding, kind: "do", target: entry.className, resourceId: null })),
    ...(bindings.assets ? [{ binding: bindings.assets, kind: "assets", target: "Files served from the artifact", resourceId: null }] : []),
    ...bindings.outbound.map((host) => ({ binding: "fetch", kind: "outbound", target: host, resourceId: null })),
  ];
}

function ProjectBindings() {
  const { name, deployments } = useProject();
  const activeVersion = deployments.find((deployment) => deployment.active);
  const { data, state } = useJson<Detail>(
    activeVersion ? `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(activeVersion.id)}` : null,
  );

  if (!activeVersion) {
    return (
      <section className="data-panel settings-panel">
        <PanelHeading title="Bindings" description="What the running version can reach." />
        <p className="empty-state">
          No active version. Bindings are declared in <code>sproutboat.jsonc</code> and baked into an artifact at build
          time, so they appear here once a version is serving.
        </p>
      </section>
    );
  }

  const bindings = data?.bindings;
  const rows = bindings ? rowsFor(bindings, data?.resources ?? []) : [];

  return (
    <>
      <section className="data-panel wide-panel">
        <PanelHeading
          title="Bindings"
          description={<>Declared by the active version&apos;s artifact. Change <code>sproutboat.jsonc</code> and redeploy to alter them.</>}
        />

        {state === "loading" ? (
          <p className="loading-state" aria-live="polite">Loading bindings…</p>
        ) : state === "error" ? (
          <p className="form-error" role="alert">Could not load bindings. Refresh and try again.</p>
        ) : !bindings ? (
          <p className="empty-state">
            This version declares no bindings{data?.manifestError ? ` (${data.manifestError})` : ""}. Add them under{" "}
            <code>bindings</code> in <code>sproutboat.jsonc</code> and redeploy.
          </p>
        ) : rows.length === 0 ? (
          <p className="empty-state">This version declares no bindings.</p>
        ) : (
          <div className="log-scroll">
            <table className="log-table">
              <caption className="visually-hidden">Bindings declared by the active version</caption>
              <thead>
                <tr><th scope="col">Binding</th><th scope="col">Type</th><th scope="col">Target</th></tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.kind}:${row.binding}:${row.target}`}>
                    <td><code>{row.binding}</code></td>
                    <td>{KIND_LABEL.get(row.kind) ?? row.kind}</td>
                    <td>
                      {row.resourceId && KIND_PAGE.has(row.kind)
                        ? <Link className="text-link" to={KIND_PAGE.get(row.kind)!}>{row.target}</Link>
                        : row.target}
                      {row.resourceId && <small className="binding-id"> · <code>{row.resourceId}</code></small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {bindings && bindings.crons.length > 0 && (
        <section className="data-panel settings-panel">
          <PanelHeading title="Declared cron triggers" description="Frozen in the artifact, and fired against the active version. Run history is not surfaced yet (#81)." />
          <ul className="record-list">
            {bindings.crons.map((expression) => (
              <li key={expression}><div><code>{expression}</code></div><span>Scheduled</span></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
