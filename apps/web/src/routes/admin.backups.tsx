import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Link,
  Table,
  TableBody,
  TableCell,
  TableError,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  formatBytes,
  toast,
} from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ConfirmDialog } from "../confirm-dialog";

import { mutate, relativeTime, useJson } from "../dashboard-data";
import { Section } from "../page-state";

export const Route = createFileRoute("/admin/backups")({ component: AdminBackups });

type Backup = { name: string; sizeBytes: number; createdAt: string; offsite: boolean };

function AdminBackups() {
  const { data, state, refresh } = useJson<{ backups: Backup[] }>("/api/admin/backups");
  const [busy, setBusy] = useState(false);
  const backups = data?.backups ?? [];

  const backUpNow = async () => {
    setBusy(true);
    try {
      const failure = await mutate("/api/admin/backups", { method: "POST" });
      if (failure) {
        toast.add({ tone: "danger", title: "Backup failed", description: failure });
        return;
      }
      toast.add({ tone: "success", title: "Backup created" });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    const failure = await mutate(`/api/admin/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (failure) return failure;
    toast.add({ tone: "success", title: `Deleted ${name}` });
    await refresh();
    return null;
  };

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Backups"
        description="The control database, binding data (KV, D1, R2, queues, Durable Objects), artifacts, route snapshot and host config, one encrypted archive each. A timer takes one daily; the last seven are kept."
        action={
          <Button variant="primary" loading={busy} onClick={() => void backUpNow()}>
            Back up now
          </Button>
        }
      >
        {state === "ready" && backups.length === 0 ? (
          <div className="rounded-xl bg-surface p-4 shadow-card">
            <EmptyState title="No backups yet" description="Take one now, or wait for the daily timer." />
          </div>
        ) : (
          <Table label="Stored backup archives" aria-busy={state === "loading" || undefined}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Archive</TableHead>
                <TableHead hideBelow="sm" className="text-end">
                  Size
                </TableHead>
                <TableHead hideBelow="md">Taken</TableHead>
                <TableHead hideBelow="lg">Off-box</TableHead>
                <TableHead className="text-end">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state === "loading" ? (
                <TableLoading columns={5} />
              ) : state === "error" ? (
                <TableError colSpan={5} title="Could not load backups">
                  Refresh and try again.
                </TableError>
              ) : (
                backups.map((backup) => <BackupRow key={backup.name} backup={backup} onDelete={remove} />)
              )}
            </TableBody>
          </Table>
        )}
      </Section>

      <Banner tone="info">
        Off-box upload runs when <code>SPROUTBOAT_BACKUP_S3_*</code> is set in <code>/etc/sproutboat/control.env</code>{" "}
        (any S3-compatible store). To restore, run <code>sudo sbctl restore &lt;archive&gt; --force</code> on the box:
        it stops the services, restores the archive and starts them again. See <code>infra/README.md</code>.
      </Banner>
    </div>
  );
}

function BackupRow({ backup, onDelete }: { backup: Backup; onDelete: (name: string) => Promise<string | null> }) {
  return (
    <TableRow>
      <TableCell className="min-w-48">
        <code className="break-all">{backup.name}</code>
      </TableCell>
      <TableCell hideBelow="sm" className="whitespace-nowrap text-end tabular-nums">
        {formatBytes(backup.sizeBytes)}
      </TableCell>
      <TableCell hideBelow="md" className="whitespace-nowrap text-fg-muted">
        {relativeTime(backup.createdAt)}
      </TableCell>
      <TableCell hideBelow="lg">
        {backup.offsite ? <Badge tone="success">Uploaded</Badge> : <span className="text-fg-muted">-</span>}
      </TableCell>
      <TableCell className="whitespace-nowrap text-end">
        <span className="inline-flex items-center gap-2">
          <Link
            href={`/api/admin/backups/${encodeURIComponent(backup.name)}`}
            download
            aria-label={`Download ${backup.name}`}
          >
            Download
          </Link>
          <ConfirmDialog
            trigger="Delete"
            triggerLabel={`Delete ${backup.name}`}
            title={`Delete ${backup.name}?`}
            description={`This removes the archive from this box${backup.offsite ? " and from off-box storage" : ""}. Restoring from it will no longer be possible. This cannot be undone.`}
            confirmLabel="Delete backup"
            onConfirm={() => onDelete(backup.name)}
          />
        </span>
      </TableCell>
    </TableRow>
  );
}
