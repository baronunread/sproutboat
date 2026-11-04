import { useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";
import { CheckIcon, CopyIcon } from "../lib/icons";
import { IconButton } from "./icon-button";

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

export function CopyId({ value, display, label = "Copy ID", onCopied, className, ref, ...props }: CopyIdProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
    onCopied?.(value);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <span ref={ref} className={cn("inline-flex min-w-0 max-w-full items-center gap-1", className)} {...props}>
      <code className="min-w-0 truncate font-mono text-sm text-fg" title={value}>
        {display ?? value}
      </code>
      <IconButton
        label={copied ? "Copied" : label}
        size="sm"
        onClick={copy}
        className="size-6 shrink-0 text-fg-muted hover:text-fg"
      >
        {copied ? <CheckIcon className="text-brand-fg" /> : <CopyIcon />}
      </IconButton>
      <span role="status" className="sr-only">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </span>
  );
}
