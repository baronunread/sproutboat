import {
  Button,
  CodeBlock,
  CopyId,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  Input,
  Link,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  UsageMeter,
  toast,
} from "@sproutboat/ikada";
import { Link as RouterLink } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { mutate, relativeTime, useJson } from "./dashboard-data";
import { LoadError, Section } from "./page-state";

/**
 * One product surface per resource kind: a header with its own description and primary action,
 * a searchable table with a "Used by" column, and the account's storage allowance above it.
 * Each kind is a separate page over its own `/api/<kind>` collection; this module is the shared
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
};

type Resource = { id: string; kind: string; name: string; createdAt: string; projects?: string[] };

/** 2-63: a first and last character with up to 61 between them. Not an optional
 *  middle run - that also matches a single character, which the API rejects. */
const NAME_RULE = /^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/;
const NAME_ERROR = "Use 2-63 lowercase letters, digits or hyphens.";

const JSON_HEADERS = { "content-type": "application/json" };

export function ResourceList({ product }: { product: Product }) {
  const { data, state, refresh } = useJson<{ resources: Resource[] }>(`/api/${product.segment}`);
  const [query, setQuery] = useState("");

  const resources = data?.resources ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? resources.filter((resource) => `${resource.name} ${resource.id}`.toLowerCase().includes(needle))
    : resources;
  const columns = 5;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={product.title}
        description={product.description}
        actions={<CreateDialog product={product} onCreated={() => void refresh()} />}
      />

      {state === "error" ? (
        <LoadError what={product.title} onRetry={() => void refresh()} />
      ) : state === "ready" && resources.length === 0 ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState
            title={`No ${product.title} yet`}
            description="Create one, then bind it by id from your project config."
          >
            <CodeBlock
              code={product.bindingExample}
              label={`${product.noun} binding example`}
              className="mt-4 text-start"
            />
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
            <div className="w-full max-w-md">
              <Field label={`Search ${product.title}`} className="[&>label]:sr-only">
                <Input
                  type="search"
                  placeholder={`Search ${product.title}…`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </Field>
            </div>
            <StorageAllowance />
          </div>
          <Table label={product.title} aria-busy={state === "loading" || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Name</TableHead>
                <TableHead hideBelow="md">ID</TableHead>
                <TableHead>Used by</TableHead>
                <TableHead hideBelow="lg">Created</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state === "loading" ? (
                <TableLoading columns={columns} />
              ) : shown.length === 0 ? (
                <TableEmpty colSpan={columns}>
                  <span className="text-fg-muted">Nothing matches “{query.trim()}”.</span>
                </TableEmpty>
              ) : (
                shown.map((resource) => (
                  <ResourceRow key={resource.id} product={product} resource={resource} onChanged={refresh} />
                ))
              )}
            </TableBody>
          </Table>
          <Section
            title="Add a binding"
            description={
              <>
                Give it a handle in <code>sproutboat.jsonc</code>, then deploy.
              </>
            }
          >
            <CodeBlock code={product.bindingExample} label={`${product.noun} binding example`} />
          </Section>
        </>
      )}
    </div>
  );
}

/** The account's storage-resource allowance. It protects the box, so the bar turns amber near the cap and stays amber at it. */
function StorageAllowance() {
  const { data } = useJson<{ limits: { resourcesPerAccount: number }; usage: { resources: number } }>("/api/limits");
  if (!data) return null;
  return (
    <UsageMeter
      className="w-full max-w-xs"
      label="All storage resources"
      used={data.usage.resources}
      limit={data.limits.resourcesPerAccount}
    />
  );
}

function ResourceRow({
  product,
  resource,
  onChanged,
}: {
  product: Product;
  resource: Resource;
  onChanged: () => Promise<void>;
}) {
  const base = `/api/${product.segment}/${encodeURIComponent(resource.id)}`;
  const projects = resource.projects ?? [];

  const remove = async () => {
    const failure = await mutate(base, { method: "DELETE" });
    if (failure) return failure;
    toast.add({ tone: "success", title: `Deleted ${resource.name}` });
    await onChanged();
    return null;
  };

  const actions = (
    <span className="inline-flex items-center gap-2">
      <RenameDialog product={product} resource={resource} onRenamed={onChanged} />
      <ConfirmDialog
        trigger="Delete"
        triggerLabel={`Delete ${resource.name}`}
        title={`Delete ${resource.name}?`}
        description={
          <>
            This removes the {product.noun} <code>{resource.id}</code> and the data it holds. One still bound by a
            deployed version cannot be deleted: redeploy those projects without it first. This cannot be undone.
          </>
        }
        confirmLabel={`Delete ${product.noun}`}
        onConfirm={remove}
      />
    </span>
  );

  return (
    <TableRow>
      <TableCell className="min-w-40 font-semibold">
        {product.segment === "r2" ? (
          <Link render={<RouterLink to="/r2/$id" params={{ id: resource.id }} />} className="font-semibold">
            {resource.name}
          </Link>
        ) : (
          <span className="break-all">{resource.name}</span>
        )}
        <div className="mt-2 @md:hidden">{actions}</div>
      </TableCell>
      <TableCell hideBelow="md">
        <CopyId value={resource.id} display={`${resource.id.slice(0, 14)}…`} label={`Copy ${product.noun} ID`} />
      </TableCell>
      <TableCell>
        {projects.length === 0 ? (
          <span className="text-fg-muted">Not bound</span>
        ) : (
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            {projects.map((project) => (
              <Link key={project} render={<RouterLink to="/projects/$name" params={{ name: project }} />}>
                {project}
              </Link>
            ))}
          </span>
        )}
      </TableCell>
      <TableCell hideBelow="lg" className="whitespace-nowrap text-fg-muted tabular-nums">
        {relativeTime(resource.createdAt)}
      </TableCell>
      <TableCell hideBelow="md" className="whitespace-nowrap text-end">
        {actions}
      </TableCell>
    </TableRow>
  );
}

/** Name entry shared by create and rename: validates locally, shows the server's refusal inline. */
function NameDialog({
  trigger,
  triggerLabel,
  triggerVariant,
  triggerSize = "sm",
  title,
  description,
  submitLabel,
  initialName,
  placeholder,
  hint,
  request,
  onDone,
}: {
  trigger: string;
  triggerLabel?: string;
  triggerVariant?: "primary" | "secondary";
  triggerSize?: "sm" | "md";
  title: string;
  description: string;
  submitLabel: string;
  initialName: string;
  placeholder?: string;
  hint?: string;
  request: (name: string) => Promise<string | null>;
  onDone: (name: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmed = name.trim();
  const invalid = trimmed !== "" && !NAME_RULE.test(trimmed);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) setName(initialName);
    else setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!NAME_RULE.test(trimmed)) {
      setError(NAME_ERROR);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const failure = await request(trimmed);
      if (failure) {
        setError(failure);
        return;
      }
      setOpen(false);
      await onDone(trimmed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size={triggerSize} variant={triggerVariant} aria-label={triggerLabel} />}>
        {trigger}
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          <Field
            label="Name"
            description={hint}
            error={invalid ? "Use lowercase letters, numbers, and hyphens only." : error || undefined}
          >
            <Input
              value={name}
              mono
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
              }}
            />
          </Field>
          <DialogFooter className="mt-2">
            <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" loading={busy} disabled={trimmed === ""}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateDialog({ product, onCreated }: { product: Product; onCreated: () => void }) {
  return (
    <NameDialog
      trigger={`Create ${product.noun}`}
      triggerVariant="primary"
      triggerSize="md"
      title={`Create ${product.noun}`}
      description={product.nextStep}
      submitLabel={`Create ${product.noun}`}
      initialName=""
      placeholder={product.exampleName}
      hint={`2-63 characters. ${product.nameHint}`}
      request={(name) =>
        mutate(`/api/${product.segment}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }) })
      }
      onDone={(name) => {
        toast.add({
          tone: "success",
          title: `Created ${name}`,
          description: `Its id is generated; copy it from the ${product.title} table.`,
        });
        onCreated();
      }}
    />
  );
}

function RenameDialog({
  product,
  resource,
  onRenamed,
}: {
  product: Product;
  resource: Resource;
  onRenamed: () => Promise<void>;
}) {
  return (
    <NameDialog
      trigger="Rename"
      triggerLabel={`Rename ${resource.name}`}
      title={`Rename ${resource.name}`}
      description={`The id ${resource.id} stays the same, so existing bindings keep working.`}
      submitLabel="Save"
      initialName={resource.name}
      request={(name) =>
        mutate(`/api/${product.segment}/${encodeURIComponent(resource.id)}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name }),
        })
      }
      onDone={async (name) => {
        toast.add({ tone: "success", title: `Renamed to ${name}` });
        await onRenamed();
      }}
    />
  );
}
