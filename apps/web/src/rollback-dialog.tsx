import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from "@sproutboat/ikada";
import { useState } from "react";
import { mutate } from "./dashboard-data";

export type RollbackTarget = { id: string; hostname: string };

/**
 * Confirm before a version starts serving. The click on "Roll back" posts to the activate
 * endpoint, reports the outcome in a toast and calls `onDone` so the caller can refresh.
 * `target` is the version being confirmed; `null` keeps the dialog closed.
 */
export function RollbackDialog({
  name,
  target,
  onClose,
  onDone,
}: {
  name: string;
  target: RollbackTarget | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keep the last target while the dialog animates out, so the copy does not blank mid-fade.
  const [shown, setShown] = useState<RollbackTarget | null>(target);
  if (target && target !== shown) setShown(target);
  const short = shown?.id.slice(0, 8) ?? "";

  const close = () => {
    setError("");
    onClose();
  };

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    setError("");
    let failure: string | null;
    try {
      failure = await mutate(
        `/api/projects/${encodeURIComponent(name)}/deployments/${encodeURIComponent(target.id)}/activate`,
        { method: "POST" },
      );
    } finally {
      setBusy(false);
    }
    if (failure) {
      setError(failure);
      return;
    }
    toast.add({
      tone: "success",
      title: `Rolled back to ${short}`,
      description: `${target.hostname} now serves this version.`,
    });
    onClose();
    await onDone();
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <div className="flex flex-col gap-4">
          <div>
            <DialogTitle>Roll back to {short}?</DialogTitle>
            <DialogDescription>
              This version starts serving <code className="font-mono text-sm text-fg">{shown?.hostname}</code>{" "}
              immediately, and the current active version becomes inactive.
            </DialogDescription>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger-fg">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-0">
            <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
            <Button variant="primary" loading={busy} onClick={() => void confirm()}>
              Roll back
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
