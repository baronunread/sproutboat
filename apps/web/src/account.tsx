import {
  Button,
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
import { useState } from "react";
import type { FormEvent } from "react";
import { ConfirmDialog } from "./confirm-dialog";
import { mutate, relativeTime, useJson } from "./dashboard-data";
import { Section } from "./page-state";

type Credential = {
  id: string;
  name: string | null;
  prefix: string | null;
  start: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  enabled: boolean;
};

/**
 * #21: list and revoke the CLI credentials Better Auth issued for
 * `sproutboat login`. Revocation is immediate. The browser session is a
 * separate credential and is never listed or revoked here.
 */
export function CliCredentials() {
  const { data, state, refresh } = useJson<{ credentials: Credential[] }>("/api/account/credentials");
  const items = data?.credentials ?? [];

  const revoke = async (id: string, label: string) => {
    const failure = await mutate(`/api/account/credentials/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (failure) return failure;
    toast.add({ tone: "success", title: `Revoked ${label}` });
    await refresh();
    return null;
  };

  const revokeAll = async () => {
    const response = await fetch("/api/account/credentials", { method: "DELETE", credentials: "include" }).catch(
      () => null,
    );
    if (!response?.ok) return "Could not revoke the credentials. Try again.";
    // SAFETY: a 2xx from the revoke-all endpoint is { revoked: number }.
    const body = (await response.json()) as { revoked: number };
    toast.add({ tone: "success", title: `Revoked ${body.revoked} credential${body.revoked === 1 ? "" : "s"}` });
    await refresh();
    return null;
  };

  return (
    <Section
      title="API tokens"
      description={
        <>
          Keys created by <code>sproutboat login</code>. Your browser session is separate and stays signed in.
        </>
      }
      action={
        state === "ready" && items.length > 0 ? (
          <ConfirmDialog
            trigger="Revoke all"
            title="Revoke every API token?"
            description={
              <>
                Every machine using one must run <code>sproutboat login</code> again. Your browser session is
                unaffected.
              </>
            }
            confirmLabel="Revoke all tokens"
            onConfirm={revokeAll}
          />
        ) : undefined
      }
    >
      {state === "ready" && items.length === 0 ? (
        <EmptyState
          title="No API tokens yet"
          description={
            <>
              Run <code>sproutboat login</code> on a machine to create one.
            </>
          }
        />
      ) : (
        <Table label="API tokens" aria-busy={state === "loading" || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead hideBelow="md">Created</TableHead>
              <TableHead hideBelow="lg">Last used</TableHead>
              <TableHead hideBelow="xl">Expires</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state === "loading" ? (
              <TableLoading columns={5} />
            ) : state === "error" ? (
              <TableError colSpan={5} title="Could not load tokens">
                Refresh and try again.
              </TableError>
            ) : (
              items.map((credential) => {
                const label = credential.name || credential.start || credential.id.slice(0, 8);
                return (
                  <TableRow key={credential.id}>
                    <TableCell className="min-w-48">
                      <span className="block break-all font-semibold">{label}</span>
                      <code className="text-sm text-fg-muted">
                        {credential.start ?? credential.prefix ?? "sproutboat_…"}
                      </code>
                    </TableCell>
                    <TableCell hideBelow="md" className="whitespace-nowrap text-fg-muted">
                      {relativeTime(credential.createdAt)}
                    </TableCell>
                    <TableCell hideBelow="lg" className="whitespace-nowrap text-fg-muted">
                      {credential.lastUsedAt ? relativeTime(credential.lastUsedAt) : "Never used"}
                    </TableCell>
                    <TableCell hideBelow="xl" className="whitespace-nowrap text-fg-muted">
                      {credential.expiresAt ? credential.expiresAt.slice(0, 10) : "No expiry"}
                    </TableCell>
                    <TableCell className="text-end">
                      <ConfirmDialog
                        trigger="Revoke"
                        triggerLabel={`Revoke ${label}`}
                        title={`Revoke ${label}?`}
                        description={
                          <>
                            Any machine using this token must run <code>sproutboat login</code> again. This takes effect
                            immediately.
                          </>
                        }
                        confirmLabel="Revoke token"
                        onConfirm={() => revoke(credential.id, label)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

/**
 * #16 account deletion: typed-username confirmation, then DELETE /api/account. The
 * server clears the session cookie in its response, so on success we go straight
 * to /login (the root auth gate keeps us there). The 403 path only reaches a
 * CLI-token caller, but is handled for completeness.
 */
export function DeleteAccount({ username }: { username?: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expected = username ?? "";
  const mismatch = confirm !== "" && confirm !== expected;

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setConfirm("");
      setError("");
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!expected || confirm !== expected) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/account", { method: "DELETE", credentials: "include" });
      if (response.ok) {
        location.assign("/login");
        return;
      }
      setBusy(false);
      setError(
        response.status === 403
          ? "Account deletion is only available from an interactive browser session, not a CLI token."
          : "Could not delete your account. Try again.",
      );
    } catch {
      setBusy(false);
      setError("Could not reach the control plane. Try again.");
    }
  };

  return (
    <Section
      title="Danger zone"
      danger
      description="Deleting your account permanently removes your namespace, every project and deployment, all routed hostnames, and every issued API token. Active routes stop serving immediately and you are signed out."
    >
      <div>
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogTrigger render={<Button variant="danger" disabled={!expected} />}>Delete account</DialogTrigger>
          <DialogContent>
            <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
              <div>
                <DialogTitle>Delete your account?</DialogTitle>
                <DialogDescription>This cannot be undone. Type your username to confirm.</DialogDescription>
              </div>
              <Field
                label={`Type ${expected} to confirm`}
                error={mismatch ? "That does not match your username." : error || undefined}
              >
                <Input
                  value={confirm}
                  placeholder={expected}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => {
                    setConfirm(event.target.value);
                    setError("");
                  }}
                />
              </Field>
              <DialogFooter className="mt-2">
                <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
                <Button type="submit" variant="danger" loading={busy} disabled={confirm !== expected}>
                  Delete my account
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </Section>
  );
}
