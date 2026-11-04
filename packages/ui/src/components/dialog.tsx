import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ComponentProps } from "react";
import { cn, focusRing, type WithClass } from "../lib/cn";
import { CloseIcon } from "../lib/icons";

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export interface DialogContentProps extends Omit<ComponentProps<typeof BaseDialog.Popup>, "className"> {
  className?: string;
  /** Hide the corner close button when the footer already has Cancel. */
  hideClose?: boolean;
}

export function DialogContent({ className, hideClose = false, children, ref, ...props }: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        className={cn(
          "fixed inset-0 z-(--sb-z-overlay) bg-scrim",
          "transition-opacity duration-(--sb-duration-base) ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0",
        )}
      />
      <BaseDialog.Viewport className="fixed inset-0 z-(--sb-z-modal) grid place-items-center overflow-y-auto p-4">
        <BaseDialog.Popup
          ref={ref}
          className={cn(
            "relative w-full max-w-md rounded-xl bg-surface p-6 text-fg shadow-dialog outline-hidden",
            "transition-[opacity,transform] duration-(--sb-duration-base) ease-standard data-starting-style:scale-[0.97] data-starting-style:opacity-0 data-ending-style:scale-[0.97] data-ending-style:opacity-0",
            className,
          )}
          {...props}
        >
          {children}
          {hideClose ? null : (
            <BaseDialog.Close
              aria-label="Close"
              className={cn(
                "absolute end-3 top-3 inline-grid size-8 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-fast) hover:bg-raised hover:text-fg pointer-coarse:size-11",
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
  return <BaseDialog.Title className={cn("pe-8 text-lg font-semibold", className)} {...props} />;
}

export function DialogDescription({ className, ...props }: WithClass<ComponentProps<typeof BaseDialog.Description>>) {
  return <BaseDialog.Description className={cn("mt-1.5 text-base text-fg-muted", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />;
}
