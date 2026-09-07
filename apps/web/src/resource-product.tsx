import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Button,
  ConfirmButton,
  Copy,
  DataTable,
  EmptyState,
  FILTER_SEARCH,
  Panel,
  PanelHeading,
  StatusMessage,
  TextField,
} from "./components";
import { mutate, relativeTime, useJson } from "./dashboard-data";
import { buttonVariants } from "@/components/ui/button";
import { ArrowLeft, Box, Database, KeyRound, ListTodo } from "lucide-react";

/**
 * #77 - one product surface per resource kind, the way Cloudflare gives R2, KV,
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
  exampleName: string;
  nameHint: string;
  nextStep: string;
  idPrefix: "kv" | "d1" | "r2" | "queue";
  /** The binding shape to paste into sproutboat.jsonc. */
  bindingExample: string;
  icon: "kv" | "d1" | "r2" | "queues";
};

type Resource = { id: string; kind: string; name: string; createdAt: string; projects?: string[] };

/** 2-63: a first and last character with up to 61 between them. Not an optional
 *  middle run - that also matches a single character, which the API rejects. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;

const ICONS = { kv: KeyRound, d1: Database, r2: Box, queues: ListTodo };

function ProductIcon({ icon }: { icon: Product["icon"] }) {
  const Icon = ICONS[icon];
  return <Icon className="size-[1.6rem] shrink-0 text-brand" aria-hidden="true" strokeWidth={1.5} />;
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
      setError("Use 2-63 lowercase letters, digits or hyphens.");
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
      <td>{resource.projects?.length ? resource.projects.join(", ") : "-"}</td>
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
              deployed version cannot be deleted - redeploy those projects without it first. This cannot be undone.
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
          <div className="mt-5 h-[0.45rem] overflow-hidden rounded-full bg-secondary" aria-hidden="true">
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
      setError("Use 2-63 lowercase letters, digits or hyphens.");
      document.getElementById("resource-name")?.focus();
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

  const generatedId = `${product.idPrefix}_<24 hex characters>`;

  return (
    <div className="mx-auto max-w-[64rem]">
      <Link
        className="mb-7 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 text-[0.82rem] font-medium text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground"
        to={`/${product.segment}`}
      >
        <ArrowLeft className="size-4" aria-hidden="true" strokeWidth={1.5} />
        Back to {product.title.toLowerCase()}
      </Link>

      <header className="mb-8 flex items-start gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-brand/12 ring-1 ring-brand/25 [&_svg]:size-6">
          <ProductIcon icon={product.icon} />
        </div>
        <div>
          <h1 className="m-0 text-[2rem] leading-tight font-bold tracking-[-0.04em] max-[480px]:text-[1.7rem]">
            Create {product.noun}
          </h1>
          <p className="mt-2 max-w-[42rem] text-[0.9rem] leading-relaxed text-muted-foreground">
            {product.description}
          </p>
        </div>
      </header>

      <Panel variant="bare" className="overflow-hidden">
        <form onSubmit={(event) => void submit(event)}>
          <div className="grid grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)] max-[760px]:grid-cols-1">
            <div className="p-7 max-[480px]:p-5">
              <div className="mb-7">
                <h2 className="m-0 text-base font-semibold">Choose a name</h2>
                <p className="mt-1.5 max-w-[36rem] text-[0.82rem] leading-relaxed text-muted-foreground">
                  {product.nameHint}
                </p>
              </div>
              <TextField
                id="resource-name"
                label={`${product.noun[0].toUpperCase()}${product.noun.slice(1)} name`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(null);
                }}
                className="h-11 rounded-lg bg-background px-3.5 font-mono text-[0.9rem]"
                placeholder={product.exampleName}
                autoComplete="off"
                spellCheck={false}
                required
                autoFocus
                hint="2-63 characters. Use lowercase letters, numbers, and hyphens."
                error={invalid ? "Use lowercase letters, numbers, and hyphens only." : error}
              />
            </div>

            <aside className="border-s border-border bg-[color-mix(in_srgb,var(--color-brand)_5%,var(--color-card))] p-7 max-[760px]:border-t max-[760px]:border-s-0 max-[480px]:p-5">
              <h2 className="m-0 text-[0.8rem] font-semibold tracking-wide text-muted-foreground uppercase">
                After creation
              </h2>
              <p className="mt-3 text-[0.84rem] leading-relaxed text-foreground">{product.nextStep}</p>
              <dl className="mt-6 grid gap-4 text-[0.78rem]">
                <div>
                  <dt className="text-muted-foreground">Generated ID preview</dt>
                  <dd className="mt-1.5 m-0 overflow-hidden rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-[0.76rem] text-foreground">
                    <span className="block truncate">{generatedId}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Availability</dt>
                  <dd className="mt-1 m-0">Ready immediately after creation</dd>
                </div>
              </dl>
            </aside>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border bg-card px-7 py-5 max-[480px]:px-5 [&>*]:max-[480px]:w-full">
            <Link
              className={buttonVariants({ variant: "outline", size: "lg", className: "text-[0.84rem]" })}
              to={`/${product.segment}`}
            >
              Cancel
            </Link>
            <Button type="submit" variant="primary" busy={busy} busyLabel="Creating…" className="h-10 px-6">
              Create {product.noun}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}
