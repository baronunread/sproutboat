import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, ConfirmButton, Copy, PanelHeading, SelectField, Shell, StatusMessage, TextField } from "../components";
import { mutate, relativeTime, useJson } from "../dashboard-data";

/**
 * #74/#76 — account-level storage resources in the UI. They are created and
 * deleted independently of any deploy, keyed by a stable `<kind>_<id>` handle
 * that a project binds by id, so data survives a redeploy and can be shared.
 * Until now this existed only in the CLI (`sproutboat resource …`).
 */
export const Route = createFileRoute("/storage")({
  component: Storage,
  head: () => ({ meta: [{ title: "Storage · Sproutboat" }] }),
});

type Resource = { id: string; kind: string; name: string; createdAt: string };

const KINDS = [
  ["kv", "KV namespace"], ["d1", "D1 database"], ["r2", "R2 bucket"], ["queue", "Queue"],
] as const;
const KIND_LABEL = new Map(KINDS);
const NAME_RULE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function Storage() {
  const { data, state, refresh } = useJson<{ resources: Resource[] }>("/api/resources");
  const [note, setNote] = useState<{ text: string; tone: "success" | "error" }>();
  const resources = data?.resources ?? [];

  return (
    <Shell>
      <section className="page-heading">
        <div>
          <h1>Storage</h1>
          <p>KV namespaces, D1 databases, R2 buckets and queues you own. Bind one to a project by id in <code>sproutboat.jsonc</code>.</p>
        </div>
      </section>

      <CreateResource
        existing={resources}
        onCreated={async (created) => { setNote({ text: `Created ${(KIND_LABEL.get(created.kind) ?? created.kind)} “${created.name}”.`, tone: "success" }); await refresh(); }}
      />

      <section className="data-panel">
        <PanelHeading title="Your resources" description={`${resources.length} in this account.`} />
        {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}
        {state === "loading" ? (
          <p className="loading-state" aria-live="polite">Loading resources…</p>
        ) : state === "error" ? (
          <p className="form-error" role="alert">Could not load resources. Refresh and try again.</p>
        ) : resources.length === 0 ? (
          <div className="empty-state">
            <h2>No storage yet</h2>
            <p>Create a namespace, database, bucket or queue above, then bind it by id from your project config.</p>
            <code>{`"bindings": { "kv": { "SESSIONS": { "id": "kv_…" } } }`}</code>
          </div>
        ) : (
          <ul className="record-list resource-list">
            {resources.map((resource) => (
              <ResourceRow key={resource.id} resource={resource}
                onChanged={async (text, tone = "success") => { setNote({ text, tone }); await refresh(); }} />
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}

function CreateResource({ existing, onCreated }: { existing: Resource[]; onCreated: (created: Resource) => Promise<void> }) {
  const [kind, setKind] = useState<string>("kv");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicate = existing.some((resource) => resource.kind === kind && resource.name === name.trim());
  const invalid = name.trim() !== "" && !NAME_RULE.test(name.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!NAME_RULE.test(trimmed)) { setError("Use 2–63 lowercase letters, digits or hyphens, starting and ending with a letter or digit."); return; }
    if (duplicate) { setError(`A ${(KIND_LABEL.get(kind) ?? kind)} named “${trimmed}” already exists.`); return; }
    setBusy(true); setError(null);
    const response = await fetch("/api/resources", {
      method: "POST", credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name: trimmed }),
    }).catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      // SAFETY: an error body from this endpoint is { error: string }.
      const body = await response?.json().catch(() => ({})) as { error?: string } | undefined;
      setError(body?.error ?? "Could not create that resource. Try again.");
      return;
    }
    // SAFETY: a 2xx from POST /api/resources is { resource: Resource }.
    const body = await response.json() as { resource: Resource };
    setName("");
    await onCreated(body.resource);
  };

  return (
    <section className="data-panel settings-panel">
      <PanelHeading title="Create a resource" description="The handle is generated; bind it by id so the data outlives any single version." />
      <form className="form-grid two-up" onSubmit={(event) => void submit(event)}>
        <SelectField label="Type" value={kind} options={KINDS} onChange={(event) => setKind(event.target.value)} />
        <TextField
          label="Name"
          value={name}
          onChange={(event) => { setName(event.target.value); setError(null); }}
          placeholder="sessions"
          autoComplete="off"
          spellCheck={false}
          required
          hint="2–63 characters: lowercase letters, digits and hyphens."
          error={invalid ? "Use lowercase letters, digits and hyphens only." : duplicate ? `You already have a ${(KIND_LABEL.get(kind) ?? kind)} with this name.` : error}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy} busyLabel="Creating…" disabled={!name.trim() || invalid || duplicate}>
            Create resource
          </Button>
        </div>
      </form>
    </section>
  );
}

function ResourceRow({ resource, onChanged }: {
  resource: Resource;
  onChanged: (message: string, tone?: "success" | "error") => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(resource.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!NAME_RULE.test(trimmed)) { setError("Use 2–63 lowercase letters, digits or hyphens."); return; }
    setBusy(true);
    const failure = await mutate(`/api/resources/${encodeURIComponent(resource.id)}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setRenaming(false); setError(null);
    await onChanged(`Renamed to “${trimmed}”.`);
  };

  const remove = async () => {
    const failure = await mutate(`/api/resources/${encodeURIComponent(resource.id)}`, { method: "DELETE" });
    // A bound resource comes back as a 409 naming the projects still using it.
    await onChanged(failure ?? `Deleted “${resource.name}”.`, failure ? "error" : "success");
  };

  return (
    <li className="resource-row">
      <div>
        {renaming ? (
          <form className="rename-form" onSubmit={(event) => void rename(event)}>
            <TextField label={`New name for ${resource.name}`} hideLabel value={name} autoComplete="off" spellCheck={false}
              error={error} onChange={(event) => { setName(event.target.value); setError(null); }} />
            <Button type="submit" variant="primary" busy={busy} busyLabel="Saving…">Save</Button>
            <Button variant="quiet" onClick={() => { setRenaming(false); setName(resource.name); setError(null); }}>Cancel</Button>
          </form>
        ) : (
          <>
            <strong>{resource.name}</strong>
            <small><code>{resource.id}</code><Copy value={resource.id} /></small>
          </>
        )}
      </div>
      <span className="badge neutral">{(KIND_LABEL.get(resource.kind) ?? resource.kind) ?? resource.kind}</span>
      <span>Created {relativeTime(resource.createdAt)}</span>
      {!renaming && <Button variant="quiet" onClick={() => setRenaming(true)}>Rename</Button>}
      {!renaming && (
        <ConfirmButton
          label="Delete"
          busyLabel="Deleting…"
          triggerVariant="quiet"
          title={`Delete “${resource.name}”?`}
          description={
            <>
              This removes the {(KIND_LABEL.get(resource.kind) ?? resource.kind) ?? resource.kind} <code>{resource.id}</code> and the data it holds.
              A resource still bound by a deployed version cannot be deleted — redeploy those projects without it first.
              This cannot be undone.
            </>
          }
          confirmLabel="Delete resource"
          onConfirm={remove}
        />
      )}
    </li>
  );
}
