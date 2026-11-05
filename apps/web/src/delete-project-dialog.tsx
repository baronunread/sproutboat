import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
} from "@sproutboat/ikada";
import { useState } from "react";
import type { FormEvent } from "react";

/**
 * Project deletion: the API needs `?confirm=<exact name>`, so the destructive button stays
 * disabled until the field matches. `onDeleted` is the caller's refresh; the row unmounts
 * this component on success.
 */
export function DeleteProjectDialog({ name, onDeleted }: { name: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const mismatch = confirm !== "" && confirm !== name;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setConfirm("");
      setError("");
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirm !== name) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        setError(
          response.status === 404
            ? "This project no longer exists. It may already be deleted."
            : "Could not delete this project. Try again.",
        );
        return;
      }
      setOpen(false);
      onDeleted();
    } catch {
      setError("Could not reach the control plane. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" aria-label={`Delete ${name}`} />}>Delete</DialogTrigger>
      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <div>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              This deletes the project, every deployed version and its route. It cannot be undone.
            </DialogDescription>
          </div>
          <Field
            label={`Type ${name} to confirm`}
            error={mismatch ? "That does not match the project name." : error || undefined}
          >
            <Input
              value={confirm}
              placeholder={name}
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
            <Button type="submit" variant="danger" loading={busy} disabled={confirm !== name}>
              Delete permanently
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
