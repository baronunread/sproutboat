import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from "../lib/icons";
import { IconButton } from "./icon-button";
import { InlineConfirm } from "./inline-confirm";
import { Input } from "./input";
import type { InputProps } from "./input";

export interface SensitiveInputProps extends Omit<InputProps, "type"> {
  /** Shows a copy button. It copies the real value even while it is masked. */
  copyable?: boolean;
  /** Starts revealed. */
  defaultRevealed?: boolean;
  /** Accessible names of the two buttons. */
  revealLabel?: string;
  hideLabel?: string;
  copyLabel?: string;
  /** Extra buttons or text after the built-in ones. */
  trailing?: ReactNode;
}

/**
 * A password or token field: masked by default, with a button that reveals it and an
 * optional one that copies it. Works inside a Field (id, label and errors are wired by Base UI);
 * `autoComplete` stays under the caller's control, so a sign-in form can keep `current-password`.
 */
export function SensitiveInput({
  copyable = false,
  defaultRevealed = false,
  revealLabel = "Show value",
  hideLabel = "Hide value",
  copyLabel = "Copy value",
  trailing,
  className,
  ...props
}: SensitiveInputProps) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const box = useRef<HTMLDivElement>(null);

  async function copy(confirm: () => void) {
    try {
      await navigator.clipboard.writeText(box.current?.querySelector("input")?.value ?? "");
    } catch {
      return;
    }
    confirm();
  }

  return (
    <div ref={box} className="relative flex w-full min-w-0 items-center">
      <Input
        {...props}
        type={revealed ? "text" : "password"}
        className={cn(copyable ? "pe-[4.5rem]" : "pe-10", className)}
      />
      <span className="absolute inset-y-0 end-1 flex items-center gap-0.5">
        <IconButton
          label={revealed ? hideLabel : revealLabel}
          size="sm"
          aria-pressed={revealed}
          onClick={() => setRevealed((open) => !open)}
          className="rounded-xs text-fg-muted hover:text-fg"
        >
          {revealed ? <EyeOffIcon /> : <EyeIcon />}
        </IconButton>
        {copyable ? (
          <InlineConfirm message="Copied" announce="Copied to clipboard" className="shrink-0">
            {({ confirm, active }) => (
              <IconButton
                label={active ? "Copied" : copyLabel}
                size="sm"
                onClick={() => copy(confirm)}
                className="rounded-xs text-fg-muted hover:text-fg"
              >
                {active ? <CheckIcon className="text-brand-fg" /> : <CopyIcon />}
              </IconButton>
            )}
          </InlineConfirm>
        ) : null}
        {trailing}
      </span>
    </div>
  );
}
