import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn, focusRing, type WithClass } from "../lib/cn";
import { CloseIcon } from "../lib/icons";
import { usePortalContainer } from "../lib/portal";
import { InstantProvider, instantAttr, useInstant, useInstantOpen } from "../lib/instant";

/** Opens with a click or tap animate; a key press opens it with no animation. */
export function Dialog({ onOpenChange, ...props }: ComponentProps<typeof BaseDialog.Root>) {
  const [instant, handle] = useInstantOpen(onOpenChange);
  return (
    <InstantProvider value={instant}>
      <BaseDialog.Root onOpenChange={handle} {...props} />
    </InstantProvider>
  );
}
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export interface DialogContentProps extends Omit<ComponentProps<typeof BaseDialog.Popup>, "className"> {
  className?: string;
  /** Hide the corner close button when the footer already has Cancel. */
  hideClose?: boolean;
}

export function DialogContent({ className, hideClose = false, children, ref, ...props }: DialogContentProps) {
  const instant = useInstant();
  const container = usePortalContainer();
  return (
    <BaseDialog.Portal container={container}>
      <BaseDialog.Backdrop
        {...instantAttr(instant)}
        className={cn(
          "fixed inset-0 z-(--sb-z-overlay) bg-scrim",
          "transition-opacity duration-(--sb-duration-dialog-out) ease-out data-open:duration-(--sb-duration-dialog-in)",
          "data-starting-style:opacity-0 data-ending-style:opacity-0 data-sb-instant:transition-none",
        )}
      />
      <BaseDialog.Viewport className="fixed inset-0 z-(--sb-z-modal) grid place-items-center overflow-y-auto p-4">
        <BaseDialog.Popup
          ref={ref}
          {...instantAttr(instant)}
          className={cn(
            "relative w-full max-w-md rounded-xl bg-raised p-6 text-fg shadow-dialog outline-hidden",
            // Centered: a dialog scales from its middle, never from a trigger.
            "origin-center transition-[opacity,scale] duration-(--sb-duration-dialog-out) ease-out data-open:duration-(--sb-duration-dialog-in)",
            "data-starting-style:scale-(--sb-scale-dialog) data-starting-style:opacity-0",
            "data-ending-style:scale-(--sb-scale-dialog) data-ending-style:opacity-0 data-sb-instant:transition-none",
            className,
          )}
          {...props}
        >
          {children}
          {hideClose ? null : (
            <BaseDialog.Close
              aria-label="Close"
              className={cn(
                "absolute end-3 top-3 inline-grid size-8 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg pointer-coarse:size-11",
                focusRing,
              )}
            >
              <CloseIcon />
            </BaseDialog.Close>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Viewport>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: WithClass<ComponentProps<typeof BaseDialog.Title>>) {
  return <BaseDialog.Title className={cn("pe-8 text-lg font-bold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: WithClass<ComponentProps<typeof BaseDialog.Description>>) {
  return <BaseDialog.Description className={cn("mt-2 text-base text-fg-muted", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
