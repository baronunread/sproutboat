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
  Field,
  Input,
  SensitiveInput,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatBytes,
  toast,
} from "@sproutboat/ikada";
import type { DescriptionItem } from "@sproutboat/ikada";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { mutate, useJson, useProject } from "../dashboard-data";
import { DeleteProjectDialog } from "../delete-project-dialog";
import { LoadingLine, Note, Section } from "../project-ui";

export const Route = createFileRoute("/projects_/$name/settings")({ component: ProjectSettings });

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
type Detail = { id: string; artifact: string; manifest: Manifest | null; manifestError: string | null };

const copyable = (value: string, label: string): DescriptionItem["details"] => <CopyId value={value} label={label} />;

/**
 * #2/#76 - project secrets. The API never returns a value, only the name, so
 * this panel lists names, sets or replaces a value, and deletes. A running
 * worker keeps the secrets it started with; a change lands on the next deploy
 * or sprout restart, which the panel says out loud.
 */
const SECRET_NAME_RULE = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRET_BYTES = 8 * 1024;

function Secrets({ name, hasVersions }: { name: string; hasVersions: boolean }) {
  const base = `/api/projects/${encodeURIComponent(name)}/secrets`;
  const { data, state, refresh } = useJson<{ names: string[] }>(base);
  // `null` is closed; an empty string opens a blank form; a name opens it for that secret.
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const names = data?.names ?? [];

  const remove = async (secret: string) => {
    setRemoveBusy(true);
    let failure: string | null;
    try {
      failure = await mutate(`${base}/${encodeURIComponent(secret)}`, { method: "DELETE" });
    } finally {
      setRemoveBusy(false);
    }
    setRemoving(null);
    if (failure) toast.add({ tone: "danger", title: `Could not delete ${secret}`, description: failure });
    else
      toast.add({
        tone: "success",
        title: `Deleted ${secret}`,
        description: "It applies on the next deploy or sprout restart.",
      });
    await refresh();
  };

  return (
    <Section
      id="secrets"
      title="Secrets"
      description="Encrypted at rest and handed to the deployment's binding broker. Values are never shown again after you save them."
      action={
        <Button variant="primary" disabled={!hasVersions} onClick={() => setEditing("")}>
          Add secret
        </Button>
      }
    >
      {/* The reason the button is dead belongs above the list, not buried where it reads as guidance. */}
      {!hasVersions && (
        <Banner tone="info">
          Deploy this project once before setting secrets: a secret is handed to a running version.
        </Banner>
      )}

      {state === "loading" ? (
        <LoadingLine label="Loading secrets…" />
      ) : state === "error" ? (
        <Banner tone="danger">Could not load secrets. Refresh and try again.</Banner>
      ) : names.length === 0 ? (
        <EmptyState
          as="h3"
          title="No secrets set"
          description={
            <>
              Your handler reads them from <code>env</code> once one is bound.
            </>
          }
        />
      ) : (
        <Table label="Secrets" containerClassName="shadow-none ring-1 ring-hairline">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead hideBelow="sm">Value</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {names.map((secret) => (
              <TableRow key={secret}>
                <TableCell className="font-mono text-sm break-all">{secret}</TableCell>
                <TableCell hideBelow="sm">
                  <Badge tone="neutral">Hidden</Badge>
                </TableCell>
                <TableCell className="text-end">
                  <span className="inline-flex flex-wrap justify-end gap-2">
                    <Button size="sm" aria-label={`Replace ${secret}`} onClick={() => setEditing(secret)}>
                      Replace
                    </Button>
                    <Button size="sm" aria-label={`Delete ${secret}`} onClick={() => setRemoving(secret)}>
                      Delete
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <SecretDialog base={base} existing={names} editing={editing} onClose={() => setEditing(null)} onSaved={refresh} />

      <Dialog open={removing !== null} onOpenChange={(open) => (open || removeBusy ? undefined : setRemoving(null))}>
        <DialogContent>
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle>Delete {removing}?</DialogTitle>
              <DialogDescription>
                The running version keeps its current value until the next deploy or sprout restart. This cannot be
                undone.
              </DialogDescription>
            </div>
            <DialogFooter className="mt-0">
              <DialogClose render={<Button disabled={removeBusy} />}>Cancel</DialogClose>
              <Button variant="danger" loading={removeBusy} onClick={() => removing && void remove(removing)}>
                Delete secret
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/** Add a secret, or replace the value of an existing one: setting a name that exists overwrites it. */
function SecretDialog({
  base,
  existing,
  editing,
  onClose,
  onSaved,
}: {
  base: string;
  existing: string[];
  editing: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [secretName, setSecretName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name field is seeded when the dialog opens for a given secret, not on every render.
  const [seeded, setSeeded] = useState<string | null>(null);
  if (editing !== seeded) {
    setSeeded(editing);
    setSecretName(editing ?? "");
    setValue("");
    setError(null);
  }

  const locked = editing !== null && editing !== "";
  const trimmedName = secretName.trim().toUpperCase();
  const invalidName = secretName.trim() !== "" && !SECRET_NAME_RULE.test(trimmedName);
  const tooLong = new TextEncoder().encode(value).length > MAX_SECRET_BYTES;
  const replacing = existing.includes(trimmedName);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!SECRET_NAME_RULE.test(trimmedName)) {
      setError("Use UPPER_SNAKE_CASE: letters, digits and underscores, starting with a letter.");
      return;
    }
    if (!value) {
      setError("A value is required.");
      return;
    }
    setBusy(true);
    setError(null);
    let failure: string | null;
    try {
      failure = await mutate(`${base}/${encodeURIComponent(trimmedName)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    } finally {
      setBusy(false);
    }
    if (failure) {
      setError(failure);
      return;
    }
    toast.add({
      tone: "success",
      title: `Saved ${trimmedName}`,
      description: "It applies on the next deploy or sprout restart.",
    });
    onClose();
    await onSaved();
  };

  return (
    <Dialog open={editing !== null} onOpenChange={(open) => (open || busy ? undefined : onClose())}>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <div>
            <DialogTitle>{locked ? `Replace ${editing}` : "Add a secret"}</DialogTitle>
            <DialogDescription>
              {locked
                ? "The new value replaces the old one. The old value cannot be read back."
                : "Setting an existing name replaces its value."}
            </DialogDescription>
          </div>
          <Field
            label="Name"
            description="UPPER_SNAKE_CASE, starting with a letter."
            error={invalidName ? "Use UPPER_SNAKE_CASE, starting with a letter." : null}
          >
            <Input
              mono
              value={secretName}
              readOnly={locked}
              placeholder="API_KEY"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setSecretName(event.target.value);
                setError(null);
              }}
            />
          </Field>
          {replacing && !locked ? (
            <p className="-mt-2 text-sm text-warn-fg">{trimmedName} already exists. Saving replaces its value.</p>
          ) : null}
          <Field
            label="Value"
            description="Stored encrypted; up to 8 KB."
            error={tooLong ? "Value exceeds the 8 KB limit." : error}
          >
            <SensitiveInput
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
          <DialogFooter className="mt-0">
            <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!secretName.trim() || !value || invalidName || tooLong}
            >
              Save secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSettings() {
  const { name, active, deployments } = useProject();
  const navigate = useNavigate();
  const { data: detail, state } = useJson<Detail>(
    active
      ? `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(active.activeDeploymentId)}`
      : null,
  );
  const manifest = detail?.manifest;

  const items: DescriptionItem[] = manifest
    ? [
        { id: "id", term: "Deployment ID", details: copyable(detail?.id ?? "", "Copy deployment ID") },
        { id: "target", term: "Target ABI", details: manifest.target, mono: true },
        { id: "runtime", term: "Runtime", details: manifest.runtime, mono: true },
        { id: "profile", term: "Compatibility profile", details: manifest.capabilityProfile, mono: true },
        { id: "schema", term: "Manifest schema", details: String(manifest.schemaVersion), mono: true },
        { id: "porffor", term: "Porffor toolchain", details: manifest.porfforVersion, mono: true },
        { id: "esbuild", term: "esbuild", details: manifest.esbuildVersion, mono: true },
        { id: "image", term: "Build image", details: copyable(manifest.buildImage, "Copy build image") },
        { id: "source", term: "Source hash", details: copyable(manifest.sourceHash, "Copy source hash") },
        { id: "binary", term: "Binary hash", details: copyable(manifest.binaryHash, "Copy binary hash") },
        {
          id: "size",
          term: "Binary size",
          details: `${manifest.binarySize.toLocaleString()} bytes (${formatBytes(manifest.binarySize)}, 16 MiB limit)`,
          mono: true,
        },
        { id: "built", term: "Built", details: manifest.builtAt, mono: true },
      ]
    : [];

  return (
    <div className="flex flex-col gap-4">
      <Section
        id="artifact"
        title="Active artifact"
        description={
          <>
            Immutable. These are baked into the deployed artifact: change your local config and run{" "}
            <code>sproutboat deploy</code> to produce a new version.
          </>
        }
      >
        {!active ? (
          <Note>
            No active deployment. Run <code>sproutboat deploy {name}</code> from the project directory to publish one.
          </Note>
        ) : state === "loading" ? (
          <LoadingLine label="Loading artifact details…" />
        ) : state === "error" ? (
          <Banner tone="danger">Could not load the active artifact. Refresh and try again.</Banner>
        ) : manifest ? (
          <DescriptionList items={items} />
        ) : (
          <Note>Artifact metadata is unavailable{detail?.manifestError ? `: ${detail.manifestError}` : "."}</Note>
        )}
      </Section>

      <Secrets name={name} hasVersions={deployments.length > 0} />

      <Section
        id="danger"
        title="Danger zone"
        description="Delete this project, every deployed version, and its route. This cannot be undone."
        action={
          <DeleteProjectDialog
            name={name}
            onDeleted={() => {
              toast.add({
                tone: "success",
                title: `Deleted ${name}`,
                description: "The project and every deployed version are gone.",
              });
              void navigate({ to: "/projects" });
            }}
          />
        }
      />
    </div>
  );
}
