import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import type * as React from "react";
import { Button as UiButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableHeader } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------------------
 * Form primitives (#76)
 *
 * Every text field and select in the dashboard goes through these, so a control
 * cannot ship without a real <label>, its hint and error wired up via
 * aria-describedby, aria-invalid on failure, and one shared visual language.
 * Passing `hideLabel` keeps the label in the accessibility tree and hides it
 * visually - a placeholder is never a label.
 *
 * The insides are shadcn/Radix; this wrapper is the part shadcn does not give
 * you. Its <Input> is a bare styled input: the label/hint/error association is
 * what makes a field accessible, and it belongs in one place rather than at
 * every call site.
 * ------------------------------------------------------------------------- */

type FieldProps = {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  hideLabel?: boolean;
  /** Rendered under the control, e.g. a character counter. */
  footer?: ReactNode;
  /** Extra class on the field wrapper, for layout (e.g. "grow" in a filter bar). */
  fieldClassName?: string;
};

/** Ids for the control and the elements describing it. */
function useFieldIds(id?: string) {
  const generated = useId();
  const fieldId = id ?? `field-${generated}`;
  return { fieldId, hintId: `${fieldId}-hint`, errorId: `${fieldId}-error` };
}

function describedBy(hint: ReactNode, error: string | null | undefined, hintId: string, errorId: string) {
  return [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
}

function FieldShell({
  label,
  hint,
  error,
  hideLabel,
  footer,
  fieldClassName,
  fieldId,
  hintId,
  errorId,
  children,
}: FieldProps & { fieldId: string; hintId: string; errorId: string; children: ReactNode }) {
  return (
    // content-start matters in multi-column forms: a grid item is stretched to
    // the tallest column, and without it the leftover height is shared out
    // between label, control and hint, so neighbouring fields stop lining up.
    <div className={cn("grid min-w-0 content-start gap-1.5", fieldClassName)}>
      <Label className={cn("text-[0.78rem] font-medium", hideLabel && "sr-only")} htmlFor={fieldId}>
        {label}
      </Label>
      {children}
      {hint && (
        <p className="max-w-[42rem] text-xs leading-normal text-muted-foreground" id={hintId}>
          {hint}
        </p>
      )}
      {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
      {error && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-destructive" id={errorId} role="alert">
          <span
            aria-hidden="true"
            className="grid size-3.5 shrink-0 place-items-center rounded-full border border-current text-[0.6rem] font-bold"
          >
            !
          </span>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  hideLabel,
  footer,
  fieldClassName,
  id,
  className,
  ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { fieldId, hintId, errorId } = useFieldIds(id);
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      footer={footer}
      fieldClassName={fieldClassName}
      fieldId={fieldId}
      hintId={hintId}
      errorId={errorId}
    >
      <Input
        {...input}
        id={fieldId}
        className={cn("bg-background", className)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

/**
 * The select. Radix under the hood (via shadcn), so the option list is styled
 * with the rest of the app instead of falling back to OS chrome, and it gets
 * typeahead, keyboard navigation and a portal for free.
 *
 * `onValueChange` rather than a change event: Radix hands you the value, and
 * there is no underlying <select> to read `event.target.value` from.
 */
export function SelectField({
  label,
  hint,
  error,
  hideLabel,
  footer,
  fieldClassName,
  id,
  options,
  value,
  onValueChange,
  disabled,
  placeholder,
}: FieldProps & {
  id?: string;
  options: ReadonlyArray<readonly [string, string]>;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const { fieldId, hintId, errorId } = useFieldIds(id);
  return (
    <FieldShell
      label={label}
      hint={hint}
      error={error}
      hideLabel={hideLabel}
      footer={footer}
      fieldClassName={fieldClassName}
      fieldId={fieldId}
      hintId={hintId}
      errorId={errorId}
    >
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={fieldId}
          className="w-full bg-background text-sm"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, hintId, errorId)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

/* ---------------------------------------------------------------------------
 * Form and filter-bar layout
 *
 * These were spelled out at every call site, which is how the dashboard ended
 * up with three different form measures and four different filter-bar gaps.
 * One measure for a stack of fields, one gap between fields, and a visibly
 * larger gap before the action row so the primary action reads as the end of
 * the form rather than as one more field.
 * ------------------------------------------------------------------------- */

/** A single-column stack of fields. Action rows span it whatever the columns. */
export const FORM = "mt-6 grid max-w-[36rem] gap-5 [&>[data-slot=form-actions]]:col-span-full";
/** The row a form ends on. Wants `data-slot="form-actions"` on the same element. */
export const FORM_ACTIONS = "mt-3 flex flex-wrap items-center gap-2.5";

/**
 * A row of filters over a list. Fixed-width selects so the row is not ragged,
 * the search field taking whatever slack is left, and a taller row gap so a
 * wrapped control reads as a new line rather than as part of the one above.
 */
export const FILTER_BAR = "mt-5 mb-4 flex flex-wrap items-end gap-x-2.5 gap-y-4";
export const FILTER_FIELD = "w-[9.75rem] max-w-full";
export const FILTER_SEARCH = "min-w-0 flex-[1_1_18rem]";

/**
 * A button that owns its own pending state: `busy` disables it, marks it
 * aria-busy, and swaps the label so a screen reader hears the change too.
 *
 * `type` defaults to "button", not the HTML default of "submit": most of these
 * sit inside a <form> as Cancel/Generate/inline actions, where submitting is
 * never what the click meant. Submitters pass type="submit" explicitly.
 *
 * The variant names stay sproutboat's ("quiet" rather than "outline") because
 * every call site already reads in them; they map onto shadcn's underneath.
 */
const BUTTON_VARIANT = { primary: "default", quiet: "outline", danger: "danger" } as const;

export function Button({
  variant = "quiet",
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  type = "button",
  ...button
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "danger";
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <UiButton
      {...button}
      type={type}
      variant={BUTTON_VARIANT[variant]}
      className={cn("text-[0.82rem]", className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? (busyLabel ?? "Working…") : children}
    </UiButton>
  );
}

/**
 * One place for "what just happened" text. `tone="error"` announces
 * assertively (role=alert); everything else is polite (role=status).
 */
const STATUS_TONE = {
  info: "bg-muted text-muted-foreground",
  success: "border-success/25 bg-success/12 text-success",
  error: "border-destructive/25 bg-destructive/12 text-destructive",
} as const;

export function StatusMessage({
  tone = "info",
  children,
}: {
  tone?: "info" | "success" | "error";
  children: ReactNode;
}) {
  if (!children) return null;
  return (
    <Alert
      className={cn("mt-4 border-transparent px-3 py-2.5", STATUS_TONE[tone])}
      role={tone === "error" ? "alert" : "status"}
    >
      <AlertDescription className="text-[0.8rem] leading-normal text-current">{children}</AlertDescription>
    </Alert>
  );
}

/* ---------------------------------------------------------------------------
 * Data surfaces
 *
 * Two shapes carry nearly every screen: a flex row list (name on the left
 * taking the slack, meta hugging the right, notes wrapping to their own line)
 * and a dense scrollable table with a sticky head.
 * ------------------------------------------------------------------------- */

/** A row list inside a bare panel: rows divide and hover edge to edge. */
export function RecordList({ className, ...list }: React.ComponentProps<"ul">) {
  return <ul className={cn("m-0 list-none p-0", className)} {...list} />;
}

/**
 * One row. `> :first-child` takes the slack and everything after it hugs the
 * trailing edge, so a name/host block and a set of meta cells line up down the
 * list however wide they are.
 */
export function RecordRow({ className, ...row }: React.ComponentProps<"li">) {
  return (
    <li
      className={cn(
        "flex min-h-[4.2rem] flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-5 py-3.5 last:border-b-0 hover:bg-accent",
        "[&>*]:flex-none [&>:first-child]:min-w-0 [&>:first-child]:flex-[1_1_14rem]",
        "[&>span]:min-w-24 [&>span]:text-end",
        "[&_strong]:block [&_strong]:text-[0.84rem] [&_strong]:font-medium",
        "[&_small]:block [&_small]:truncate [&_small]:text-[0.72rem] [&_small]:text-muted-foreground",
        "[&_code]:truncate [&_code]:text-[0.72rem] [&_code]:tabular-nums",
        "[&_span]:text-[0.72rem] [&_span]:text-muted-foreground [&_span]:tabular-nums",
        className,
      )}
      {...row}
    />
  );
}

/** A row's explanatory detail (DNS instructions, warnings): its own line, last. */
export const RECORD_NOTE =
  "order-9 basis-full text-[0.72rem] leading-relaxed text-muted-foreground [&_code]:[overflow-wrap:anywhere]";

/** The link/button that names a row. */
export const RECORD_TITLE =
  "cursor-pointer border-0 bg-transparent p-0 text-start text-[0.84rem] font-medium underline-offset-2 hover:underline";

/**
 * A dense table in a bounded scroll box with a sticky head. The caption names
 * it for assistive tech and for `getByRole("table", { name })` in the e2e
 * suite, so it stays even though it is visually hidden.
 */
export function DataTable({
  caption,
  head,
  children,
  className,
}: {
  caption: string;
  head: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Table
      containerClassName={cn("mt-3 max-h-[34rem] overflow-auto rounded-md border border-border", className)}
      className="min-w-[30rem] text-[0.78rem]"
    >
      <caption className="sr-only">{caption}</caption>
      <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-1 [&_th]:bg-card [&_th]:px-3.5 [&_th]:py-2.5 [&_th]:text-start [&_th]:text-[0.68rem] [&_th]:font-semibold [&_th]:tracking-wider [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_th]:uppercase [&_tr]:border-b [&_tr]:border-border">
        {head}
      </TableHeader>
      <TableBody className="[&_td]:border-t [&_td]:border-border [&_td]:px-3.5 [&_td]:py-2.5 [&_td]:align-middle [&_td]:whitespace-nowrap [&_td:last-child]:whitespace-normal [&_tr:first-child_td]:border-t-0 [&_tr:hover]:bg-accent [&_td:first-child]:text-foreground">
        {children}
      </TableBody>
    </Table>
  );
}

/** The trailing sr-only header cell over a row-actions column, shared by every `DataTable` that ends one. */
export function ActionsTh() {
  return (
    <th scope="col" className="text-end">
      <span className="sr-only">Actions</span>
    </th>
  );
}

/** Status pip + label. `live` is the good state. */
export function Status({ live, children }: { live?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-22 items-center gap-1.5 text-[0.72rem] font-semibold",
        "before:size-1.5 before:rounded-full before:content-['']",
        live ? "text-success before:bg-success" : "text-muted-foreground before:bg-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------
 * Panels
 *
 * One component instead of the eight `data-panel …` class combinations the
 * routes used to spell out by hand. `padded` is the distinction that actually
 * mattered and that the old CSS kept getting wrong: a bare panel has no inset
 * so its rows can divide and hover edge to edge, and its children own the
 * 1.25rem; a padded panel already insets, so its children must not inset again.
 * ------------------------------------------------------------------------- */
const PANEL_BASE =
  "group/panel overflow-hidden rounded-xl border border-border bg-card shadow-[0_18px_50px_-42px_color-mix(in_srgb,var(--color-brand)_35%,transparent)] [&+&]:mt-6";

export function Panel({
  variant = "form",
  className,
  children,
  ...section
}: React.ComponentProps<"section"> & {
  /** form: a reading measure for fields and prose. wide: full column, for
   *  tables and charts. bare: no padding, for panels that are just rows. */
  variant?: "form" | "wide" | "bare";
}) {
  return (
    <section
      className={cn(
        PANEL_BASE,
        variant === "form" && "max-w-[46rem] p-6",
        variant !== "bare" && "is-padded",
        variant === "wide" && "max-w-none p-6",
        className,
      )}
      {...section}
    >
      {children}
    </section>
  );
}

/**
 * Section heading + optional action, shared by every panel.
 *
 * The inset comes from the panel, not from here: a bare panel's heading owns
 * the 1.25rem, a padded one's must not add to the padding the panel already
 * has. Reading that off the parent is what the old CSS got wrong - it inset
 * twice in .settings-panel, so the title sat 1.25rem right of its own rule.
 */
export function PanelHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-[1.1rem] group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:pt-0 group-[.is-padded]/panel:pb-5">
      <div>
        <h2 className="m-0 text-[0.95rem] font-semibold tracking-[-0.015em] group-[.is-padded]/panel:text-base">
          {title}
        </h2>
        {description && (
          <p className="mt-1.5 max-w-[38rem] text-[0.875rem] leading-normal text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * The "nothing here yet" body. A centred hero when it fills a bare panel; a
 * plain line of text when it sits between a heading and a form in a padded one.
 */
export function EmptyState({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-5 py-12 text-center group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start",
        className,
      )}
    >
      {title && <h2 className="m-0 text-[1.1rem] font-semibold">{title}</h2>}
      <div className="mx-auto mt-2.5 max-w-[36rem] text-[0.84rem] leading-relaxed text-muted-foreground group-[.is-padded]/panel:mx-0 [&_code]:text-foreground">
        {children}
      </div>
    </div>
  );
}

/**
 * Destructive confirmation, on Radix's AlertDialog: focus is trapped, Escape
 * closes, the trigger regains focus on close, and the dialog is portalled so a
 * row's overflow cannot clip it - the last of which the previous native
 * <dialog> in a table cell did not guarantee.
 */
export function ConfirmButton({
  label,
  busyLabel,
  title,
  description,
  confirmLabel,
  onConfirm,
  disabled,
  variant = "danger",
  triggerVariant,
  className,
}: {
  label: string;
  busyLabel?: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void> | void;
  disabled?: boolean;
  /** Weight of the confirming action inside the dialog. */
  variant?: "primary" | "quiet" | "danger";
  /** Weight of the trigger. Defaults to `variant`; pass "quiet" in list rows so
   *  a table of destructive actions doesn't read as a wall of red. */
  triggerVariant?: "primary" | "quiet" | "danger";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant={triggerVariant ?? variant}
          className={className}
          disabled={disabled}
          busy={busy}
          busyLabel={busyLabel}
        >
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="text-sm leading-relaxed text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="quiet">Cancel</Button>
          </AlertDialogCancel>
          <AlertDialogAction
            asChild
            onClick={(event) => {
              event.preventDefault();
              void run();
            }}
          >
            <Button variant={variant} busy={busy} busyLabel={busyLabel}>
              {confirmLabel}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Small outlined pill: the log table's Cold flag. */
export const BADGE = "inline-block rounded-full border border-border px-1.5 py-0.5 text-[0.7rem]";

/**
 * #1 danger-zone project deletion: a text trigger that expands into a
 * typed-name confirmation. The API needs `?confirm=<exact name>`, and the
 * Delete button stays disabled until the field matches. `onDeleted` is the
 * caller's list refresh - the row unmounts this component on success.
 */
export function DeleteProject({
  name,
  onDeleted,
  triggerLabel = "Delete project",
  triggerVariant = "danger",
}: {
  name: string;
  onDeleted: () => void;
  /** Rows use a short, quiet trigger; the danger zone names the action in full. */
  triggerLabel?: string;
  triggerVariant?: "quiet" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fieldId = `delete-project-${name}`;

  if (!open) {
    return (
      <Button variant={triggerVariant} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
    );
  }

  const reset = () => {
    setOpen(false);
    setConfirm("");
    setError("");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        setBusy(false);
        setError(
          response.status === 404
            ? "This project no longer exists - it may already be deleted."
            : "Could not delete this project. Try again.",
        );
        return;
      }
      onDeleted();
    } catch {
      setBusy(false);
      setError("Could not reach the control plane. Try again.");
    }
  };

  const mismatch = confirm !== "" && confirm !== name;
  return (
    // The field takes its own line rather than sharing one with the buttons:
    // the consequence belongs under the input as a hint, and a hint inside a
    // baseline-aligned row would push the buttons off the input's baseline.
    <form className="col-span-full grid gap-3 pt-1 pb-2" onSubmit={submit}>
      <TextField
        id={fieldId}
        label={`Type ${name} to confirm`}
        fieldClassName="max-w-[26rem]"
        value={confirm}
        autoComplete="off"
        spellCheck={false}
        placeholder={name}
        hint="This deletes the project, every deployed version, and its route. It cannot be undone."
        onChange={(event) => {
          setConfirm(event.target.value);
          setError("");
        }}
        error={mismatch ? "That does not match the project name." : error || null}
      />
      <div data-slot="form-actions" className={FORM_ACTIONS}>
        <Button variant="quiet" onClick={reset} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" busy={busy} busyLabel="Deleting…" disabled={confirm !== name}>
          Delete permanently
        </Button>
      </div>
    </form>
  );
}

/** #7: copy a full value (digests, hostnames) to the clipboard. */
export function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="ms-1.5 rounded-[5px] border border-border bg-transparent px-1.5 py-0.5 align-middle text-[0.68rem] text-muted-foreground transition-[border-color,color,scale] duration-150 hover:border-line-strong hover:text-foreground active:scale-96"
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export function Metric({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string;
  detail: string;
  /** `warning` is what admin uses for a non-zero error or ban count. */
  tone?: "neutral" | "warning";
}) {
  return (
    <section
      className="flex min-h-28 flex-col rounded-lg border border-border bg-card px-[1.15rem] py-4"
      aria-label={label}
    >
      <p className="m-0 text-[0.72rem] text-muted-foreground">{label}</p>
      <strong
        className={cn(
          "mt-[1.35rem] mb-1 block text-[2rem] font-bold tracking-[-0.04em] tabular-nums",
          tone === "warning" && "text-coral",
        )}
      >
        {value}
      </strong>
      <span className="text-[0.72rem] text-muted-foreground">{detail}</span>
    </section>
  );
}
