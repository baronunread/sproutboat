import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, ConfirmButton, Copy, PanelHeading, StatusMessage, TextField } from "../components";
import { mutate, useJson, useProject } from "../dashboard-data";

/**
 * #76 — Triggers: every way a request reaches this project. The generated
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
    <>
      <section className="data-panel settings-panel">
        <PanelHeading title="Route" description="Generated from the project and your namespace. It always serves the active version." />
        <dl className="detail-grid">
          <div>
            <dt>Generated hostname</dt>
            <dd>
              <code>{active ? active.hostname : `${name}.<namespace>.sproutboat.com`}</code>
              {active && <Copy value={active.hostname} />}
            </dd>
          </div>
          <div>
            <dt>State</dt>
            <dd>{active ? "Serving the active version" : "Not serving — deploy a version or roll one back"}</dd>
          </div>
        </dl>
      </section>

      <CustomDomains name={name} hasActive={Boolean(active)} />

      <section className="data-panel settings-panel">
        <PanelHeading title="Scheduled triggers" description="Cron-triggered invocations are not implemented yet." />
        <p className="hint">
          Every invocation is request-driven today. Scheduled execution is tracked in issue #81; a schedule declared
          in <code>sproutboat.jsonc</code> is carried in the artifact but never fires.
        </p>
      </section>
    </>
  );
}

function CustomDomains({ name, hasActive }: { name: string; hasActive: boolean }) {
  const base = `/api/projects/${encodeURIComponent(name)}/domains`;
  const { data, state, refresh } = useJson<DomainRecord[]>(base);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [reachability, setReachability] = useState<Record<string, DomainRecord>>({});

  const list = data ?? [];
  const invalid = hostname.trim() !== "" && !HOSTNAME_RULE.test(hostname.trim().toLowerCase());

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const wanted = hostname.trim().toLowerCase();
    if (!HOSTNAME_RULE.test(wanted)) { setError("Enter a full hostname, like www.example.com."); return; }
    setBusy(true); setError(null); setNote(null);
    try {
      const response = await fetch(base, {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: wanted }),
      });
      if (!response.ok) {
        // SAFETY: an error body from the domains endpoint is { error: string }.
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `Could not attach that hostname (${response.status}).`);
        return;
      }
      // SAFETY: a 2xx from POST domains is a DomainRecord with serverAddresses.
      const created = await response.json() as DomainRecord;
      setReachability((current) => ({ ...current, [created.hostname]: created }));
      setHostname("");
      setNote({ text: `Added ${created.hostname}. Add the TXT record below, then verify.`, tone: "success" });
      await refresh();
    } catch {
      setError("Could not reach the control plane. Try again.");
    } finally { setBusy(false); }
  };

  const verify = async (domain: string) => {
    setNote(null);
    try {
      const response = await fetch(`${base}/${domain}/verify`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        // SAFETY: an error body from the domains endpoint is { error?: string }.
        const failure = await response.json().catch(() => ({})) as { error?: string };
        setNote({ text: failure.error ?? "Verification failed. Check the TXT record and try again.", tone: "error" });
        return;
      }
      // SAFETY: a 2xx from verify is a DomainRecord, with reachability attached.
      const body = await response.json() as DomainRecord;
      setReachability((current) => ({ ...current, [domain]: body }));
      setNote({ text: `${domain} is verified.`, tone: "success" });
      await refresh();
    } catch { setNote({ text: "Could not reach the control plane. Try again.", tone: "error" }); }
  };

  const remove = async (domain: string) => {
    const failure = await mutate(`${base}/${domain}`, { method: "DELETE" });
    setNote({ text: failure ?? `Removed ${domain}.`, tone: failure ? "error" : "success" });
    await refresh();
  };

  return (
    <section className="data-panel settings-panel">
      <PanelHeading
        title="Custom domains"
        description="Point your own hostname at this project. It serves the active version alongside the generated hostname."
      />

      {note && <StatusMessage tone={note.tone}>{note.text}</StatusMessage>}

      {state === "loading" ? (
        <p className="loading-state" aria-live="polite">Loading domains…</p>
      ) : state === "error" ? (
        <p className="form-error" role="alert">Could not load custom domains.</p>
      ) : list.length === 0 ? (
        <p className="empty-state">No custom domains attached.</p>
      ) : (
        <ul className="record-list domain-list">
          {list.map((domain) => {
            const detail = reachability[domain.hostname];
            return (
              <li key={domain.hostname}>
                <div><strong>{domain.hostname}</strong></div>
                <b className={domain.verified ? "status live" : "status"}>{domain.verified ? "Verified" : "Pending"}</b>
                {!domain.verified && <Button variant="quiet" onClick={() => void verify(domain.hostname)}>Verify</Button>}
                <ConfirmButton
                  label="Remove"
                  busyLabel="Removing…"
                  triggerVariant="quiet"
                  title={`Remove ${domain.hostname}?`}
                  description={<>This hostname stops serving this project immediately. You can attach it again later.</>}
                  confirmLabel="Remove domain"
                  onConfirm={() => remove(domain.hostname)}
                />
                {domain.verification && (
                  <p className="record-note">
                    Add DNS <code>{domain.verification.type}</code> <code>{domain.verification.name}</code> ={" "}
                    <code>{domain.verification.value}</code>
                    <Copy value={domain.verification.value} />
                  </p>
                )}
                {detail?.warning && <p className="record-note warning">{detail.warning}</p>}
                {detail?.serverAddresses?.length ? (
                  <p className="record-note">Point an A/AAAA record at <code>{detail.serverAddresses.join(", ")}</code>, DNS-only.</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <form className="form-grid" onSubmit={(event) => void add(event)}>
        <TextField
          label="Add a hostname"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="www.example.com"
          value={hostname}
          disabled={!hasActive}
          onChange={(event) => { setHostname(event.target.value); setError(null); }}
          hint={hasActive ? "A TXT record proves ownership; an A or AAAA record sends traffic here." : "Deploy a version before attaching a domain."}
          error={invalid ? "Enter a full hostname, like www.example.com." : error}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={busy} busyLabel="Adding…" disabled={!hasActive || !hostname.trim() || invalid}>
            Add domain
          </Button>
        </div>
      </form>
    </section>
  );
}
