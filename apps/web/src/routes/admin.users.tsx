import {
  Badge,
  Banner,
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
  Pagination,
  SensitiveInput,
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableError,
  TableHead,
  TableHeader,
  TableLoading,
  TableRow,
  toast,
} from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ConfirmDialog } from "../confirm-dialog";
import { USERNAME_RULE, mutate, relativeTime } from "../dashboard-data";

export const Route = createFileRoute("/admin/users")({ component: AdminUsers });

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role: string;
  banned: boolean;
  createdAt: string;
  projects: number;
  deployments: number;
  activeProjects: number;
};
type UsersPage = { users: UserRow[]; total: number; limit: number; offset: number };

const PAGE = 50;

function AdminUsers() {
  const [page, setPage] = useState<UsersPage>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setState("loading");
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (query.trim()) params.set("q", query.trim());
    try {
      const response = await fetch(`/api/admin/users?${params.toString()}`, { credentials: "include" });
      if (!response.ok) {
        setState("error");
        return;
      }
      // SAFETY: a 2xx from /api/admin/users is the UsersPage contract.
      setPage((await response.json()) as UsersPage);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [offset, query]);
  useEffect(() => {
    void load();
  }, [load]);

  /** `disable` and `enable` keep calling the ban and unban endpoints; the reason and expiry fields are gone from the UI. */
  const act = async (user: UserRow, path: "ban" | "unban") => {
    setNote("");
    const failure = await mutate(`/api/admin/users/${encodeURIComponent(user.id)}/${path}`, { method: "POST" });
    if (failure) {
      setNote("That action failed. Refresh and try again.");
      return failure;
    }
    toast.add({
      tone: "success",
      title: path === "ban" ? `Disabled ${user.email}` : `Enabled ${user.email}`,
      description: path === "ban" ? "Their routes stopped serving." : "Their routes serve again.",
    });
    await load();
    return null;
  };

  const pageCount = page ? Math.max(1, Math.ceil(page.total / PAGE)) : 1;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="w-full max-w-md">
          <Field label="Search users" className="[&>label]:sr-only">
            <Input
              type="search"
              placeholder="Search by email"
              value={query}
              onChange={(event) => {
                setOffset(0);
                setQuery(event.target.value);
              }}
            />
          </Field>
        </div>
        <CreateUserDialog onCreated={() => void load()} />
      </div>
      <p className="text-base text-fg-muted">
        Accounts are created here: there is no self-service sign-up. Disabling an account stops its routes immediately.
      </p>
      {note ? <Banner tone="danger">{note}</Banner> : null}

      {state === "ready" && page && page.users.length === 0 && !query.trim() ? (
        <div className="rounded-xl bg-surface p-4 shadow-card">
          <EmptyState title="No accounts yet" description="Create the first one with the button above." />
        </div>
      ) : (
        <Table label="User accounts" aria-busy={state === "loading" || undefined}>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead hideBelow="lg">Role</TableHead>
              <TableHead hideBelow="md" className="text-end">
                Projects
              </TableHead>
              <TableHead hideBelow="xl">Joined</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state === "loading" && !page ? (
              <TableLoading columns={6} />
            ) : state === "error" ? (
              <TableError colSpan={6} title="Could not load users">
                Refresh and try again.
              </TableError>
            ) : page && page.users.length === 0 ? (
              <TableEmpty colSpan={6}>
                <span className="text-fg-muted">No accounts match “{query.trim()}”.</span>
              </TableEmpty>
            ) : (
              page?.users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="min-w-48">
                    <span className="block break-all font-semibold">{user.email}</span>
                    {user.name ? <span className="block text-sm text-fg-muted">{user.name}</span> : null}
                  </TableCell>
                  <TableCell hideBelow="lg" className="text-fg-muted">
                    {user.role}
                  </TableCell>
                  <TableCell hideBelow="md" className="text-end tabular-nums">
                    {user.projects}
                  </TableCell>
                  <TableCell hideBelow="xl" className="whitespace-nowrap text-fg-muted">
                    {relativeTime(user.createdAt)}
                  </TableCell>
                  <TableCell>
                    {user.banned ? (
                      <Badge tone="warning" dot>
                        Disabled
                      </Badge>
                    ) : (
                      <Badge tone="success" dot>
                        Active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-end">
                    {user.banned ? (
                      <Button size="sm" aria-label={`Enable ${user.email}`} onClick={() => void act(user, "unban")}>
                        Enable
                      </Button>
                    ) : (
                      <ConfirmDialog
                        trigger="Disable"
                        triggerLabel={`Disable ${user.email}`}
                        title={`Disable ${user.email}?`}
                        description="Their routes stop serving immediately. You can enable the account again at any time."
                        confirmLabel="Disable account"
                        onConfirm={() => act(user, "ban")}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )}
      {pageCount > 1 ? (
        <div className="flex justify-center">
          <Pagination
            page={Math.floor(offset / PAGE) + 1}
            pageCount={pageCount}
            onPageChange={(next) => setOffset((next - 1) * PAGE)}
          />
        </div>
      ) : null}
    </div>
  );
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 20);
}

function CreateUserDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ email: string; username: string; password: string } | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setEmail("");
      setUsername("");
      setPassword("");
      setError("");
      setDone(null);
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), username: username.trim(), password }),
      });
      if (!response.ok) {
        // SAFETY: an error body from this endpoint is { error: string }.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "Could not create the user.");
        return;
      }
      setDone({ email: email.trim(), username: username.trim(), password });
      onCreated();
    } catch {
      setError("Could not reach the control plane.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="primary" />}>Create user</DialogTrigger>
      <DialogContent>
        {done ? (
          <div className="flex flex-col gap-4">
            <div>
              <DialogTitle>Created {done.username}</DialogTitle>
              <DialogDescription>
                {done.email} can sign in now. Copy the starting password: it is not shown again.
              </DialogDescription>
            </div>
            <Field label="Starting password">
              <SensitiveInput readOnly copyable defaultRevealed value={done.password} mono />
            </Field>
            <DialogFooter>
              <DialogClose render={<Button variant="primary" />}>Done</DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
            <div>
              <DialogTitle>Create user</DialogTitle>
              <DialogDescription>The account signs in with this email, or by linking GitHub to it.</DialogDescription>
            </div>
            <Field label="Email" required>
              <Input
                type="email"
                autoComplete="off"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <Field
              label="Namespace"
              required
              description="3-32 lowercase letters, digits and hyphens. It appears in every route they deploy."
              error={
                username !== "" && !USERNAME_RULE.test(username)
                  ? "Use 3-32 lowercase letters, digits or hyphens."
                  : undefined
              }
            >
              <Input
                mono
                autoComplete="off"
                spellCheck={false}
                required
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value.toLowerCase());
                  setError("");
                }}
              />
            </Field>
            <Field
              label="Starting password"
              required
              description="At least 10 characters. Shown once, so hand it over before you close this dialog."
              error={password !== "" && password.length < 10 ? "Use at least 10 characters." : error || undefined}
            >
              <Input
                mono
                autoComplete="off"
                spellCheck={false}
                required
                minLength={10}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setError("");
                }}
              />
            </Field>
            <div>
              <Button size="sm" onClick={() => setPassword(randomPassword())}>
                Generate a password
              </Button>
            </div>
            <DialogFooter className="mt-2">
              <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={!email || !USERNAME_RULE.test(username) || password.length < 10}
              >
                Create account
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
