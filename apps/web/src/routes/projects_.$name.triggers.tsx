import {
  Badge,
  Banner,
  Button,
  CodeBlock,
  CopyId,
  DescriptionList,
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
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { FormEvent } from "react";
import { mutate, useJson, useProject } from "../dashboard-data";
import { LoadingLine, Section } from "../project-ui";

/**
 * #76 - Triggers: every way a request reaches this project. The generated
 * hostname is managed for you; custom domains are attached here, verified by a
 * TXT record, and then serve whichever version is active.
 */
export const Route = createFileRoute("/projects_/$name/triggers")({ component: ProjectTriggers });

type DomainRecord = {
  hostname: string;
  verified: boolean;
  verification: { type: string; name: string; value: string } | null;
  /** Present after an add/verify: this box's public addresses, and why DNS may not resolve yet. */
  serverAddresses?: string[];
  warning?: string;
};

const HOSTNAME_RULE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function ProjectTriggers() {
  const { name, active } = useProject();
  return (
    <div className="flex flex-col gap-4">
      <Section
        id="route"
        title="Route"
        description="Generated from the project and your namespace. It always serves the active version."
      >
        <DescriptionList
          items={[
            {
              id: "hostname",
              term: "Generated hostname",
              details: active ? (
                <CopyId value={active.hostname} label="Copy generated hostname" />
              ) : (
                <code className="font-mono text-sm text-fg-muted">{name}.&lt;namespace&gt;.sproutboat.com</code>
              ),
            },
            {
              id: "state",
              term: "State",
              details: active ? (
                <StatusDot status="success" live label="Serving the active version" />
              ) : (
                <StatusDot status="neutral" label="Not serving: deploy a version or roll one back" />
              ),
            },
          ]}
        />
      </Section>

      <CustomDomains name={name} hasActive={Boolean(active)} />

      <Section
        id="scheduled"
        title="Scheduled triggers"
        description="Cron schedules declared in the artifact fire against the active version."
      >
        <p className="text-base text-fg-muted [&_code]:font-mono [&_code]:text-sm [&_code]:text-fg">
          A <code>triggers.crons</code> entry in <code>sproutboat.jsonc</code> is frozen into the artifact and invokes
          your <code>scheduled()</code> handler on the active version. The declared schedules for this project are on
          the Bindings tab; per-run history is tracked in issue #81.
        </p>
      </Section>
    </div>
  );
}

function CustomDomains({ name, hasActive }: { name: string; hasActive: boolean }) {
  const base = `/api/projects/${encodeURIComponent(name)}/domains`;
  const { data, state, refresh } = useJson<DomainRecord[]>(base);
  const [reachability, setReachability] = useState<Record<string, DomainRecord>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const list = data ?? [];

  const verify = async (domain: string) => {
    setVerifying(domain);
    try {
      const response = await fetch(`${base}/${domain}/verify`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        // SAFETY: an error body from the domains endpoint is { error?: string }.
        const failure = (await response.json().catch(() => ({}))) as { error?: string };
        toast.add({
          tone: "danger",
          title: `Could not verify ${domain}`,
          description: failure.error ?? "Verification failed. Check the TXT record and try again.",
        });
        return;
      }
      // SAFETY: a 2xx from verify is a DomainRecord, with reachability attached.
      const body = (await response.json()) as DomainRecord;
      setReachability((current) => ({ ...current, [domain]: body }));
      toast.add({ tone: "success", title: `${domain} is verified` });
      await refresh();
    } catch {
      toast.add({
        tone: "danger",
        title: `Could not verify ${domain}`,
        description: "Could not reach the control plane. Try again.",
      });
    } finally {
      setVerifying(null);
    }
  };

  const remove = async (domain: string) => {
    const failure = await mutate(`${base}/${domain}`, { method: "DELETE" });
    if (failure) toast.add({ tone: "danger", title: `Could not remove ${domain}`, description: failure });
    else toast.add({ tone: "success", title: `Removed ${domain}` });
    setRemoving(null);
    await refresh();
  };

  return (
    <Section
      id="domains"
      title="Custom domains"
      description="Point your own hostname at this project. It serves the active version alongside the generated hostname."
      action={
        <AddDomain
          base={base}
          disabled={!hasActive}
          onAdded={async (created) => {
            setReachability((current) => ({ ...current, [created.hostname]: created }));
            await refresh();
          }}
        />
      }
    >
      {!hasActive && (
        <Banner tone="info">Deploy a version before attaching a domain: there is nothing for it to serve yet.</Banner>
      )}

      {state === "loading" ? (
        <LoadingLine label="Loading domains…" />
      ) : state === "error" ? (
        <Banner tone="danger">Could not load custom domains.</Banner>
      ) : list.length === 0 ? (
        <EmptyState
          as="h3"
          title="No custom domains attached"
          description="Add a hostname, then prove you own it with a TXT record."
        />
      ) : (
        <Table label="Custom domains" containerClassName="shadow-none ring-1 ring-hairline">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Hostname</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((domain) => (
              <TableRow key={domain.hostname}>
                <TableCell className="font-mono text-sm break-all">{domain.hostname}</TableCell>
                <TableCell>
                  {domain.verified ? (
                    <Badge tone="success" dot>
                      Verified
                    </Badge>
                  ) : (
                    <Badge tone="warning">Pending</Badge>
                  )}
                </TableCell>
                <TableCell className="text-end">
                  <span className="inline-flex flex-wrap justify-end gap-2">
                    {domain.verified ? null : (
                      <Button
                        size="sm"
                        loading={verifying === domain.hostname}
                        aria-label={`Verify ${domain.hostname}`}
                        onClick={() => void verify(domain.hostname)}
                      >
                        Verify
                      </Button>
                    )}
                    <Button
                      size="sm"
                      aria-label={`Remove ${domain.hostname}`}
                      onClick={() => setRemoving(domain.hostname)}
                    >
                      Remove
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {list.map((domain) => {
        const detail = reachability[domain.hostname];
        const record = domain.verification;
        if (!record && !detail?.warning && !detail?.serverAddresses?.length) return null;
        return (
          <div key={`${domain.hostname}:notes`} className="flex min-w-0 flex-col gap-2">
            <h3 className="font-mono text-sm font-semibold break-all">{domain.hostname}</h3>
            <div className="flex flex-col gap-2">
              {record ? (
                <>
                  <p className="text-sm text-fg-muted">Add this DNS record at your provider, then verify.</p>
                  <CodeBlock
                    label={`DNS ${record.type} record for ${domain.hostname}`}
                    code={`${record.name}  ${record.type}  ${record.value}`}
                    wrap
                  />
                </>
              ) : null}
              {detail?.warning ? <Banner tone="warning">{detail.warning}</Banner> : null}
              {detail?.serverAddresses?.length ? (
                <p className="text-sm text-fg-muted">
                  Point an A/AAAA record at{" "}
                  <code className="font-mono text-fg">{detail.serverAddresses.join(", ")}</code>, DNS-only.
                </p>
              ) : null}
            </div>
          </div>
        );
      })}

      <Dialog open={removing !== null} onOpenChange={(open) => (open ? undefined : setRemoving(null))}>
        <DialogContent>
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle>Remove {removing}?</DialogTitle>
              <DialogDescription>
                This hostname stops serving this project immediately. You can attach it again later.
              </DialogDescription>
            </div>
            <DialogFooter className="mt-0">
              <DialogClose render={<Button />}>Cancel</DialogClose>
              <Button variant="danger" onClick={() => removing && void remove(removing)}>
                Remove domain
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function AddDomain({
  base,
  disabled,
  onAdded,
}: {
  base: string;
  disabled: boolean;
  onAdded: (created: DomainRecord) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wanted = hostname.trim().toLowerCase();
  const invalid = wanted !== "" && !HOSTNAME_RULE.test(wanted);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setHostname("");
      setError(null);
    }
  };

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!HOSTNAME_RULE.test(wanted)) {
      setError("Enter a full hostname, like www.example.com.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(base, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname: wanted }),
      });
      if (!response.ok) {
        // SAFETY: an error body from the domains endpoint is { error: string }.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Could not attach that hostname (${response.status}).`);
        return;
      }
      // SAFETY: a 2xx from POST domains is a DomainRecord with serverAddresses.
      const created = (await response.json()) as DomainRecord;
      toast.add({
        tone: "success",
        title: `Added ${created.hostname}`,
        description: "Add the TXT record shown in the list, then verify.",
      });
      onOpenChange(false);
      await onAdded(created);
    } catch {
      setError("Could not reach the control plane. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="primary" disabled={disabled} />}>Add domain</DialogTrigger>
      <DialogContent>
        <form onSubmit={(event) => void add(event)} className="flex flex-col gap-4">
          <div>
            <DialogTitle>Add a custom domain</DialogTitle>
            <DialogDescription>
              A TXT record proves ownership; an A or AAAA record sends traffic here.
            </DialogDescription>
          </div>
          <Field
            label="Hostname"
            error={invalid ? "Enter a full hostname, like www.example.com." : error}
            description="For example www.example.com."
          >
            <Input
              type="text"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="www.example.com"
              value={hostname}
              onChange={(event) => {
                setHostname(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <DialogFooter className="mt-0">
            <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" loading={busy} disabled={!wanted || invalid}>
              Add domain
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
