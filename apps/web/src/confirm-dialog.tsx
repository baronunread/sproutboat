import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "@sproutboat/ikada";
import type { ButtonProps } from "@sproutboat/ikada";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * A destructive action behind a dialog. `onConfirm` returns an error message to show inside the
 * dialog (it stays open), or `null` on success (it closes). The trigger is a small secondary
 * button unless the caller overrides it.
 */
export function ConfirmDialog({
  trigger,
  triggerLabel,
  triggerVariant = "secondary",
  title,
  description,
  confirmLabel,
  onConfirm,
}: {
  trigger: string;
  /** Accessible name of the trigger when the visible text alone is ambiguous in a list. */
  triggerLabel?: string;
  triggerVariant?: ButtonProps["variant"];
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) setError("");
  }

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const failure = await onConfirm();
      if (failure) setError(failure);
      else setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant={triggerVariant} aria-label={triggerLabel} />}>
        {trigger}
      </DialogTrigger>
      <DialogContent>
        <div className="flex flex-col gap-4">
          <div>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger-fg">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button disabled={busy} />}>Cancel</DialogClose>
            <Button variant="danger" loading={busy} onClick={() => void confirm()}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
