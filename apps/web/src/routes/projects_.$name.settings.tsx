import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Copy, DeleteProject } from "../components";
import { useProject } from "../dashboard-data";

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

type DomainRecord = {
  hostname: string; verified: boolean;
  verification: { type: string; name: string; value: string } | null;
};

function CustomDomains({ name, hasActive }: { name: string; hasActive: boolean }) {
  const [list, setList] = useState<DomainRecord[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/projects/${encodeURIComponent(name)}/domains`;

  const fetchList = async (): Promise<DomainRecord[] | null> => {
    try {
      const response = await fetch(base, { credentials: "include" });
      if (!response.ok) return null;
      // SAFETY: a 2xx from the domains endpoint is DomainRecord[].
      return await response.json() as DomainRecord[];
    } catch { return null; }
  };

  useEffect(() => {
    let ignore = false;
    setState("loading");
    void fetchList().then((rows) => {
      if (ignore) return;
      if (rows) { setList(rows); setState("ready"); } else { setState("error"); }
    });
    return () => { ignore = true; };
  }, [name]);

  const call = async (url: string, init: RequestInit, onOk: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, { credentials: "include", ...init });
      if (!response.ok) {
        // SAFETY: an error body from this API is { error: string }.
        const body = await response.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? `request failed (${response.status})`);
      } else {
        onOk();
        const rows = await fetchList();
        if (rows) setList(rows);
      }
    } catch {
      setError("network error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="data-panel settings-panel">
      <h2>Custom domains</h2>
      <p>Point your own hostname at this project. It serves whichever version is active, alongside the generated hostname.</p>

      {state === "loading" ? <p className="loading-state" aria-live="polite">Loading domains…</p>
        : state === "error" ? <p className="form-error" role="alert">Could not load custom domains.</p>
        : list.length === 0 ? <p className="empty-state">No custom domains attached.</p>
        : (
          <dl className="detail-grid">
            {list.map((domain) => (
              <div key={domain.hostname}>
                <dt><code>{domain.hostname}</code> — {domain.verified ? "verified" : "pending verification"}</dt>
                <dd>
                  {domain.verification && (
                    <p className="hint">
                      Add DNS <code>{domain.verification.type}</code> <code>{domain.verification.name}</code> ={" "}
                      <code>{domain.verification.value}</code>, then verify.
                    </p>
                  )}
                  {!domain.verified && (
                    <button type="button" disabled={busy} onClick={() => void call(`${base}/${domain.hostname}/verify`, { method: "POST" }, () => {})}>
                      Verify
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void call(`${base}/${domain.hostname}`, { method: "DELETE" }, () => {})}>
                    Remove
                  </button>
                </dd>
              </div>
            ))}
          </dl>
        )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!hostname.trim()) return;
          void call(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hostname: hostname.trim() }) }, () => setHostname(""));
        }}
      >
        <label>
          Add a hostname
          <input type="text" inputMode="url" placeholder="www.example.com" value={hostname} onChange={(event) => setHostname(event.target.value)} disabled={busy || !hasActive} />
        </label>
        <button type="submit" disabled={busy || !hasActive || !hostname.trim()}>Add</button>
        {!hasActive && <p className="hint">Deploy a version first.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </section>
  );
}

function ProjectSettings() {
  const { name, active } = useProject();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail>();
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!active) { setState("idle"); return; }
    setState("loading");
    let ignore = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(active.activeDeploymentId)}`, { credentials: "include" });
        if (ignore) return;
        if (!response.ok) { setState("error"); return; }
        // SAFETY: a 2xx from the deployment-detail endpoint is the Detail contract.
        const body = await response.json() as Detail;
        if (ignore) return;
        setDetail(body);
        setState("ready");
      } catch {
        if (!ignore) setState("error");
      }
    };
    void load();
    return () => { ignore = true; };
  }, [name, active]);

  const manifest = detail?.manifest;

  return (
    <>
      <section className="data-panel settings-panel">
        <h2>Route</h2>
        <p>Managed per project. The hostname is generated from the project and namespace.</p>
        <dl className="detail-grid">
          <Value label="Generated hostname" value={active ? active.hostname : `${name}.<namespace>.sproutboat.com`} copy={Boolean(active)} />
          <div><dt>State</dt><dd>{active ? "Serving the active version" : "Not serving — deploy a version or roll one back"}</dd></div>
        </dl>
      </section>

      <section className="data-panel settings-panel">
        <h2>Active artifact</h2>
        <p>Immutable. These are baked into the deployed artifact — change your local config and run <code>sproutboat deploy</code> to produce a new version.</p>
        {!active ? (
          <p className="empty-state">No active deployment. Run <code>sproutboat deploy {name}</code> from the project directory to publish one.</p>
        ) : state === "loading" || state === "idle" ? (
          <p className="loading-state" aria-live="polite">Loading artifact details…</p>
        ) : state === "error" ? (
          <p className="form-error" role="alert">Could not load the active artifact. Refresh and try again.</p>
        ) : manifest ? (
          <dl className="detail-grid">
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
            <div><dt>Binary size</dt><dd>{manifest.binarySize} bytes <span className="hint">(16 MiB limit)</span></dd></div>
            <Value label="Built" value={manifest.builtAt} />
          </dl>
        ) : (
          <p className="form-status">Artifact metadata is unavailable{detail?.manifestError ? `: ${detail.manifestError}` : "."}</p>
        )}
        <p className="hint">The <code>http-sync-v0</code> profile has no runtime variables, secrets, storage bindings, or triggers.</p>
      </section>

      <CustomDomains name={name} hasActive={Boolean(active)} />

      <section className="data-panel settings-panel danger-panel">
        <h2>Danger zone</h2>
        <p>Delete this project, every deployed version, and its route. This cannot be undone.</p>
        <DeleteProject name={name} onDeleted={() => void navigate({ to: "/projects" })} />
      </section>
    </>
  );
}
