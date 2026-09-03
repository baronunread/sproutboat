import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button, ConfirmButton, Copy, PanelHeading, StatusMessage, TextField } from "./components";
import { mutate, relativeTime, useJson } from "./dashboard-data";

/**
 * #77 — one product surface per resource kind, the way Cloudflare gives R2, KV,
 * D1 and Queues their own pages: a product header with its own description and
 * primary action, a searchable list, and a usage rail. Each kind is a separate
 * page over its own `/api/<kind>` collection; this module is the shared
 * furniture, not a generic "resources" screen.
 */

export type Product = {
  /** URL segment and API collection: /kv -> /api/kv. */
  segment: "kv" | "d1" | "r2" | "queues";
  title: string;
  /** What one of them is called, for buttons and empty states. */
  noun: string;
  description: string;
  /** The binding shape to paste into sproutboat.jsonc. */
  bindingExample: string;
  icon: "kv" | "d1" | "r2" | "queues";
};

type Resource = { id: string; kind: string; name: string; createdAt: string; projects?: string[] };

const NAME_RULE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const ICONS = {
  kv: <><rect x="2.5" y="4.5" width="11" height="7" rx="1.5" /><path d="M5.5 8h5" /></>,
  d1: <><ellipse cx="8" cy="4" rx="5" ry="1.8" /><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" /><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" /></>,
  r2: <><path d="M2.5 5.2 8 2.5l5.5 2.7v5.6L8 13.5 2.5 11.1z" /><path d="M2.5 5.2 8 8l5.5-2.8M8 8v5.5" /></>,
  queues: <><rect x="2.5" y="3.5" width="11" height="3" rx="1" /><rect x="2.5" y="9.5" width="11" height="3" rx="1" /></>,
} satisfies Record<Product["icon"], ReactNode>;

function ProductIcon({ icon }: { icon: Product["icon"] }) {
  return (
    <svg className="product-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"
      strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[icon]}
    </svg>
  );
}

export function ResourceList({ product }: { product: Product }) {
  const { data, state, refresh } = useJson<{ resources: Resource[] }>(`/api/${product.segment}`);
  const [query, setQuery] = useState("");
  const [note, setNote] = useState<{ text: string; tone: "success" | "error" } | null>(null);

  const resources = data?.resources ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? resources.filter((resource) => `${resource.name} ${resource.id}`.toLowerCase().includes(needle))
    : resources;

  return (
    <>
      <section className="product-heading">
        <div>
          <h1><ProductIcon icon={product.icon} />{product.title}</h1>
          <p>{product.description}</p>
        </div>
        <div className="product-actions">
          <Link className="button primary" to={`/${product.segment}/new`}>Create {product.noun}</Link>
        </div>
      </section>

      <div className="product-body">
        <div>
          <section className="data-panel">
            <div className="product-search">
              <TextField label={`Search ${product.title}`} hideLabel type="search" fieldClassName="grow"
                placeholder={`Search ${product.title}…`}
                value={query} onChange={(event) => setQuery(event.target.value)} />
              <Button onClick={() => void refresh()} aria-label="Refresh list">Refresh</Button>
            </div>

            {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}

            {state === "loading" ? (
              <p className="loading-state" aria-live="polite">Loading {product.title}…</p>
            ) : state === "error" ? (
              <p className="form-error" role="alert">Could not load {product.title}. Refresh and try again.</p>
            ) : resources.length === 0 ? (
              <div className="empty-state">
                <h2>No {product.title} yet</h2>
                <p>Create one, then bind it by id from your project config.</p>
                <code>{product.bindingExample}</code>
              </div>
            ) : shown.length === 0 ? (
              <p className="empty-state">Nothing matches “{query.trim()}”.</p>
            ) : (
              <div className="log-scroll">
                <table className="log-table">
                  <caption className="visually-hidden">{product.title} in this account</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">ID</th>
                      <th scope="col">Bound to</th>
                      <th scope="col">Created</th>
                      <th scope="col" className="actions"><span className="visually-hidden">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((resource) => (
                      <Row key={resource.id} product={product} resource={resource}
                        onChanged={async (text, tone = "success") => { setNote({ text, tone }); await refresh(); }} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <UsageRail product={product} count={resources.length} />
      </div>
    </>
  );
}

function Row({ product, resource, onChanged }: {
  product: Product;
  resource: Resource;
  onChanged: (text: string, tone?: "success" | "error") => Promise<void>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(resource.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/${product.segment}/${encodeURIComponent(resource.id)}`;

  const rename = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!NAME_RULE.test(trimmed)) { setError("Use 2–63 lowercase letters, digits or hyphens."); return; }
    setBusy(true);
    const failure = await mutate(base, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    setRenaming(false); setError(null);
    await onChanged(`Renamed to “${trimmed}”.`);
  };

  const remove = async () => {
    const failure = await mutate(base, { method: "DELETE" });
    await onChanged(failure ?? `Deleted “${resource.name}”.`, failure ? "error" : "success");
  };

  if (renaming) {
    return (
      <tr>
        <td colSpan={5}>
          <form className="rename-form" onSubmit={(event) => void rename(event)}>
            <TextField label={`New name for ${resource.name}`} hideLabel value={name} autoComplete="off" spellCheck={false}
              error={error} onChange={(event) => { setName(event.target.value); setError(null); }} />
            <Button type="submit" variant="primary" busy={busy} busyLabel="Saving…">Save</Button>
            <Button onClick={() => { setRenaming(false); setName(resource.name); setError(null); }}>Cancel</Button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td><strong>{resource.name}</strong></td>
      <td className="resource-id">
        <code title={resource.id}>{resource.id.slice(0, 14)}…</code>
        <Copy value={resource.id} />
      </td>
      <td>{resource.projects?.length ? resource.projects.join(", ") : "—"}</td>
      <td>{relativeTime(resource.createdAt)}</td>
      <td className="actions row-actions">
        <Button onClick={() => setRenaming(true)}>Rename</Button>
        <ConfirmButton
          label="Delete"
          busyLabel="Deleting…"
          triggerVariant="quiet"
          title={`Delete “${resource.name}”?`}
          description={
            <>
              This removes the {product.noun} <code>{resource.id}</code> and the data it holds. One still bound by a
              deployed version cannot be deleted — redeploy those projects without it first. This cannot be undone.
            </>
          }
          confirmLabel={`Delete ${product.noun}`}
          onConfirm={remove}
        />
      </td>
    </tr>
  );
}

/** The usage rail Cloudflare keeps beside every product list. */
function UsageRail({ product, count }: { product: Product; count: number }) {
  const { data } = useJson<{ limits: { resourcesPerAccount: number }; usage: { resources: number } }>("/api/limits");
  const cap = data?.limits.resourcesPerAccount;
  const used = data?.usage.resources;
  const percent = cap && used !== undefined ? Math.min(100, Math.round((used / cap) * 100)) : 0;

  return (
    <aside className="usage-rail" aria-label="Usage">
      <section className="data-panel settings-panel">
        <PanelHeading title="Usage" />
        <p className="usage-figure">{count}</p>
        <p className="hint">{product.title} in this account.</p>
        {cap !== undefined && used !== undefined && (
          <>
            <div className="usage-meter-head">
              <span>All storage resources</span>
              <strong>{used} / {cap}</strong>
            </div>
            <div className="usage-track" aria-hidden="true"><div className="usage-fill" style={{ width: `${percent}%` }} /></div>
          </>
        )}
      </section>
      <section className="data-panel settings-panel">
        <PanelHeading title="Bind it" />
        <p className="hint">Add the handle to <code>sproutboat.jsonc</code>, then deploy.</p>
        <pre className="console-output">{product.bindingExample}</pre>
      </section>
    </aside>
  );
}

/** The create form, on its own page like Cloudflare's create flows. */
export function CreateResource({ product }: { product: Product }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = name.trim() !== "" && !NAME_RULE.test(name.trim());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!NAME_RULE.test(trimmed)) { setError("Use 2–63 lowercase letters, digits or hyphens."); return; }
    setBusy(true); setError(null);
    const failure = await mutate(`/api/${product.segment}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (failure) { setError(failure); return; }
    void navigate({ to: `/${product.segment}` });
  };

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="crumb"><Link to={`/${product.segment}`}>{product.title}</Link> <span>/</span> Create</p>
          <h1>Create {product.noun}</h1>
          <p>{product.description}</p>
        </div>
      </section>

      <section className="data-panel settings-panel">
        <form className="form-grid" onSubmit={(event) => void submit(event)}>
          <TextField
            label={`${product.noun[0].toUpperCase()}${product.noun.slice(1)} name`}
            value={name}
            onChange={(event) => { setName(event.target.value); setError(null); }}
            placeholder="my-resource"
            autoComplete="off"
            spellCheck={false}
            required
            autoFocus
            hint="2–63 characters: lowercase letters, digits and hyphens. The id is generated for you."
            error={invalid ? "Use lowercase letters, digits and hyphens only." : error}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" busy={busy} busyLabel="Creating…" disabled={!name.trim() || invalid}>
              Create {product.noun}
            </Button>
            <Link className="button quiet" to={`/${product.segment}`}>Cancel</Link>
          </div>
        </form>
      </section>
    </>
  );
}
