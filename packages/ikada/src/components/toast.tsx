import { Toast } from "@base-ui/react/toast";
import type { ComponentProps, ReactNode } from "react";
import { cn, focusRing } from "../lib/cn";
import { CloseIcon } from "../lib/icons";
import type { Status } from "./status";
import { StatusGlyph } from "./status-glyph";

/** Call `toast.add({ title, description, type })` from anywhere, inside or outside React. */
export const toast = Toast.createToastManager();

export function useToast() {
  return Toast.useToastManager();
}

const statuses: readonly Status[] = ["success", "warning", "danger", "info", "neutral"];
const statusOf = (type: string | undefined): Status => statuses.find((s) => s === type) ?? "neutral";

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((item) => {
    const status = statusOf(item.type);
    return (
      <Toast.Root
        key={item.id}
        toast={item}
        className={cn(
          "absolute inset-x-0 bottom-0 mx-auto w-full origin-bottom rounded-xl bg-raised p-4 text-fg shadow-dialog",
          // --sb-move is 0 under reduced motion: the toast fades in place instead of sliding.
          "[--gap:0.75rem] [--shrink:calc(1-(var(--toast-index)*0.04*var(--sb-move)))]",
          "transition-[transform,opacity] duration-(--sb-duration-toast-in) ease-out data-ending-style:duration-(--sb-duration-toast-out)",
          "[transform:translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--gap)*-1*var(--sb-move))))_scale(var(--shrink))]",
          "data-starting-style:[transform:translateY(calc((100%+var(--gap))*var(--sb-move)))] data-starting-style:opacity-0",
          "data-ending-style:opacity-0 data-ending-style:[transform:translateY(calc((100%+var(--gap))*var(--sb-move)))]",
          "data-limited:opacity-0",
        )}
      >
        <Toast.Content className="flex items-start gap-3">
          <StatusGlyph status={status} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <Toast.Title className="text-base font-medium" />
            <Toast.Description className="mt-0.5 text-sm text-fg-muted" />
            {item.actionProps ? (
              <Toast.Action
                className={cn(
                  "mt-2 rounded-md bg-hover px-2.5 py-1 text-sm font-semibold shadow-button transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-[color-mix(in_oklch,var(--sb-hover),var(--sb-fg)_9%)]",
                  focusRing,
                )}
              />
            ) : null}
          </div>
          <Toast.Close
            aria-label="Dismiss notification"
            className={cn(
              "-me-1 -mt-1 inline-grid size-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors duration-(--sb-duration-hover) ease-hover hover:bg-hover hover:text-fg pointer-coarse:size-11",
              focusRing,
            )}
          >
            <CloseIcon />
          </Toast.Close>
        </Toast.Content>
      </Toast.Root>
    );
  });
}

export interface ToastProviderProps extends Omit<ComponentProps<typeof Toast.Provider>, "children" | "toastManager"> {
  children?: ReactNode;
}

/** Mount once near the app root. Viewport sits bottom-end and is a labelled landmark region. */
export function ToastProvider({ children, timeout = 5000, limit = 3, ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toast} timeout={timeout} limit={limit} {...props}>
      {children}
      <Toast.Portal>
        <Toast.Viewport
          className={cn(
            "fixed inset-x-4 bottom-4 z-(--sb-z-toast) mx-auto h-0 w-auto max-w-sm sm:start-auto sm:end-4 sm:mx-0 sm:w-80",
          )}
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
