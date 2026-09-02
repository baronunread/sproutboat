import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button, ConfirmButton, PanelHeading, StatusMessage } from "../components";
import { mutate, relativeTime } from "../dashboard-data";

export const Route = createFileRoute("/admin/backups")({ component: AdminBackups });

type Backup = { name: string; sizeBytes: number; createdAt: string; offsite: boolean };

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function AdminBackups() {
  const [backups, setBackups] = useState<Backup[]>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/backups", { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: a 2xx from /api/admin/backups is the { backups } contract.
      const body = await response.json() as { backups: Backup[] };
      setBackups(body.backups);
      setState("ready");
    } catch { setState("error"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const backUpNow = async () => {
    setBusy(true);
    setNote("");
    try {
      const response = await fetch("/api/admin/backups", { method: "POST", credentials: "include" });
      if (!response.ok) {
        // SAFETY: an error body from this endpoint is { error: string }.
        const body = await response.json().catch(() => ({})) as { error?: string };
        setNote(body.error ?? "Backup failed.");
      } else {
        await load();
      }
    } catch { setNote("Could not reach the control plane."); }
    setBusy(false);
  };

  const remove = async (name: string) => {
    setNote("");
    const failure = await mutate(`/api/admin/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (failure) { setNote(failure); return; }
    await load();
  };

  return (
    <section className="data-panel settings-panel">
      <PanelHeading
        title="Backups"
        description="The SQLite metadata store plus the artifact directory and route snapshot, one gzipped archive each. A timer takes one daily; the last seven are kept."
        action={<Button busy={busy} busyLabel="Backing up…" onClick={() => void backUpNow()}>Back up now</Button>}
      />

      {note && <StatusMessage tone="error">{note}</StatusMessage>}

      {state === "loading" && <p className="loading-state" aria-live="polite">Loading backups…</p>}
      {state === "error" && <p className="form-error" role="alert">Could not load backups. Refresh and try again.</p>}
      {state === "ready" && backups && backups.length === 0 && (
        <p className="empty-state">No backups yet. Take one now, or wait for the daily timer.</p>
      )}
      {state === "ready" && backups && backups.length > 0 && (
        <div className="log-scroll">
        <table className="log-table">
          <caption className="visually-hidden">Stored backup archives</caption>
          <thead>
            <tr><th scope="col">Archive</th><th scope="col">Size</th><th scope="col">Taken</th><th scope="col">Off-box</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr>
          </thead>
          <tbody>
            {backups.map((backup) => (
              <tr key={backup.name}>
                <td><code>{backup.name}</code></td>
                <td>{humanSize(backup.sizeBytes)}</td>
                <td>{relativeTime(backup.createdAt)}</td>
                <td>{backup.offsite ? "Uploaded" : "—"}</td>
                <td className="row-actions">
                  <a className="button quiet" href={`/api/admin/backups/${encodeURIComponent(backup.name)}`} download>Download</a>
                  <ConfirmButton
                    label="Delete"
                    busyLabel="Deleting…"
                    triggerVariant="quiet"
                    title={`Delete ${backup.name}?`}
                    description={<>This removes the archive from this box{backup.offsite ? " and from off-box storage" : ""}. Restoring from it will no longer be possible. This cannot be undone.</>}
                    confirmLabel="Delete backup"
                    onConfirm={() => remove(backup.name)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <p className="hint">Off-box upload runs when <code>SPROUTBOAT_BACKUP_S3_*</code> is set in <code>/etc/sproutboat/control.env</code> (any S3-compatible store). Restore on the box: stop the services, replace <code>/var/lib/sproutboat/sproutboat.sqlite</code> and <code>artifacts/</code> from the archive, then start again. See <code>infra/README.md</code>.</p>
    </section>
  );
}
