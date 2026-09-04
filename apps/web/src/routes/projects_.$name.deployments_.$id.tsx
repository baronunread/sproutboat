import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ConfirmButton,
  Copy,
  DataTable,
  FILTER_BAR,
  FORM_ACTIONS,
  Panel,
  PanelHeading,
  SelectField,
  Status,
  StatusMessage,
} from "../components";
import { mutate, relativeTime, useProject } from "../dashboard-data";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/projects_/$name/deployments_/$id")({
  component: DeploymentDetail,
  head: ({ params }) => ({ meta: [{ title: `${params.id.slice(0, 8)} · ${params.name} · Sproutboat` }] }),
});

type Manifest = {
  schemaVersion: number;
  target: string;
  runtime: string;
  capabilityProfile: string;
  porfforVersion: string;
  esbuildVersion: string;
  buildImage: string;
  sourceHash: string;
  binaryHash: string;
  binarySize: number;
  builtAt: string;
};
type Resource = { id: string; kind: string; name: string };
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
  resources: Array<{ binding: string; kind: string; id: string }>;
};
type Detail = {
  id: string;
  hostname: string;
  artifact: string;
  deployedAt: string;
  active: boolean;
  deployedBy: string | null;
  bindings: Bindings | null;
  resources: Resource[];
  manifest: Manifest | null;
  manifestError: string | null;
};

/** The manifest fields worth diffing between two versions, in reading order. */
const COMPARED: ReadonlyArray<readonly [keyof Manifest, string]> = [
  ["binaryHash", "Binary hash"],
  ["sourceHash", "Source hash"],
  ["binarySize", "Binary size"],
  ["porfforVersion", "Porffor toolchain"],
  ["esbuildVersion", "esbuild"],
  ["buildImage", "Build image"],
  ["runtime", "Runtime"],
  ["target", "Target ABI"],
  ["capabilityProfile", "Compatibility profile"],
  ["schemaVersion", "Manifest schema"],
  ["builtAt", "Built"],
];

function DeploymentDetail() {
  const { name, id } = Route.useParams();
  const { refresh, deployments } = useProject();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail>();
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const base = `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const response = await fetch(base, { credentials: "include" });
      if (response.status === 404) {
        setState("missing");
        return;
      }
      if (!response.ok) {
        setState("error");
        return;
      }
      // SAFETY: a 2xx from the deployment-detail endpoint is the Detail contract.
      setDetail((await response.json()) as Detail);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  const rollback = async () => {
    setError("");
    setBusy(true);
    const failure = await mutate(`${base}/activate`, { method: "POST" });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    await Promise.all([load(), refresh()]);
  };

  const remove = async () => {
    setError("");
    const failure = await mutate(base, { method: "DELETE" });
    if (failure) {
      setError(failure);
      return;
    }
    await refresh();
    void navigate({ to: "/projects/$name/deployments", params: { name } });
  };

  return (
    <>
      <p className="m-0 mb-2 text-[0.78rem] text-muted-foreground [&_a]:underline-offset-2 [&_a:hover]:underline [&>span]:mx-1.5">
        <Link to="/projects/$name/deployments" params={{ name }}>
          Deployments
        </Link>{" "}
        <span>/</span> {id.slice(0, 8)}
      </p>

      {state === "loading" ? (
        <Panel variant="bare" className="min-h-56 px-5 pt-12 text-muted-foreground" aria-live="polite">
          Loading deployment…
        </Panel>
      ) : state === "missing" ? (
        <Panel variant="bare">
          <h2>Deployment not found</h2>
          <p>This version may have been deleted.</p>
          <Link
            className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })}
            to="/projects/$name/deployments"
            params={{ name }}
          >
            Back to deployments
          </Link>
        </Panel>
      ) : state === "error" || !detail ? (
        <StatusMessage tone="error">Could not load this deployment. Refresh and try again.</StatusMessage>
      ) : (
        <>
          <Panel variant="wide">
            <PanelHeading title={`Version ${detail.id.slice(0, 8)}`} />
            <p>
              <Status live={detail.active}>{detail.active ? "Active" : "Superseded"}</Status>
            </p>
            <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
              <div>
                <dt>Deployment ID</dt>
                <dd>
                  <code>{detail.id}</code>
                  <Copy value={detail.id} />
                </dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>
                  <code>{detail.hostname}</code>
                </dd>
              </div>
              <div>
                <dt>Artifact digest</dt>
                <dd>
                  <code>{detail.artifact}</code>
                  <Copy value={detail.artifact} />
                </dd>
              </div>
              <div>
                <dt>Deployed by</dt>
                <dd>{detail.deployedBy ?? "—"}</dd>
              </div>
              <div>
                <dt>Deployed</dt>
                <dd>
                  {new Date(detail.deployedAt).toLocaleString()} · {relativeTime(detail.deployedAt)}
                </dd>
              </div>
            </dl>
          </Panel>

          <BindingsSummary bindings={detail.bindings} resources={detail.resources} />

          <Panel variant="wide">
            <PanelHeading title="Artifact manifest" />
            {detail.manifest ? (
              <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
                {COMPARED.map(([key, label]) => (
                  <div key={key}>
                    <dt>{label}</dt>
                    <dd>
                      <code>{String(detail.manifest?.[key])}</code>
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mb-4 text-[0.85rem] text-muted-foreground">
                Artifact metadata is unavailable{detail.manifestError ? `: ${detail.manifestError}` : "."}
              </p>
            )}
          </Panel>

          <Compare name={name} current={detail} versions={deployments.filter((version) => version.id !== detail.id)} />

          <Panel>
            <PanelHeading title="Actions" />
            {detail.active ? (
              <StatusMessage>
                The active version can&apos;t be rolled back or deleted. Roll back another version, or replace it with a
                new deploy.
              </StatusMessage>
            ) : (
              <div data-slot="form-actions" className={FORM_ACTIONS}>
                <ConfirmButton
                  label="Roll back to this version"
                  busyLabel="Rolling back…"
                  variant="quiet"
                  disabled={busy}
                  title={`Roll back to ${detail.id.slice(0, 8)}?`}
                  description={
                    <>
                      This version starts serving <code>{detail.hostname}</code> immediately, and the current active
                      version becomes superseded.
                    </>
                  }
                  confirmLabel="Roll back"
                  onConfirm={rollback}
                />
                <ConfirmButton
                  label="Delete version"
                  busyLabel="Deleting…"
                  disabled={busy}
                  title={`Delete version ${detail.id.slice(0, 8)}?`}
                  description={
                    <>Its artifact is removed if nothing else references the digest. This cannot be undone.</>
                  }
                  confirmLabel="Delete version"
                  onConfirm={remove}
                />
              </div>
            )}
            {error && <StatusMessage tone="error">{error}</StatusMessage>}
          </Panel>
        </>
      )}
    </>
  );
}

type BindingRow = { binding: string; kind: string };

const bindingRow = (binding: string, kind: string): BindingRow => ({ binding, kind });

/** #76 — what this version was built to reach, alongside its manifest. */
function BindingsSummary({ bindings, resources }: { bindings: Bindings | null; resources: Resource[] }) {
  if (!bindings) return null;
  const rows: BindingRow[] = [
    ...bindings.kv.map((binding) => bindingRow(binding, "KV namespace")),
    ...bindings.d1.map((binding) => bindingRow(binding, "D1 database")),
    ...bindings.r2.map((binding) => bindingRow(binding, "R2 bucket")),
    ...bindings.queues.map((binding) => bindingRow(binding, "Queue")),
    ...bindings.secrets.map((binding) => bindingRow(binding, "Secret")),
    ...bindings.analytics.map((binding) => bindingRow(binding, "Analytics dataset")),
    ...bindings.durableObjects.map((entry) => bindingRow(entry.binding, `Durable Object · ${entry.className}`)),
    ...(bindings.assets ? [bindingRow(bindings.assets, "Static assets")] : []),
  ];
  if (rows.length === 0 && bindings.outbound.length === 0) return null;

  return (
    <Panel variant="wide">
      <PanelHeading title="Bindings in this version" description="Baked into the artifact at build time." />
      {rows.length > 0 && (
        <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
          {rows.map((entry) => (
            <div key={`${entry.kind}:${entry.binding}`}>
              <dt>{entry.kind}</dt>
              <dd>
                <code>{entry.binding}</code>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {bindings.outbound.length > 0 && (
        <p className="mt-3 text-[0.75rem] text-muted-foreground">
          Outbound fetch allowed to:{" "}
          {bindings.outbound.map((host) => (
            <code key={host}>{host} </code>
          ))}
        </p>
      )}
      {resources.length > 0 && (
        <p className="mt-3 text-[0.75rem] text-muted-foreground">
          Bound account resources: {resources.map((resource) => `${resource.name} (${resource.id})`).join(", ")}
        </p>
      )}
    </Panel>
  );
}

/**
 * #76 — compare two versions the way Cloudflare's version diff does. Both
 * manifests are already served by the detail endpoint, so the diff is computed
 * here from a second fetch rather than adding a compare endpoint.
 */
function Compare({
  name,
  current,
  versions,
}: {
  name: string;
  current: Detail;
  versions: Array<{ id: string; deployedAt: string; active: boolean }>;
}) {
  const [otherId, setOtherId] = useState("");
  const [other, setOther] = useState<Detail>();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!otherId) {
      setState("idle");
      setOther(undefined);
      return;
    }
    let ignore = false;
    setState("loading");
    void fetch(`/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(otherId)}`, {
      credentials: "include",
    })
      .then(async (response) => {
        if (ignore) return;
        if (!response.ok) {
          setState("error");
          return;
        }
        // SAFETY: a 2xx from the deployment-detail endpoint is the Detail contract.
        const body = (await response.json()) as Detail;
        if (ignore) return;
        setOther(body);
        setState("ready");
      })
      .catch(() => {
        if (!ignore) setState("error");
      });
    return () => {
      ignore = true;
    };
  }, [name, otherId]);

  if (versions.length === 0) return null;

  const options = [
    ["", "Choose a version…"] as const,
    ...versions.map(
      (version) =>
        [
          version.id,
          `${version.id.slice(0, 8)} · ${relativeTime(version.deployedAt)}${version.active ? " · active" : ""}`,
        ] as const,
    ),
  ];
  const differences =
    current.manifest && other?.manifest
      ? COMPARED.filter(([key]) => String(current.manifest?.[key]) !== String(other.manifest?.[key]))
      : [];

  return (
    <Panel variant="wide">
      <PanelHeading
        title="Compare with another version"
        description="Which build inputs changed between two versions of this project."
      />
      <div className={FILTER_BAR}>
        {/* A version id is short — the picker is sized to its content rather
            than stretched across the panel like a search field. */}
        <SelectField
          label="Compare against"
          fieldClassName="w-[24rem] max-w-full"
          value={otherId}
          options={options}
          onValueChange={(value) => setOtherId(value)}
        />
      </div>

      {state === "loading" ? (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">
          Loading that version…
        </p>
      ) : state === "error" ? (
        <StatusMessage tone="error">Could not load that version.</StatusMessage>
      ) : state === "ready" && other ? (
        !current.manifest || !other.manifest ? (
          <StatusMessage>One of these versions has no readable manifest, so there is nothing to compare.</StatusMessage>
        ) : differences.length === 0 ? (
          <StatusMessage tone="success">
            Identical build inputs — these versions differ only by when they were deployed.
          </StatusMessage>
        ) : (
          <DataTable
            caption="Manifest differences between the two versions"
            className="[&_.compare-current]:text-sky"
            head={
              <tr>
                <th scope="col">Field</th>
                <th scope="col">{other.id.slice(0, 8)}</th>
                <th scope="col">{current.id.slice(0, 8)} (this version)</th>
              </tr>
            }
          >
            {differences.map(([key, label]) => (
              <tr key={key}>
                <td>{label}</td>
                <td>
                  <code>{String(other.manifest?.[key])}</code>
                </td>
                <td>
                  <code className="text-sky">{String(current.manifest?.[key])}</code>
                </td>
              </tr>
            ))}
          </DataTable>
        )
      ) : null}
    </Panel>
  );
}
