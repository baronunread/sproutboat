import {
  Badge,
  Banner,
  Button,
  Checkbox,
  CodeBlock,
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
  RadioGroup,
  SensitiveInput,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableError,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  toast,
} from "@sproutboat/ikada";
import type { Status } from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { groupLabel, groupName, useActivityTypes } from "../activity-feed";
import { ConfirmDialog } from "../confirm-dialog";
import { mutate, relativeTime, useJson } from "../dashboard-data";
import { Section } from "../page-state";

export const Route = createFileRoute("/settings/webhooks")({
  component: Webhooks,
  head: () => ({ meta: [{ title: "Webhooks · Sproutboat" }] }),
});

type Format = "json" | "discord";
type Webhook = {
  id: string;
  url: string;
  types: string[];
  format: Format;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
type Delivery = {
  id: string;
  eventId: number;
  eventType: string;
  attempt: number;
  state: "pending" | "delivered" | "failed" | "refused";
  httpStatus: number | null;
  error: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  deliveredAt: string | null;
};

const FORMATS = [
  { value: "json", label: "Generic JSON", description: "The event as a JSON document, signed." },
  { value: "discord", label: "Discord", description: "A message for a Discord channel webhook URL." },
] as const;

const JSON_HEADERS = { "content-type": "application/json" };

const typesSummary = (types: readonly string[]) =>
  types.length === 0
    ? "All events"
    : [...new Set(types.map((token) => (token.endsWith(".*") ? groupLabel(token) : token)))].join(", ");

function Webhooks() {
  const { data, state, refresh } = useJson<{ webhooks: Webhook[] }>("/api/webhooks");
  const hooks = data?.webhooks ?? [];

  return (
    <Section
      title="Webhooks"
      description="Send a signed request to a URL whenever something in your Activity feed happens. Each delivery is retried a few times, then marked failed."
      action={<WebhookDialog onSaved={() => void refresh()} />}
    >
      {state === "ready" && hooks.length === 0 ? (
        <EmptyState
          title="No webhooks yet"
          description="Add a URL to get deploy, secret, domain and token events as they happen."
        />
      ) : (
        <Table label="Webhooks" aria-busy={state === "loading" || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>URL</TableHead>
              <TableHead hideBelow="md">Format</TableHead>
              <TableHead hideBelow="lg">Events</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state === "loading" ? (
              <TableLoading columns={5} />
            ) : state === "error" ? (
              <TableError colSpan={5} title="Could not load webhooks">
                Refresh and try again.
              </TableError>
            ) : (
              hooks.map((hook) => <WebhookRow key={hook.id} hook={hook} onChanged={() => void refresh()} />)
            )}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

function WebhookRow({ hook, onChanged }: { hook: Webhook; onChanged: () => void }) {
  const [enabled, setEnabled] = useState(hook.enabled);
  useEffect(() => setEnabled(hook.enabled), [hook.enabled]);

  async function toggle(next: boolean) {
    setEnabled(next);
    const failure = await mutate(`/api/webhooks/${encodeURIComponent(hook.id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: next }),
    });
    if (failure) {
      setEnabled(!next);
      toast.add({ tone: "danger", title: "Could not update the webhook", description: failure });
      return;
    }
    onChanged();
  }

  async function remove() {
    const failure = await mutate(`/api/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
    if (failure) return failure;
    toast.add({ tone: "success", title: "Webhook deleted" });
    onChanged();
    return null;
  }

  return (
    <TableRow>
      <TableCell className="min-w-56">
        <span className="block break-all font-semibold">{hook.url}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-fg-muted lg:hidden">
          <span>{typesSummary(hook.types)}</span>
        </span>
      </TableCell>
      <TableCell hideBelow="md">
        <Badge tone="neutral">{hook.format === "discord" ? "Discord" : "JSON"}</Badge>
      </TableCell>
      <TableCell hideBelow="lg" className="text-fg-muted">
        {typesSummary(hook.types)}
      </TableCell>
      <TableCell>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void toggle(next)}
          aria-label={`Enabled for ${hook.url}`}
        />
      </TableCell>
      <TableCell className="text-end">
        <span className="inline-flex flex-wrap items-center justify-end gap-2">
          <SendTestButton hook={hook} />
          <DeliveriesDialog hook={hook} />
          <WebhookDialog hook={hook} onSaved={onChanged} />
          <ConfirmDialog
            trigger="Delete"
            triggerLabel={`Delete webhook ${hook.url}`}
            title="Delete this webhook?"
            description={
              <>
                Events stop going to <code className="break-all">{hook.url}</code> and its delivery log is removed. This
                cannot be undone.
              </>
            }
            confirmLabel="Delete webhook"
            onConfirm={remove}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}

/** POST /test queues a `webhook.test` event for this one webhook; the delivery appears in its log. */
async function sendTest(hook: Webhook): Promise<string | null> {
  const failure = await mutate(`/api/webhooks/${encodeURIComponent(hook.id)}/test`, { method: "POST" });
  if (failure) {
    toast.add({ tone: "danger", title: "Could not send the test event", description: failure });
    return failure;
  }
  toast.add({ tone: "success", title: "Test event queued", description: "Open Deliveries to see how it went." });
  return null;
}

function SendTestButton({ hook }: { hook: Webhook }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      loading={busy}
      aria-label={`Send test to ${hook.url}`}
      onClick={() => {
        setBusy(true);
        void sendTest(hook).finally(() => setBusy(false));
      }}
    >
      Send test
    </Button>
  );
}

// ---------------------------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------------------------

const deliveryTone = {
  refused: "danger",
  failed: "danger",
  delivered: "success",
  pending: "neutral",
} satisfies Record<Delivery["state"], Status>;

function DeliveriesDialog({ hook }: { hook: Webhook }) {
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const { data, state, refresh } = useJson<{ deliveries: Delivery[] }>(
    open ? `/api/webhooks/${encodeURIComponent(hook.id)}/deliveries?limit=50` : null,
  );
  const deliveries = data?.deliveries ?? [];

  async function test() {
    setTesting(true);
    try {
      if ((await sendTest(hook)) === null) {
        await refresh();
        // The sender picks the delivery up a moment later; look once more.
        setTimeout(() => void refresh(), 1500);
      }
    } finally {
      setTesting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" aria-label={`Deliveries for ${hook.url}`} />}>Deliveries</DialogTrigger>
      <DialogContent className="max-w-3xl" hideClose>
        <div className="flex flex-col gap-4">
          <div>
            <DialogTitle>Deliveries</DialogTitle>
            <DialogDescription className="break-all">{hook.url}</DialogDescription>
          </div>
          <p className="text-sm text-fg-muted">
            Deliveries leave through the egress service, which refuses private addresses unless the operator sets{" "}
            <code>SB_EGRESS_ALLOW</code>.
          </p>
          <Table label="Deliveries">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>State</TableHead>
                <TableHead>Event</TableHead>
                <TableHead hideBelow="sm" className="text-end">
                  HTTP
                </TableHead>
                <TableHead hideBelow="sm" className="text-end">
                  Attempt
                </TableHead>
                <TableHead hideBelow="md">Detail</TableHead>
                <TableHead hideBelow="sm">When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state === "loading" && !data ? (
                <TableLoading columns={6} rows={3} />
              ) : state === "error" ? (
                <TableError colSpan={6} title="Could not load deliveries">
                  Close this and try again.
                </TableError>
              ) : deliveries.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={6} className="py-8 text-center text-fg-muted">
                    No deliveries yet. Send a test to see one.
                  </TableCell>
                </TableRow>
              ) : (
                deliveries.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell>
                      <Badge tone={deliveryTone[delivery.state]}>{delivery.state}</Badge>
                    </TableCell>
                    <TableCell>
                      <code className="break-all text-sm">{delivery.eventType}</code>
                    </TableCell>
                    <TableCell hideBelow="sm" className="text-end tabular-nums">
                      {delivery.httpStatus ?? "-"}
                    </TableCell>
                    <TableCell hideBelow="sm" className="text-end tabular-nums">
                      {delivery.attempt}
                    </TableCell>
                    <TableCell hideBelow="md" className="min-w-0 max-w-64 text-fg-muted">
                      <span className="line-clamp-2 break-words" title={delivery.error ?? undefined}>
                        {delivery.error ?? (delivery.state === "pending" && delivery.nextAttemptAt ? "Queued" : "-")}
                      </span>
                    </TableCell>
                    <TableCell hideBelow="sm" className="whitespace-nowrap text-fg-muted">
                      {relativeTime(delivery.deliveredAt ?? delivery.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <DialogFooter>
            <Button loading={testing} onClick={() => void test()}>
              Send test
            </Button>
            <Button onClick={() => void refresh()}>Refresh</Button>
            <DialogClose render={<Button variant="primary" />}>Close</DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------------
// Add and edit
// ---------------------------------------------------------------------------------------------

type Saved = Webhook & { secret?: string };

const SIGNATURE_SNIPPET = `x-sproutboat-signature: t=<unix>,v1=<hex hmac-sha256(secret, t + "." + body)>

// Node
import { createHmac } from "node:crypto";
const [t, v1] = header.split(",").map((part) => part.split("=")[1]);
const expected = createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
// Accept only when expected equals v1 and t is recent (for example within 5 minutes).`;

/** Expand stored filter tokens (`deploy.*` or exact types) into the set of exact types they cover. An empty list is every type. */
function expand(tokens: readonly string[], all: readonly string[]): Set<string> {
  if (tokens.length === 0) return new Set(all);
  const out = new Set<string>();
  for (const token of tokens) {
    if (token.endsWith(".*")) {
      const prefix = token.slice(0, -1);
      for (const type of all) if (type.startsWith(prefix)) out.add(type);
    } else out.add(token);
  }
  return out;
}

/** The smallest filter list that selects exactly `selected`: `[]` for every type, whole groups as `group.*`, the rest exact. */
function collapse(selected: ReadonlySet<string>, all: readonly string[]): string[] {
  if (all.every((type) => selected.has(type))) return [];
  const out: string[] = [];
  for (const group of new Set(all.map(groupName))) {
    const members = all.filter((type) => groupName(type) === group);
    if (members.every((type) => selected.has(type))) out.push(`${group}.*`);
    else out.push(...members.filter((type) => selected.has(type)));
  }
  return out;
}

function WebhookDialog({ hook, onSaved }: { hook?: Webhook; onSaved: () => void }) {
  const editing = hook !== undefined;
  const { data: catalog } = useActivityTypes();
  const allTypes = catalog?.types ?? [];
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(hook?.url ?? "");
  const [format, setFormat] = useState<Format>(hook?.format ?? "json");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Saved | null>(null);

  // Until the reader changes a box, the selection follows the webhook (or "everything" for a new one).
  const effective = touched ? selected : expand(hook?.types ?? [], allTypes);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setUrl(hook?.url ?? "");
      setFormat(hook?.format ?? "json");
      setTouched(false);
      setCreated(null);
      setError("");
    }
  }

  function toggleType(type: string, on: boolean) {
    const next = new Set(effective);
    if (on) next.add(type);
    else next.delete(type);
    setSelected(next);
    setTouched(true);
  }

  function toggleGroup(group: string, on: boolean) {
    const next = new Set(effective);
    for (const type of allTypes) {
      if (groupName(type) !== group) continue;
      if (on) next.add(type);
      else next.delete(type);
    }
    setSelected(next);
    setTouched(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (effective.size === 0) {
      setError("Pick at least one event type.");
      return;
    }
    setBusy(true);
    setError("");
    const body = { url: url.trim(), format, types: collapse(effective, allTypes) };
    try {
      const response = await fetch(editing ? `/api/webhooks/${encodeURIComponent(hook.id)}` : "/api/webhooks", {
        method: editing ? "PATCH" : "POST",
        credentials: "include",
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        // SAFETY: an error body from the webhooks API is { error?: string }.
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        setError(failure.error ?? `Request failed (${response.status}).`);
        return;
      }
      // SAFETY: a 2xx from POST or PATCH /api/webhooks is the webhook, plus `secret` on create only.
      const saved = (await response.json()) as Saved;
      onSaved();
      if (editing) {
        setOpen(false);
        toast.add({ tone: "success", title: "Webhook updated" });
      } else {
        setCreated(saved);
      }
    } catch {
      setError("Could not reach the control plane. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const groups = [...new Set(allTypes.map(groupName))];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={editing ? <Button size="sm" aria-label={`Edit webhook ${hook.url}`} /> : <Button variant="primary" />}
      >
        {editing ? "Edit" : "Add webhook"}
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        {created?.secret ? (
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle>Webhook created</DialogTitle>
              <DialogDescription>
                Copy the signing secret now: it is shown once and cannot be read again.
              </DialogDescription>
            </div>
            <Field label="Signing secret">
              <SensitiveInput readOnly copyable mono value={created.secret} />
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-semibold">Verify a delivery</p>
              <CodeBlock code={SIGNATURE_SNIPPET} label="Signature verification" />
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="primary" />}>Done</DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
            <div>
              <DialogTitle>{editing ? "Edit webhook" : "Add webhook"}</DialogTitle>
              <DialogDescription>
                {editing
                  ? "The signing secret does not change."
                  : "Events are sent as a signed POST. The signing secret is shown once, after you save."}
              </DialogDescription>
            </div>
            <Field label="URL" required error={error && !error.startsWith("Pick") ? error : undefined}>
              <Input
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com/hook"
                required
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <RadioGroup
              legend="Format"
              options={FORMATS}
              value={format}
              onValueChange={(next) => setFormat(next === "discord" ? "discord" : "json")}
            />
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="mb-1 text-sm font-semibold">Events</legend>
              {groups.map((group) => {
                const members = allTypes.filter((type) => groupName(type) === group);
                const count = members.filter((type) => effective.has(type)).length;
                return (
                  <div key={group} className="flex flex-col gap-1.5">
                    <Checkbox
                      label={groupLabel(group)}
                      checked={count === members.length}
                      indeterminate={count > 0 && count < members.length}
                      onCheckedChange={(on) => toggleGroup(group, on)}
                    />
                    <div className="grid gap-x-4 gap-y-1.5 ps-7 sm:grid-cols-2">
                      {members.map((type) => (
                        <Checkbox
                          key={type}
                          label={<code className="text-sm">{type}</code>}
                          checked={effective.has(type)}
                          onCheckedChange={(on) => toggleType(type, on)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
              {error.startsWith("Pick") ? <p className="text-sm text-danger-fg">{error}</p> : null}
            </fieldset>
            <Banner tone="info">
              Deliveries leave through the egress service, so a URL on a private address is refused unless the operator
              sets <code>SB_EGRESS_ALLOW</code>.
            </Banner>
            <DialogFooter>
              <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" loading={busy} disabled={url.trim() === ""}>
                {editing ? "Save changes" : "Add webhook"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
