import { useRouterState, Link } from "@tanstack/react-router";
import {
  useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode,
} from "react";
import type * as React from "react";
import { useAccount } from "./dashboard-data";
import { Button as UiButton } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableHeader } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
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
 * visually — a placeholder is never a label.
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
  label, hint, error, hideLabel, footer, fieldClassName, fieldId, hintId, errorId, children,
}: FieldProps & { fieldId: string; hintId: string; errorId: string; children: ReactNode }) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", fieldClassName)}>
      <Label className={cn("text-[0.78rem] font-medium", hideLabel && "sr-only")} htmlFor={fieldId}>{label}</Label>
      {children}
      {hint && <p className="max-w-[42rem] text-xs leading-normal text-muted-foreground" id={hintId}>{hint}</p>}
      {footer && <div className="text-xs text-muted-foreground">{footer}</div>}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-destructive" id={errorId} role="alert">
          <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center rounded-full border border-current text-[0.6rem] font-bold">!</span>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label, hint, error, hideLabel, footer, fieldClassName, id, className, ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { fieldId, hintId, errorId } = useFieldIds(id);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} footer={footer} fieldClassName={fieldClassName} fieldId={fieldId} hintId={hintId} errorId={errorId}>
      <Input
        {...input}
        id={fieldId}
        className={cn("bg-background text-sm", className)}
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
  label, hint, error, hideLabel, footer, fieldClassName, id, options, value,
  onValueChange, disabled, placeholder,
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
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} footer={footer} fieldClassName={fieldClassName} fieldId={fieldId} hintId={hintId} errorId={errorId}>
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
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  );
}

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
  variant = "quiet", busy = false, busyLabel, children, className, disabled, type = "button", ...button
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

export function StatusMessage({ tone = "info", children }: { tone?: "info" | "success" | "error"; children: ReactNode }) {
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
export const RECORD_NOTE = "order-9 basis-full text-[0.72rem] leading-relaxed text-muted-foreground [&_code]:[overflow-wrap:anywhere]";

/** The link/button that names a row. */
export const RECORD_TITLE = "cursor-pointer border-0 bg-transparent p-0 text-start text-[0.84rem] font-medium underline-offset-2 hover:underline";

/**
 * A dense table in a bounded scroll box with a sticky head. The caption names
 * it for assistive tech and for `getByRole("table", { name })` in the e2e
 * suite, so it stays even though it is visually hidden.
 */
export function DataTable({ caption, head, children, className }: {
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

/** Right-aligned, tabular numeric cell; and the trailing actions cell. */
export const NUM_CELL = "text-end tabular-nums";
export const ACTIONS_CELL = "flex items-center justify-end gap-2 [&_button]:h-8 [&_button]:px-2.5";

/** Status pip + label. `live` is the good state. */
export function Status({ live, children }: { live?: boolean; children: ReactNode }) {
  return (
    <span className={cn(
      "inline-flex min-w-22 items-center gap-1.5 text-[0.72rem] font-semibold",
      "before:size-1.5 before:rounded-full before:content-['']",
      live ? "text-success before:bg-success" : "text-muted-foreground before:bg-muted-foreground",
    )}>
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
const PANEL_BASE = "group/panel overflow-hidden rounded-lg border border-border bg-card [&+&]:mt-6 max-[480px]:rounded-[7px]";

export function Panel({
  variant = "form", className, children, ...section
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

/** The muted "loading…" body a panel shows while its data is in flight. */
export function LoadingPanel({ children }: { children: ReactNode }) {
  return (
    <Panel variant="bare" className="min-h-56 pt-12 text-muted-foreground" aria-live="polite">{children}</Panel>
  );
}

/**
 * Section heading + optional action, shared by every panel.
 *
 * The inset comes from the panel, not from here: a bare panel's heading owns
 * the 1.25rem, a padded one's must not add to the padding the panel already
 * has. Reading that off the parent is what the old CSS got wrong — it inset
 * twice in .settings-panel, so the title sat 1.25rem right of its own rule.
 */
export function PanelHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-[1.1rem] group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:pt-0 group-[.is-padded]/panel:pb-5">
      <div>
        <h2 className="m-0 text-[0.95rem] font-semibold tracking-[-0.015em] group-[.is-padded]/panel:text-base">{title}</h2>
        {description && <p className="mt-1.5 max-w-[38rem] text-[0.875rem] leading-normal text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * The "nothing here yet" body. A centred hero when it fills a bare panel; a
 * plain line of text when it sits between a heading and a form in a padded one.
 */
export function EmptyState({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      "px-5 py-12 text-center group-[.is-padded]/panel:px-0 group-[.is-padded]/panel:py-5 group-[.is-padded]/panel:text-start",
      className,
    )}>
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
 * row's overflow cannot clip it — the last of which the previous native
 * <dialog> in a table cell did not guarantee.
 */
export function ConfirmButton({
  label, busyLabel, title, description, confirmLabel, onConfirm, disabled,
  variant = "danger", triggerVariant, className,
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
    try { await onConfirm(); } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant={triggerVariant ?? variant} className={className} disabled={disabled} busy={busy} busyLabel={busyLabel}>
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
          <AlertDialogCancel asChild><Button variant="quiet">Cancel</Button></AlertDialogCancel>
          <AlertDialogAction asChild onClick={(event) => { event.preventDefault(); void run(); }}>
            <Button variant={variant} busy={busy} busyLabel={busyLabel}>{confirmLabel}</Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function SproutboatMark() {
  return (
    <svg className="size-[1.65rem] text-brand" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="currentColor" />
      <path
        d="M10 23V9h7.3c3.3 0 5.4 1.8 5.4 4.7 0 3-2.1 4.8-5.4 4.8H14V23h-4Zm4-8h3c1.1 0 1.7-.5 1.7-1.3 0-.9-.6-1.4-1.7-1.4h-3V15Z"
        fill="white"
      />
    </svg>
  );
}

const NAV_ICON_PATHS = {
    overview: <><rect x="2.5" y="2.5" width="4" height="4" rx=".75" /><rect x="9.5" y="2.5" width="4" height="4" rx=".75" /><rect x="2.5" y="9.5" width="4" height="4" rx=".75" /><rect x="9.5" y="9.5" width="4" height="4" rx=".75" /></>,
    // Compute: a processor die, the way every console draws "runs your code".
    compute: <><rect x="4.5" y="4.5" width="7" height="7" rx="1" /><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" /></>,
    // A sprout, for the unit that actually serves requests.
    sprouts: <><path d="M8 13.5V7" /><path d="M8 7C8 4.8 6.2 3 4 3c0 2.2 1.8 4 4 4Z" /><path d="M8 8.5c0-1.9 1.5-3.4 3.4-3.4 0 1.9-1.5 3.4-3.4 3.4Z" /></>,
    deployments: <><path d="M8 2.5v7" /><path d="m5.5 7 2.5 2.5L10.5 7" /><path d="M3 11.5v2h10v-2" /></>,
    storage: <><ellipse cx="8" cy="4" rx="5" ry="1.8" /><path d="M3 4v8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V4" /><path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" /></>,
    // Sliders, not a sun: settings are things you adjust.
    settings: <><path d="M2.5 5h6M11 5h2.5M2.5 11h2.5M7.5 11h6" /><circle cx="9.75" cy="5" r="1.6" /><circle cx="6.25" cy="11" r="1.6" /></>,
    // A shield reads as "privileged area" where a second gear reads as "more settings".
    admin: <><path d="M8 2.5 3.5 4.2v3.5c0 3 1.9 5 4.5 5.8 2.6-.8 4.5-2.8 4.5-5.8V4.2z" /></>,
};
function NavIcon({ name }: { name: keyof typeof NAV_ICON_PATHS }) {
  return <svg className="size-4 shrink-0" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{NAV_ICON_PATHS[name]}</svg>;
}
export function Arrow() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path
        d="M3 8h9M8.5 3.5 13 8l-4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

async function logout() {
  await fetch("/api/auth/sign-out", { method: "POST", credentials: "include" });
  location.assign("/login");
}

/** Last path segment as the topbar location: section names get a capital, a
 *  project slug is left as-is (it's a name, not a word). */
function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sproutboat-theme", theme);
}

const NAV_ACTIVE = { "aria-current": "page" as const };

/**
 * Which nav group owns which routes. Exported because the pre-paint boot script
 * needs the same mapping: on a cold load it must open the group holding the
 * current route before anything is painted, and it cannot import this module.
 */
export const NAV_GROUP_ROUTES = {
  compute: ["/projects", "/queues"],
  storage: ["/kv", "/d1", "/r2"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const inGroup = (pathname: string, group: keyof typeof NAV_GROUP_ROUTES) =>
  NAV_GROUP_ROUTES[group].some((prefix) => pathname.startsWith(prefix));

/** Segments whose display name is not just their capitalised path. */
const SEGMENT_LABELS = new Map([
  ["kv", "KV"], ["d1", "D1"], ["r2", "R2"], ["projects", "Sprouts"],
]);

function breadcrumb(pathname: string): string {
  if (pathname === "/") return "Overview";
  return pathname.slice(1).split("/")
    .map((segment) => SEGMENT_LABELS.get(segment) ?? segment)
    .join("/");
}
const EXACT = { exact: true } as const;

/**
 * A collapsible nav section. `<details>` is the platform's disclosure widget —
 * keyboard operable and expandable without script — and `open` starts the group
 * expanded whenever the current route lives inside it.
 */
/** One nav row. Shared by links and by a group's <summary>, so they line up. */
const NAV_LINK = "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[0.82rem] text-muted-foreground no-underline hover:bg-accent aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground nav-collapsed:justify-center nav-collapsed:px-0 max-[800px]:whitespace-nowrap";
const NAV_SECTION = "px-2.5 pb-1.5 text-[0.68rem] font-semibold tracking-wider text-muted-foreground uppercase max-[800px]:hidden nav-collapsed:hidden";
const MENU_ITEM = "rounded border-0 bg-none px-2 py-1.5 text-left text-[0.8rem] text-muted-foreground no-underline hover:bg-accent hover:text-foreground";
const AVATAR = "grid size-8 cursor-pointer place-items-center overflow-hidden rounded-[7px] border border-border bg-secondary text-[0.75rem] text-foreground list-none [&::-webkit-details-marker]:hidden";
/** Small outlined pill: the Admin marker and the log table's Cold flag. */
export const BADGE = "inline-block rounded-full border border-border px-1.5 py-0.5 text-[0.7rem]";
/** Label text hidden when the rail is collapsed, but kept on narrow screens
 *  where the rail becomes a horizontal strip and the icons alone would not do. */
const NAV_LABEL = "nav-collapsed:hidden max-[800px]:nav-collapsed:inline";

/**
 * A collapsible nav section. `<details>` is the platform's disclosure widget —
 * keyboard operable and expandable without script — and `open` starts the group
 * expanded whenever the current route lives inside it.
 */
function NavGroup({ label, groupKey, icon, routeOpen, children }: {
  label: string;
  /** Stable key for the pre-paint script and the stored preference. */
  groupKey: string;
  icon: keyof typeof NAV_ICON_PATHS;
  /** True when the current route lives in this group. */
  routeOpen: boolean;
  children: ReactNode;
}) {
  const group = useRef<HTMLDetailsElement>(null);

  // `open` is deliberately a constant here, never React state. The static shell
  // ships every group open, and the boot script closes the ones this reader
  // stored as closed *before first paint* — so a reload never shows a group
  // opening or closing after the fact. Because the prop never changes, React
  // never patches the attribute back and the element stays the reader's.
  useEffect(() => {
    if (routeOpen && group.current) group.current.open = true;
  }, [routeOpen]);

  return (
    <details
      className="group/nav m-0"
      data-group={groupKey}
      open
      suppressHydrationWarning
      ref={group}
      onToggle={(event) => localStorage.setItem(`sproutboat-nav-group:${groupKey}`, event.currentTarget.open ? "open" : "closed")}
    >
      {/* Collapsed, a group's children are hidden, so the icon has to carry
          "you are here" on its own. */}
      <summary className={cn(
        NAV_LINK, "w-full cursor-pointer list-none [&::-webkit-details-marker]:hidden",
        routeOpen && "nav-collapsed:bg-accent nav-collapsed:text-foreground",
      )}>
        <NavIcon name={icon} />
        <span className={cn("flex-1", NAV_LABEL)}>{label}</span>
        <svg className={cn("size-3.5 shrink-0 transition-[rotate] duration-150 group-open/nav:rotate-90 motion-reduce:transition-none", NAV_LABEL)}
          viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </summary>
      <div className="mt-0.5 mb-1.5 grid gap-0.5 nav-collapsed:hidden max-[800px]:nav-collapsed:grid">{children}</div>
    </details>
  );
}

export function Shell({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { account } = useAccount();
  const computeOpen = inGroup(pathname, "compute");
  const storageOpen = inGroup(pathname, "storage");
  // The rail's state is stamped on <html> by the boot script before first paint,
  // so it never flashes expanded on reload. React mirrors it for aria-expanded;
  // the attribute, not a class on this element, is what CSS keys off.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(document.documentElement.dataset.nav === "collapsed"); }, []);
  const toggleNav = () => {
    const next = document.documentElement.dataset.nav !== "collapsed";
    document.documentElement.dataset.nav = next ? "collapsed" : "expanded";
    localStorage.setItem("sproutboat-nav", next ? "collapsed" : "expanded");
    setCollapsed(next);
  };
  const username = account?.profile?.username;
  const displayName = username || account?.user?.name || "account";
  const subLink = cn(NAV_LINK, "ps-[2.3rem] nav-collapsed:ps-0");
  return (
    <div className="grid min-h-screen grid-cols-[15rem_minmax(0,1fr)] nav-collapsed:grid-cols-[4rem_minmax(0,1fr)] max-[800px]:grid-cols-1 max-[800px]:content-start max-[800px]:nav-collapsed:grid-cols-1">
      <aside className="sticky top-0 flex h-screen flex-col border-r border-border bg-card px-3 py-[1.15rem] nav-collapsed:px-2 max-[800px]:static max-[800px]:h-auto max-[800px]:border-r-0 max-[800px]:border-b">
        <div className="flex items-center justify-between gap-2 px-2 nav-collapsed:justify-center nav-collapsed:px-0">
          <Link className="inline-flex items-center gap-2.5 px-2 py-1 text-[0.95rem] font-extrabold tracking-tight no-underline" to="/">
            <SproutboatMark />
            <span className="nav-collapsed:hidden">Sproutboat</span>
          </Link>
          <button type="button"
            className="grid size-8 place-items-center rounded-md border-0 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-4"
            onClick={toggleNav}
            aria-expanded={!collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6.5 3v10" />
            </svg>
          </button>
        </div>
        <nav className="mt-11 grid gap-0.5 max-[800px]:mt-4 max-[800px]:flex max-[800px]:overflow-auto" aria-label="Primary navigation">
          <Link className={NAV_LINK} to="/" activeOptions={EXACT} activeProps={NAV_ACTIVE}>
            <NavIcon name="overview" /><span className={NAV_LABEL}>Overview</span>
          </Link>

          <span className={NAV_SECTION}>Build</span>
          <NavGroup label="Compute" groupKey="compute" icon="compute" routeOpen={computeOpen}>
            <Link className={subLink} to="/projects" activeProps={NAV_ACTIVE}>Sprouts</Link>
            <Link className={subLink} to="/queues" activeProps={NAV_ACTIVE}>Queues</Link>
          </NavGroup>
          <NavGroup label="Storage &amp; databases" groupKey="storage" icon="storage" routeOpen={storageOpen}>
            <Link className={subLink} to="/kv" activeProps={NAV_ACTIVE}>KV</Link>
            <Link className={subLink} to="/d1" activeProps={NAV_ACTIVE}>D1</Link>
            <Link className={subLink} to="/r2" activeProps={NAV_ACTIVE}>R2</Link>
          </NavGroup>

          <span className={cn(NAV_SECTION, "mt-5")}>Account</span>
          <Link className={NAV_LINK} to="/settings" activeProps={NAV_ACTIVE}>
            <NavIcon name="settings" /><span className={NAV_LABEL}>Settings</span>
          </Link>
          {account?.isAdmin && (
            <Link className={NAV_LINK} to="/admin" activeProps={NAV_ACTIVE}>
              <NavIcon name="admin" /><span className={NAV_LABEL}>Admin</span>
            </Link>
          )}
        </nav>
        <div className="mx-2 mt-auto border-t border-border pt-4 text-[0.72rem] text-muted-foreground max-[800px]:hidden nav-collapsed:hidden">
          <span className="mr-1.5 inline-block size-[0.45rem] rounded-full bg-success" aria-hidden="true" />
          Experimental VPS POC
        </div>
      </aside>
      <div className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-5 flex h-14 items-center justify-between border-b border-border bg-[color-mix(in_srgb,var(--color-background)_90%,transparent)] px-8 backdrop-blur max-[800px]:px-5">
          <p className="m-0 flex items-center gap-2 text-[0.8rem] whitespace-nowrap text-muted-foreground">
            <span className="font-medium text-foreground max-[480px]:hidden">Personal account</span>
            <span className="font-normal text-line-strong max-[480px]:hidden">/</span>
            {breadcrumb(pathname)}
          </p>
          <div className="flex items-center gap-3">
            {account?.isAdmin && <span className={BADGE}>Admin</span>}
            <details className="relative">
              <summary aria-label="Open account menu" className={AVATAR}><Avatar image={account?.user?.image} label={displayName} /></summary>
              <div className="absolute top-[calc(100%+0.5rem)] right-0 z-2 grid w-44 gap-0.5 rounded-lg border border-border bg-popover p-2.5 shadow-[0_16px_48px_rgb(0_0_0/35%)]">
                {username
                  ? <><strong className="px-2 pt-1.5 pb-2.5 text-[0.8rem]">{username}</strong><Link className={MENU_ITEM} to="/profile">Profile</Link><Link className={MENU_ITEM} to="/settings">Settings</Link><button type="button" className={MENU_ITEM} onClick={toggleTheme}>Toggle theme</button><button type="button" className={MENU_ITEM} onClick={logout}>Log out</button></>
                  : <><strong className="px-2 pt-1.5 pb-2.5 text-[0.8rem]">Account</strong><Link className={MENU_ITEM} to="/login">Sign in</Link></>}
              </div>
            </details>
          </div>
        </header>
        <main id="content" className="mx-auto w-full max-w-[1220px] grow px-10 pt-13 pb-20 max-[800px]:px-5 max-[800px]:pt-8 max-[800px]:pb-16">{children}</main>
        <footer className="mt-auto flex justify-between gap-4 border-t border-border px-8 py-5 text-[0.7rem] text-muted-foreground max-[800px]:px-5 max-[480px]:flex-col max-[480px]:items-start">
          <span>Sproutboat experimental VPS platform</span><span>© {new Date().getFullYear()} Sproutboat</span>
          <a className="text-inherit underline-offset-2" href="mailto:hello@sproutboat.com">Contact</a>
        </footer>
      </div>
    </div>
  );
}

/**
 * #1 danger-zone project deletion: a text trigger that expands into a
 * typed-name confirmation. The API needs `?confirm=<exact name>`, and the
 * Delete button stays disabled until the field matches. `onDeleted` is the
 * caller's list refresh — the row unmounts this component on success.
 */
export function DeleteProject({ name, onDeleted, triggerLabel = "Delete project", triggerVariant = "danger" }: {
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
    return <Button variant={triggerVariant} onClick={() => setOpen(true)}>{triggerLabel}</Button>;
  }

  const reset = () => { setOpen(false); setConfirm(""); setError(""); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(""); setBusy(true);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, {
        method: "DELETE", credentials: "include",
      });
      if (!response.ok) {
        setBusy(false);
        setError(response.status === 404 ? "This project no longer exists — it may already be deleted." : "Could not delete this project. Try again.");
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
    <form className="col-span-full grid gap-3 pt-1 pb-2" onSubmit={submit}>
      <div className="flex flex-wrap items-end gap-2.5">
        <TextField
          id={fieldId}
          label={`Type ${name} to permanently delete this project, every deployed version, and its route`}
          value={confirm}
          autoComplete="off"
          spellCheck={false}
          placeholder={name}
          onChange={(event) => { setConfirm(event.target.value); setError(""); }}
          error={mismatch ? "That does not match the project name." : error || null}
        />
        <Button variant="quiet" onClick={reset} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="danger" busy={busy} busyLabel="Deleting…" disabled={confirm !== name}>Delete permanently</Button>
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
    } catch { /* clipboard blocked */ }
  };
  return (
    <button type="button" onClick={() => void copy()}
      className="ms-1.5 rounded-[5px] border border-border bg-transparent px-1.5 py-0.5 align-middle text-[0.68rem] text-muted-foreground transition-[border-color,color,scale] duration-150 hover:border-line-strong hover:text-foreground active:scale-96">
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/** #18: the GitHub avatar with the username initial as fallback when it is absent or fails to load. */
export function Avatar({ image, label }: { image?: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return <img className="block size-full object-cover" src={image} alt={`${label} avatar`} width={32} height={32} onError={() => setFailed(true)} />;
  }
  return <span aria-hidden="true">{label.slice(0, 1).toUpperCase() || "?"}</span>;
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
    <section className="flex min-h-28 flex-col rounded-lg border border-border bg-card px-[1.15rem] py-4" aria-label={label}>
      <p className="m-0 text-[0.72rem] text-muted-foreground">{label}</p>
      <strong className={cn(
        "mt-[1.35rem] mb-1 block text-[2rem] font-bold tracking-[-0.04em] tabular-nums",
        tone === "warning" && "text-coral",
      )}>{value}</strong>
      <span className="text-[0.72rem] text-muted-foreground">{detail}</span>
    </section>
  );
}
