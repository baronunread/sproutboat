import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Button,
  ConfirmButton,
  Copy,
  DataTable,
  EmptyState,
  FILTER_SEARCH,
  FORM,
  FORM_ACTIONS,
  Panel,
  PanelHeading,
  StatusMessage,
  TextField,
} from "./components";
import { mutate, relativeTime, useJson } from "./dashboard-data";
import { buttonVariants } from "@/components/ui/button";

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

/** 2–63: a first and last character with up to 61 between them. Not an optional
 *  middle run — that also matches a single character, which the API rejects. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

const ICONS = {
  kv: (
    <>
      <rect x="2.5" y="4.5" width="11" height="7" rx="1.5" />
      <path d="M5.5 8h5" />
    </>
  ),
  d1: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="1.8" />
      <path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" />
      <path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
    </>
  ),
  r2: (
    <>
      <path d="M2.5 5.2 8 2.5l5.5 2.7v5.6L8 13.5 2.5 11.1z" />
      <path d="M2.5 5.2 8 8l5.5-2.8M8 8v5.5" />
    </>
  ),
  queues: (
    <>
      <rect x="2.5" y="3.5" width="11" height="3" rx="1" />
      <rect x="2.5" y="9.5" width="11" height="3" rx="1" />
    </>
  ),
} satisfies Record<Product["icon"], ReactNode>;

function ProductIcon({ icon }: { icon: Product["icon"] }) {
  return (
    <svg
      className="size-[1.6rem] shrink-0 text-brand"
      viewBox="0 0 16 16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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
      <section className="mb-8 flex flex-wrap items-start justify-between gap-x-8 gap-y-4 border-b border-border pb-7 [&_h1]:m-0 [&_h1]:flex [&_h1]:items-center [&_h1]:gap-2.5 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&>div>p]:mt-1.5 [&>div>p]:max-w-[44rem] [&>div>p]:text-[0.875rem] [&>div>p]:leading-normal [&>div>p]:text-muted-foreground">
        <div>
          <h1>
            <ProductIcon icon={product.icon} />
            {product.title}
          </h1>
          <p>{product.description}</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Link
            className={buttonVariants({ variant: "default", className: "text-[0.82rem]" })}
            to={`/${product.segment}/new`}
          >
            Create {product.noun}
          </Link>
        </div>
      </section>

      <div className="grid items-start gap-6 grid-cols-[minmax(0,1fr)_18rem] max-[1000px]:grid-cols-1 [&_table]:min-w-0">
        <div>
          <Panel variant="bare">
            <div className="flex flex-wrap items-end gap-2.5 px-5 py-[1.1rem]">
              <TextField
                label={`Search ${product.title}`}
                hideLabel
                type="search"
                fieldClassName={FILTER_SEARCH}
                placeholder={`Search ${product.title}…`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button onClick={() => void refresh()} aria-label="Refresh list">
                Refresh
              </Button>
            </div>

            {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}

            {state === "loading" ? (
              <p className="min-h-56 px-5 pt-12 text-muted-foreground group-[.is-padded]/panel:px-0" aria-live="polite">
                Loading {product.title}…
              </p>
            ) : state === "error" ? (
              <StatusMessage tone="error">Could not load {product.title}. Refresh and try again.</StatusMessage>
            ) : resources.length === 0 ? (
              <EmptyState title={`No ${product.title} yet`}>
                <p>Create one, then bind it by id from your project config.</p>
                <code className="mt-3 inline-block rounded-[5px] border border-border bg-background p-2.5 text-[0.76rem]">
                  {product.bindingExample}
                </code>
              </EmptyState>
            ) : shown.length === 0 ? (
              <p className="px-5 py-12 text-center text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start [&_code]:text-foreground">
                Nothing matches “{query.trim()}”.
              </p>
            ) : (
              <DataTable
                caption={`${product.title} in this account`}
                head={
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">ID</th>
                    <th scope="col">Bound to</th>
                    <th scope="col">Created</th>
                    <th scope="col" className="text-end">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                }
              >
                {shown.map((resource) => (
                  <Row
                    key={resource.id}
                    product={product}
                    resource={resource}
                    onChanged={async (text, tone = "success") => {
                      setNote({ text, tone });
                      await refresh();
                    }}
                  />
                ))}
              </DataTable>
            )}
          </Panel>
        </div>

        <UsageRail product={product} count={resources.length} />
      </div>
    </>
  );
}

function Row({
  product,
  resource,
  onChanged,
}: {
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
    if (!NAME_RULE.test(trimmed)) {
      setError("Use 2–63 lowercase letters, digits or hyphens.");
      return;
    }
    setBusy(true);
    const failure = await mutate(base, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    setRenaming(false);
    setError(null);
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
          <form className="flex flex-wrap items-end gap-2.5" onSubmit={(event) => void rename(event)}>
            <TextField
              label={`New name for ${resource.name}`}
              hideLabel
              fieldClassName={FILTER_SEARCH}
              value={name}
              autoComplete="off"
              spellCheck={false}
              error={error}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
            <Button
              onClick={() => {
                setRenaming(false);
                setName(resource.name);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} busyLabel="Saving…">
              Save
            </Button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td>
        <strong>{resource.name}</strong>
      </td>
      <td className="whitespace-nowrap">
        <code title={resource.id}>{resource.id.slice(0, 14)}…</code>
        <Copy value={resource.id} />
      </td>
      <td>{resource.projects?.length ? resource.projects.join(", ") : "—"}</td>
      <td>{relativeTime(resource.createdAt)}</td>
      <td className="flex items-center justify-end gap-2 [&_button]:h-8 [&_button]:px-2.5">
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
    <aside className="grid gap-6" aria-label="Usage">
      <Panel>
        <PanelHeading title="Usage" />
        {/* Both numbers are label/value pairs, so they share one set of edges
            instead of a display figure floating above an unrelated meter. */}
        <dl className="m-0 grid gap-2.5 [&>div]:flex [&>div]:items-baseline [&>div]:justify-between [&>div]:gap-4 [&_dd]:m-0 [&_dd]:text-[0.8rem] [&_dd]:font-semibold [&_dd]:whitespace-nowrap [&_dd]:tabular-nums [&_dt]:min-w-0 [&_dt]:text-[0.8rem] [&_dt]:text-muted-foreground">
          <div>
            <dt>{product.title}</dt>
            <dd>{count}</dd>
          </div>
          {cap !== undefined && used !== undefined && (
            <div>
              <dt>All storage resources</dt>
              <dd>
                {used} / {cap}
              </dd>
            </div>
          )}
        </dl>
        {cap !== undefined && used !== undefined && (
          <div className="mt-3.5 h-[0.45rem] overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div
              className="h-full min-w-0.5 rounded-[inherit] bg-sky transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
          </div>
        )}
      </Panel>
      <Panel>
        <PanelHeading title="Add a binding" />
        <p className="mt-3 text-[0.75rem] text-muted-foreground">
          Give it a handle in <code>sproutboat.jsonc</code>, then deploy.
        </p>
        <pre className="mt-3.5 overflow-x-auto rounded-md border border-border bg-background px-3.5 py-3 font-mono text-[0.7rem] leading-relaxed whitespace-pre">
          {product.bindingExample}
        </pre>
      </Panel>
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
    if (!NAME_RULE.test(trimmed)) {
      setError("Use 2–63 lowercase letters, digits or hyphens.");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await mutate(`/api/${product.segment}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: trimmed }),
    });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    void navigate({ to: `/${product.segment}` });
  };

  return (
    <>
      <section className="mb-8 flex items-center justify-between gap-8 border-b border-border pb-7 max-[800px]:mb-10 max-[800px]:flex-col max-[800px]:items-start [&_h1]:m-0 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&_h1]:max-[480px]:text-[1.6rem] [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.875rem] [&_p]:leading-normal [&_p]:text-muted-foreground">
        <div>
          <p className="m-0 mb-2 text-[0.78rem] text-muted-foreground [&_a]:underline-offset-2 [&_a:hover]:underline [&>span]:mx-1.5">
            <Link to={`/${product.segment}`}>{product.title}</Link> <span>/</span> Create
          </p>
          <h1>Create {product.noun}</h1>
          <p>{product.description}</p>
        </div>
      </section>

      <Panel>
        <form className={FORM} onSubmit={(event) => void submit(event)}>
          <TextField
            label={`${product.noun[0].toUpperCase()}${product.noun.slice(1)} name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder="my-resource"
            autoComplete="off"
            spellCheck={false}
            required
            autoFocus
            hint="2–63 characters: lowercase letters, digits and hyphens. The id is generated for you."
            error={invalid ? "Use lowercase letters, digits and hyphens only." : error}
          />
          {/* Cancel first, primary last — the order the confirm dialogs already
              use, so "the rightmost button commits" holds everywhere. */}
          <div data-slot="form-actions" className={FORM_ACTIONS}>
            <Link
              className={buttonVariants({ variant: "outline", className: "text-[0.82rem]" })}
              to={`/${product.segment}`}
            >
              Cancel
            </Link>
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              busyLabel="Creating…"
              disabled={!name.trim() || invalid}
            >
              Create {product.noun}
            </Button>
          </div>
        </form>
      </Panel>
    </>
  );
}
