import { useRouterState, Link } from "@tanstack/react-router";
import {
  useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type FormEvent, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useAccount } from "./dashboard-data";

/* ---------------------------------------------------------------------------
 * Form primitives (#76)
 *
 * Every text field, select and textarea in the dashboard goes through these, so
 * a control cannot ship without a real <label>, its hint and error wired up via
 * aria-describedby, aria-invalid on failure, and one shared visual language.
 * Passing `hideLabel` keeps the label in the accessibility tree and hides it
 * visually — a placeholder is never a label.
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
    <div className={`field ${error ? "field-invalid" : ""} ${fieldClassName ?? ""}`.trim()}>
      <label className={hideLabel ? "field-label visually-hidden" : "field-label"} htmlFor={fieldId}>{label}</label>
      {children}
      {hint && <p className="field-hint" id={hintId}>{hint}</p>}
      {footer && <div className="field-footer">{footer}</div>}
      {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
    </div>
  );
}

export function TextField({
  label, hint, error, hideLabel, footer, fieldClassName, id, ...input
}: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const { fieldId, hintId, errorId } = useFieldIds(id);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} footer={footer} fieldClassName={fieldClassName} fieldId={fieldId} hintId={hintId} errorId={errorId}>
      <input
        {...input}
        id={fieldId}
        className={`control ${input.className ?? ""}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(hint, error, hintId, errorId)}
      />
    </FieldShell>
  );
}

export function SelectField({
  label, hint, error, hideLabel, footer, fieldClassName, id, options, ...select
}: FieldProps & SelectHTMLAttributes<HTMLSelectElement> & { options: ReadonlyArray<readonly [string, string]> }) {
  const { fieldId, hintId, errorId } = useFieldIds(id);
  return (
    <FieldShell label={label} hint={hint} error={error} hideLabel={hideLabel} footer={footer} fieldClassName={fieldClassName} fieldId={fieldId} hintId={hintId} errorId={errorId}>
      <div className="control-select">
        <select
          {...select}
          id={fieldId}
          className={`control ${select.className ?? ""}`.trim()}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(hint, error, hintId, errorId)}
        >
          {options.map(([value, optionLabel]) => <option key={value} value={value}>{optionLabel}</option>)}
        </select>
        <svg className="control-chevron" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="m4 6.5 4 4 4-4" />
        </svg>
      </div>
    </FieldShell>
  );
}

/**
 * A button that owns its own pending state: `busy` disables it, marks it
 * aria-busy, and swaps the label so a screen reader hears the change too.
 */
export function Button({
  variant = "quiet", busy = false, busyLabel, children, className, disabled, ...button
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "quiet" | "danger";
  busy?: boolean;
  busyLabel?: string;
}) {
  return (
    <button
      {...button}
      className={`button ${variant} ${className ?? ""}`.trim()}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? (busyLabel ?? "Working…") : children}
    </button>
  );
}

/**
 * One place for "what just happened" text. `tone="error"` announces
 * assertively (role=alert); everything else is polite (role=status).
 */
export function StatusMessage({ tone = "info", children }: { tone?: "info" | "success" | "error"; children: ReactNode }) {
  if (!children) return null;
  return (
    <p className={`status-message ${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

/** Section heading + optional action, shared by every panel. */
export function PanelHeading({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="panel-heading">
      <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      {action}
    </div>
  );
}

/**
 * Destructive confirmation in a native <dialog>: focus is trapped by the
 * platform, Escape closes it, and the trigger regains focus on close — none of
 * which window.confirm() gives us a way to style, and all of which a bespoke
 * modal would have to reimplement.
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
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const titleId = `confirm-${useId()}`;

  const run = async () => {
    setBusy(true);
    try { await onConfirm(); } finally {
      setBusy(false);
      dialog.current?.close();
    }
  };

  return (
    <>
      <Button variant={triggerVariant ?? variant} className={className} disabled={disabled} busy={busy} busyLabel={busyLabel}
        onClick={() => dialog.current?.showModal()}>
        {label}
      </Button>
      <dialog className="confirm-dialog" ref={dialog} aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-body">{description}</div>
        <div className="confirm-actions">
          <Button variant="quiet" onClick={() => dialog.current?.close()}>Cancel</Button>
          <Button variant={variant} busy={busy} busyLabel={busyLabel} onClick={() => void run()}>{confirmLabel}</Button>
        </div>
      </dialog>
    </>
  );
}

export function SproutboatMark() {
  return (
    <svg className="sproutboat-mark" viewBox="0 0 32 32" aria-hidden="true">
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
  return <svg className="nav-icon" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">{NAV_ICON_PATHS[name]}</svg>;
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

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sproutboat-theme", theme);
}

const NAV_ACTIVE = { "aria-current": "page" as const };

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
function NavGroup({ label, icon, open, children }: {
  label: string;
  icon: keyof typeof NAV_ICON_PATHS;
  /** True when the current route lives in this group: opens it, and marks the
   *  icon while the rail is collapsed and the children are hidden. */
  open: boolean;
  children: ReactNode;
}) {
  return (
    <details className={open ? "nav-group nav-group-current" : "nav-group"} open={open}>
      <summary className="nav-link nav-group-summary">
        <NavIcon name={icon} />
        <span>{label}</span>
        <svg className="nav-chevron" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </summary>
      <div className="nav-group-items">{children}</div>
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
  const computeOpen = ["/projects", "/queues"].some((path) => pathname.startsWith(path));
  const storageOpen = ["/kv", "/d1", "/r2"].some((path) => pathname.startsWith(path));
  const [collapsed, setCollapsed] = useState(false);
  // Read the stored preference after mount: the shell is prerendered, so doing
  // it during render would bake one viewer's choice into the static file.
  useEffect(() => { setCollapsed(localStorage.getItem("sproutboat-nav") === "collapsed"); }, []);
  const toggleNav = () => {
    setCollapsed((current) => {
      localStorage.setItem("sproutboat-nav", current ? "expanded" : "collapsed");
      return !current;
    });
  };
  const username = account?.profile?.username;
  const displayName = username || account?.user?.name || "account";
  return (
    <div className={collapsed ? "app-shell nav-collapsed" : "app-shell"}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link className="brand" to="/">
            <SproutboatMark />
            <span>Sproutboat</span>
          </Link>
          <button type="button" className="nav-toggle" onClick={toggleNav}
            aria-expanded={!collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6.5 3v10" />
            </svg>
          </button>
        </div>
        <nav aria-label="Primary navigation">
          <Link className="nav-link" to="/" activeOptions={EXACT} activeProps={NAV_ACTIVE}>
            <NavIcon name="overview" /><span>Overview</span>
          </Link>

          <span className="nav-section-label">Build</span>
          <NavGroup label="Compute" icon="compute" open={computeOpen}>
            <Link className="nav-link" to="/projects" activeProps={NAV_ACTIVE}>Sprouts</Link>
            <Link className="nav-link" to="/queues" activeProps={NAV_ACTIVE}>Queues</Link>
          </NavGroup>
          <NavGroup label="Storage &amp; databases" icon="storage" open={storageOpen}>
            <Link className="nav-link" to="/kv" activeProps={NAV_ACTIVE}>KV</Link>
            <Link className="nav-link" to="/d1" activeProps={NAV_ACTIVE}>D1</Link>
            <Link className="nav-link" to="/r2" activeProps={NAV_ACTIVE}>R2</Link>
          </NavGroup>

          <span className="nav-section-label nav-section-secondary">Account</span>
          <Link className="nav-link" to="/settings" activeProps={NAV_ACTIVE}><NavIcon name="settings" /><span>Settings</span></Link>
          {account?.isAdmin && (
            <Link className="nav-link" to="/admin" activeProps={NAV_ACTIVE}><NavIcon name="admin" /><span>Admin</span></Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="status-dot" aria-hidden="true" />
          Experimental VPS POC
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <p><span>Personal account</span><b>/</b>{breadcrumb(pathname)}</p>
          <div className="topbar-actions">
            {account?.isAdmin && <span className="badge neutral">Admin</span>}
            <details className="account-menu">
              <summary aria-label="Open account menu" className="avatar"><Avatar image={account?.user?.image} label={displayName} /></summary>
              <div className="account-dropdown">
                {username ? <><strong>{username}</strong><Link to="/profile">Profile</Link><Link to="/settings">Settings</Link><button type="button" onClick={toggleTheme}>Toggle theme</button><button type="button" onClick={logout}>Log out</button></> : <><strong>Account</strong><Link to="/login">Sign in</Link></>}
              </div>
            </details>
          </div>
        </header>
        <main id="content">{children}</main>
        <footer className="app-footer"><span>Sproutboat experimental VPS platform</span><span>© {new Date().getFullYear()} Sproutboat</span><a href="mailto:hello@sproutboat.com">Contact</a></footer>
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
    <form className="danger-confirm" onSubmit={submit}>
      <div className="danger-confirm-row">
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
  return <button type="button" className="copy-button" onClick={() => void copy()}>{done ? "Copied" : "Copy"}</button>;
}

/** #18: the GitHub avatar with the username initial as fallback when it is absent or fails to load. */
export function Avatar({ image, label }: { image?: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  if (image && !failed) {
    return <img className="avatar-img" src={image} alt={`${label} avatar`} width={32} height={32} onError={() => setFailed(true)} />;
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
  tone?: "neutral" | "warning";
}) {
  return (
    <section className={`metric-card ${tone}`}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{detail}</span>
    </section>
  );
}
