import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Button, ConfirmButton, Copy, DeleteProject, Panel, PanelHeading, RecordList, RecordRow, StatusMessage, TextField } from "../components";
import { mutate, useJson, useProject } from "../dashboard-data";

export const Route = createFileRoute("/projects_/$name/settings")({ component: ProjectSettings });

type Manifest = {
  schemaVersion: number; target: string; runtime: string; capabilityProfile: string;
  porfforVersion: string; esbuildVersion: string; buildImage: string;
  sourceHash: string; binaryHash: string; binarySize: number; builtAt: string;
};
type Detail = { id: string; artifact: string; manifest: Manifest | null; manifestError: string | null };

function Value({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd><code>{value}</code>{copy && <Copy value={value} />}</dd>
    </div>
  );
}

/**
 * #2/#76 — project secrets. The API never returns a value, only the name, so
 * this panel lists names, sets or replaces a value, and deletes. A running
 * worker keeps the secrets it started with; a change lands on the next deploy
 * or sprout restart, which the panel says out loud.
 */
const SECRET_NAME_RULE = /^[A-Z][A-Z0-9_]*$/;
const MAX_SECRET_BYTES = 8 * 1024;

function Secrets({ name, hasVersions }: { name: string; hasVersions: boolean }) {
  const base = `/api/projects/${encodeURIComponent(name)}/secrets`;
  const { data, state, refresh } = useJson<{ names: string[] }>(base);
  const [secretName, setSecretName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  const names = data?.names ?? [];
  const trimmedName = secretName.trim().toUpperCase();
  const invalidName = secretName.trim() !== "" && !SECRET_NAME_RULE.test(trimmedName);
  const tooLong = new TextEncoder().encode(value).length > MAX_SECRET_BYTES;
  const replacing = names.includes(trimmedName);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!SECRET_NAME_RULE.test(trimmedName)) { setError("Use UPPER_SNAKE_CASE: letters, digits and underscores, starting with a letter."); return; }
    if (!value) { setError("A value is required."); return; }
    setBusy(true); setError(null); setNote(null);
    const failure = await mutate(`${base}/${encodeURIComponent(trimmedName)}`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setSecretName(""); setValue("");
    setNote({ text: `${trimmedName} saved. It applies on the next deploy or sprout restart.`, tone: "success" });
    await refresh();
  };

  const remove = async (secret: string) => {
    const failure = await mutate(`${base}/${encodeURIComponent(secret)}`, { method: "DELETE" });
    setNote({ text: failure ?? `Deleted ${secret}. It applies on the next deploy or sprout restart.`, tone: failure ? "error" : "success" });
    await refresh();
  };

  return (
    <Panel>
      <PanelHeading
        title="Secrets"
        description="Encrypted at rest and handed to the deployment's binding broker. Values are never shown again after you save them."
      />

      {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}

      {state === "loading" ? (
        <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading secrets…</p>
      ) : state === "error" ? (
        <StatusMessage tone="error">Could not load secrets. Refresh and try again.</StatusMessage>
      ) : names.length === 0 ? (
        <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No secrets set. Your handler reads them from <code>env</code> once one is bound.</p>
      ) : (
        <RecordList aria-label="Secrets">
          {names.map((secret) => (
            <RecordRow key={secret}>
              <div><strong><code>{secret}</code></strong><small>Value hidden</small></div>
              <ConfirmButton
                label="Delete"
                busyLabel="Deleting…"
                triggerVariant="quiet"
                title={`Delete ${secret}?`}
                description={<>The running version keeps its current value until the next deploy or sprout restart. This cannot be undone.</>}
                confirmLabel="Delete secret"
                onConfirm={() => remove(secret)}
              />
            </RecordRow>
          ))}
        </RecordList>
      )}

      <form className="mt-5 grid max-w-[36rem] gap-5 [&>[data-slot=form-actions]]:col-span-full" onSubmit={(event) => void submit(event)}>
        <TextField
          label="Name"
          value={secretName}
          onChange={(event) => { setSecretName(event.target.value); setError(null); }}
          placeholder="API_KEY"
          autoComplete="off"
          spellCheck={false}
          disabled={!hasVersions}
          hint="UPPER_SNAKE_CASE. Setting an existing name replaces its value."
          error={invalidName ? "Use UPPER_SNAKE_CASE, starting with a letter." : null}
          footer={replacing ? `${trimmedName} already exists — saving replaces its value.` : undefined}
        />
        <TextField
          label="Value"
          type="password"
          value={value}
          onChange={(event) => { setValue(event.target.value); setError(null); }}
          autoComplete="new-password"
          spellCheck={false}
          disabled={!hasVersions}
          hint={hasVersions ? "Stored encrypted; up to 8 KB." : "Deploy the project once before setting secrets."}
          error={tooLong ? "Value exceeds the 8 KB limit." : error}
        />
        <div data-slot="form-actions" className="mt-1 flex flex-wrap items-center gap-2.5">
          <Button type="submit" variant="primary" busy={busy} busyLabel="Saving…"
            disabled={!hasVersions || !secretName.trim() || !value || invalidName || tooLong}>
            {replacing ? "Replace secret" : "Add secret"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function ProjectSettings() {
  const { name, active, deployments } = useProject();
  const navigate = useNavigate();
  const { data: detail, state } = useJson<Detail>(
    active ? `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(active.activeDeploymentId)}` : null,
  );
  const manifest = detail?.manifest;

  return (
    <>
      <Panel variant="wide">
        <PanelHeading
          title="Active artifact"
          description={<>Immutable. These are baked into the deployed artifact — change your local config and run <code>sproutboat deploy</code> to produce a new version.</>}
        />
        {!active ? (
          <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">No active deployment. Run <code>sproutboat deploy {name}</code> from the project directory to publish one.</p>
        ) : state === "loading" ? (
          <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">Loading artifact details…</p>
        ) : state === "error" ? (
          <StatusMessage tone="error">Could not load the active artifact. Refresh and try again.</StatusMessage>
        ) : manifest ? (
          <dl className="mt-5 grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-x-8 gap-y-4 [&_code]:text-[0.78rem] [&_dd]:mt-1 [&_dd]:text-[0.85rem] [&_dd]:[overflow-wrap:anywhere] [&_dt]:text-[0.72rem] [&_dt]:tracking-wide [&_dt]:text-muted-foreground [&_dt]:uppercase">
            <Value label="Deployment ID" value={detail?.id ?? "—"} copy />
            <Value label="Target ABI" value={manifest.target} />
            <Value label="Runtime" value={manifest.runtime} />
            <Value label="Compatibility profile" value={manifest.capabilityProfile} />
            <Value label="Manifest schema" value={String(manifest.schemaVersion)} />
            <Value label="Porffor toolchain" value={manifest.porfforVersion} />
            <Value label="esbuild" value={manifest.esbuildVersion} />
            <Value label="Build image" value={manifest.buildImage} copy />
            <Value label="Source hash" value={manifest.sourceHash} copy />
            <Value label="Binary hash" value={manifest.binaryHash} copy />
            <div><dt>Binary size</dt><dd>{manifest.binarySize.toLocaleString()} bytes <span className="mt-3 text-[0.75rem] text-muted-foreground">(16 MiB limit)</span></dd></div>
            <Value label="Built" value={manifest.builtAt} />
          </dl>
        ) : (
          <p className="mb-4 text-[0.85rem] text-muted-foreground">Artifact metadata is unavailable{detail?.manifestError ? `: ${detail.manifestError}` : "."}</p>
        )}
      </Panel>

      <Secrets name={name} hasVersions={deployments.length > 0} />

      <Panel className="[&_h2]:text-destructive">
        <PanelHeading title="Danger zone" description="Delete this project, every deployed version, and its route. This cannot be undone." />
        <DeleteProject name={name} onDeleted={() => void navigate({ to: "/projects" })} />
      </Panel>
    </>
  );
}
