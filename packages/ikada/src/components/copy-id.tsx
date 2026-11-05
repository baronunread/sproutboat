import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { CheckIcon, CopyIcon } from "../lib/icons";
import { IconButton } from "./icon-button";
import { InlineConfirm } from "./inline-confirm";

export interface CopyIdProps extends Omit<ComponentProps<"span">, "children"> {
  /** The full value written to the clipboard. */
  value: string;
  /** What is shown; defaults to the value. Use it to shorten hashes. */
  display?: string;
  /** Accessible name of the button, e.g. "Copy deployment ID". */
  label?: string;
  /** Called after a successful copy. */
  onCopied?: (value: string) => void;
}

/** Both icons stay mounted; the idle one scales to 0.25, blurs and fades. Reduced motion keeps the fade. */
const swap = (on: boolean): string =>
  on ? "scale-100 opacity-100 blur-none" : "scale-(--sb-scale-icon) opacity-0 blur-xs motion-reduce:blur-none";

export function CopyId({ value, display, label = "Copy ID", onCopied, className, ref, ...props }: CopyIdProps) {
  async function copy(confirm: () => void) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    confirm();
    onCopied?.(value);
  }

  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md bg-well ps-2.5 pe-1 shadow-field",
        className,
      )}
      {...props}
    >
      <code className="min-w-0 truncate font-mono text-sm font-medium text-fg" title={value}>
        {display ?? value}
      </code>
      <InlineConfirm message="Copied" announce="Copied to clipboard" className="shrink-0">
        {({ confirm, active }) => (
          <IconButton
            label={active ? "Copied" : label}
            size="sm"
            onClick={() => copy(confirm)}
            className="size-6 shrink-0 rounded-xs text-fg-muted hover:text-fg"
          >
            <span className="inline-grid size-4 *:col-start-1 *:row-start-1 *:transition-[opacity,scale,filter] *:duration-300 *:ease-out">
              <CopyIcon className={swap(!active)} />
              <CheckIcon className={cn(swap(active), "text-brand-fg")} />
            </span>
          </IconButton>
        )}
      </InlineConfirm>
    </span>
  );
}
