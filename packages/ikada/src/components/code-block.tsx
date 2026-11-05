import type { ComponentProps } from "react";
import { cn, focusRingInset } from "../lib/cn";
import { CheckIcon, CopyIcon } from "../lib/icons";
import { IconButton } from "./icon-button";
import { InlineConfirm } from "./inline-confirm";

export interface CodeBlockProps extends Omit<ComponentProps<"div">, "children"> {
  /** The text. It is shown as is and copied as is. */
  code: string;
  /** Names the block for screen readers, e.g. "Deploy command". Required. */
  label: string;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  /** Hides the copy button. */
  copyable?: boolean;
}

/** A monospace block for commands and output, with a copy button. The scroll area is keyboard focusable. */
export function CodeBlock({ code, label, wrap = false, copyable = true, className, ref, ...props }: CodeBlockProps) {
  async function copy(confirm: () => void) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return;
    }
    confirm();
  }
  return (
    <div
      ref={ref}
      className={cn("relative min-w-0 max-w-full rounded-lg bg-code-bg shadow-card", className)}
      {...props}
    >
      <pre
        role="region"
        aria-label={label}
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scroll region must be keyboard-focusable
        tabIndex={0}
        className={cn(
          "m-0 max-w-full overflow-auto rounded-lg py-3 ps-4 pe-12 font-mono text-sm leading-6 text-fg",
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          focusRingInset,
        )}
      >
        <code>{code}</code>
      </pre>
      {copyable ? (
        <InlineConfirm
          message="Copied"
          announce="Copied to clipboard"
          className="absolute end-1.5 top-1.5 rounded-md bg-code-bg"
        >
          {({ confirm, active }) => (
            <IconButton
              label={active ? "Copied" : `Copy ${label.toLowerCase()}`}
              size="sm"
              onClick={() => copy(confirm)}
              className="text-fg-muted hover:text-fg"
            >
              {active ? <CheckIcon className="text-brand-fg" /> : <CopyIcon />}
            </IconButton>
          )}
        </InlineConfirm>
      ) : null}
    </div>
  );
}
