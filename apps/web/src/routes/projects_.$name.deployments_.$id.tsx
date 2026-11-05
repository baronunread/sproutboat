import {
  Badge,
  Banner,
  Button,
  CopyId,
  DescriptionList,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  buttonStyles,
  formatBytes,
  toast,
} from "@sproutboat/ikada";
import type { DescriptionItem } from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { mutate, relativeTime, useProject } from "../dashboard-data";
import { Note, Section, fullTime } from "../project-ui";
import { RollbackDialog } from "../rollback-dialog";

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
  compileMs?: number;
  builtAt: string;
};
type Resource = { id: string; kind: string; name: string };
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
  resources: Array<{ binding: string; kind: string; id: string }>;
  vars?: Record<string, string>;
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
  ["compileMs", "Compile time (ms)"],
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
  const [rollback, setRollback] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const base = `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
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

  const remove = async () => {
    setError("");
    setBusy(true);
    let failure: string | null;
    try {
      failure = await mutate(base, { method: "DELETE" });
    } finally {
      setBusy(false);
    }
    if (failure) {
      setError(failure);
      setRemoving(false);
      return;
    }
    setRemoving(false);
    toast.add({ tone: "success", title: `Deleted version ${id.slice(0, 8)}` });
    await refresh();
    void navigate({ to: "/projects/$name/deployments", params: { name } });
  };

  const short = id.slice(0, 8);
  const manifest = detail?.manifest;

  return (
    <div className="flex flex-col gap-4">
      <RouterLink
        to="/projects/$name/deployments"
        params={{ name }}
        className="w-fit rounded-xs text-base text-fg-muted underline-offset-4 hover:text-fg hover:underline"
      >
        Back to deployments
      </RouterLink>

      {state === "loading" ? (
        <div className="flex min-h-56 flex-col gap-3" aria-live="polite" aria-busy="true">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
          <span className="sr-only">Loading deployment…</span>
        </div>
      ) : state === "missing" ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState
            as="h2"
            title="Deployment not found"
            description="This version may have been deleted."
            action={
              <RouterLink
                to="/projects/$name/deployments"
                params={{ name }}
                className={buttonStyles({ variant: "primary" })}
              >
                Back to deployments
              </RouterLink>
            }
          />
        </div>
      ) : state === "error" || !detail ? (
        <Banner tone="danger">Could not load this deployment. Refresh and try again.</Banner>
      ) : (
        <>
          <Section
            id="version"
            title={`Version ${detail.id.slice(0, 8)}`}
            description={
              detail.active ? (
                <Badge tone="success" dot live>
                  Active
                </Badge>
              ) : (
                <Badge tone="neutral">Inactive</Badge>
              )
            }
            action={
              detail.active ? undefined : (
                <>
                  <Button onClick={() => setRollback(true)} disabled={busy}>
                    Roll back to this version
                  </Button>
                  <Button variant="danger" onClick={() => setRemoving(true)} disabled={busy}>
                    Delete version
                  </Button>
                </>
              )
            }
          >
            {detail.active ? (
              <Banner tone="info">
                The active version can&apos;t be rolled back or deleted. Roll back another version, or replace it with a
                new deploy.
              </Banner>
            ) : null}
            {error ? <Banner tone="danger">{error}</Banner> : null}
            <DescriptionList
              items={[
                {
                  id: "id",
                  term: "Deployment ID",
                  details: <CopyId value={detail.id} label="Copy deployment ID" />,
                },
                { id: "route", term: "Route", details: detail.hostname, mono: true },
                {
                  id: "artifact",
                  term: "Artifact digest",
                  details: <CopyId value={detail.artifact} label="Copy artifact digest" />,
                },
                { id: "by", term: "Deployed by", details: detail.deployedBy ?? "-" },
                {
                  id: "at",
                  term: "Deployed",
                  details: `${fullTime(detail.deployedAt)} · ${relativeTime(detail.deployedAt)}`,
                },
              ]}
            />
          </Section>

          <BindingsSummary bindings={detail.bindings} resources={detail.resources} />

          <Section id="manifest" title="Artifact manifest">
            {manifest ? (
              <DescriptionList
                items={COMPARED.map(([key, label]) => ({
                  id: key,
                  term: label,
                  mono: true,
                  details: manifestValue(manifest, key),
                }))}
              />
            ) : (
              <Note>Artifact metadata is unavailable{detail.manifestError ? `: ${detail.manifestError}` : "."}</Note>
            )}
          </Section>

          <Compare name={name} current={detail} versions={deployments.filter((version) => version.id !== detail.id)} />

          <RollbackDialog
            name={name}
            target={rollback ? { id: detail.id, hostname: detail.hostname } : null}
            onClose={() => setRollback(false)}
            onDone={() => Promise.all([load(), refresh()]).then(() => undefined)}
          />

          <Dialog open={removing} onOpenChange={setRemoving}>
            <DialogContent>
              <div className="flex flex-col gap-4">
                <div>
                  <DialogTitle>Delete version {short}?</DialogTitle>
                  <DialogDescription>
                    Its artifact is removed if nothing else references the digest. This cannot be undone.
                  </DialogDescription>
                </div>
                <DialogFooter className="mt-0">
                  <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
                  <Button variant="danger" loading={busy} onClick={() => void remove()}>
                    Delete permanently
                  </Button>
                </DialogFooter>
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

function manifestValue(manifest: Manifest, key: keyof Manifest): string {
  const value = manifest[key];
  if (value === undefined) return "Unavailable";
  return key === "binarySize" ? `${value} (${formatBytes(Number(value))})` : String(value);
}

/** #76 - what this version was built to reach, alongside its manifest. */
function BindingsSummary({ bindings, resources }: { bindings: Bindings | null; resources: Resource[] }) {
  if (!bindings) return null;
  const rows: DescriptionItem[] = [
    ...bindings.kv.map((binding) => ["KV namespace", binding] as const),
    ...bindings.d1.map((binding) => ["D1 database", binding] as const),
    ...bindings.r2.map((binding) => ["R2 bucket", binding] as const),
    ...bindings.queues.map((binding) => ["Queue", binding] as const),
    ...bindings.secrets.map((binding) => ["Secret", binding] as const),
    ...bindings.analytics.map((binding) => ["Analytics dataset", binding] as const),
    ...bindings.durableObjects.map((entry) => [`Durable Object · ${entry.className}`, entry.binding] as const),
    ...(bindings.assets ? [["Static assets", bindings.assets] as const] : []),
    ...Object.keys(bindings.vars ?? {}).map((binding) => ["Variable", binding] as const),
  ].map(([kind, binding]) => ({ id: `${kind}:${binding}`, term: kind, details: binding, mono: true }));
  if (rows.length === 0) return null;

  return (
    <Section id="bindings" title="Bindings in this version" description="Baked into the artifact at build time.">
      <DescriptionList items={rows} />
      {resources.length > 0 && (
        <p className="text-sm text-fg-muted">
          Bound account resources: {resources.map((resource) => `${resource.name} (${resource.id})`).join(", ")}
        </p>
      )}
    </Section>
  );
}

/**
 * #76 - compare two versions the way Cloudflare's version diff does. Both
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

  // Loaded when the user picks a version, so the fetch belongs to that event.
  // `latest` drops a reply that a newer pick has already superseded.
  const latest = useRef("");
  const choose = (id: string) => {
    setOtherId(id);
    latest.current = id;
    if (!id) {
      setState("idle");
      setOther(undefined);
      return;
    }
    setState("loading");
    void fetch(`/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(id)}`, {
      credentials: "include",
    })
      .then(async (response) => {
        if (latest.current !== id) return;
        if (!response.ok) {
          setState("error");
          return;
        }
        // SAFETY: a 2xx from the deployment-detail endpoint is the Detail contract.
        const body = (await response.json()) as Detail;
        if (latest.current !== id) return;
        setOther(body);
        setState("ready");
      })
      .catch(() => {
        if (latest.current === id) setState("error");
      });
  };

  if (versions.length === 0) return null;

  const options = versions.map((version) => ({
    value: version.id,
    label: `${version.id.slice(0, 8)} · ${relativeTime(version.deployedAt)}${version.active ? " · active" : ""}`,
  }));
  const differences =
    current.manifest && other?.manifest
      ? COMPARED.filter(([key]) => String(current.manifest?.[key]) !== String(other.manifest?.[key]))
      : [];

  return (
    <Section
      id="compare"
      title="Compare with another version"
      description="Which build inputs changed between two versions of this project."
    >
      <div className="w-full max-w-sm">
        <Select
          aria-label="Compare against"
          value={otherId || null}
          options={options}
          placeholder="Choose a version…"
          onValueChange={(value) => choose(value ?? "")}
        />
      </div>

      {state === "loading" ? (
        <div className="min-h-24" aria-live="polite">
          <Skeleton className="h-24 w-full" />
          <span className="sr-only">Loading that version…</span>
        </div>
      ) : state === "error" ? (
        <Banner tone="danger">Could not load that version.</Banner>
      ) : state === "ready" && other ? (
        !current.manifest || !other.manifest ? (
          <Banner tone="info">One of these versions has no readable manifest, so there is nothing to compare.</Banner>
        ) : differences.length === 0 ? (
          <Banner tone="success">Identical build inputs: these versions differ only by when they were deployed.</Banner>
        ) : (
          <Table
            label="Manifest differences between the two versions"
            containerClassName="shadow-none ring-1 ring-hairline"
          >
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Field</TableHead>
                <TableHead>{other.id.slice(0, 8)}</TableHead>
                <TableHead>{current.id.slice(0, 8)} (this version)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {differences.map(([key, label]) => (
                <TableRow key={key}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="font-mono text-sm break-all">{String(other.manifest?.[key])}</TableCell>
                  <TableCell className="font-mono text-sm break-all text-info-fg">
                    {String(current.manifest?.[key])}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </Section>
  );
}
