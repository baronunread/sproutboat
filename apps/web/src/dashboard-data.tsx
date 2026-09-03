import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export type Account = {
  profile?: { username?: string };
  isAdmin?: boolean;
  user?: { name?: string | null; email?: string; image?: string | null };
};

type AccountState = { account?: Account; state: "loading" | "authed" | "anon"; refresh: () => void };
const AccountContext = createContext<AccountState | undefined>(undefined);

/**
 * Client-side session state, shared by every screen. The dashboard is a
 * prerendered SPA: the shell is built with the API offline, so auth cannot come
 * from a router loader (its baked `account: undefined` would stick across hard
 * reloads and show logged-out chrome on /profile, /settings, and the nav).
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<Account>();
  const [state, setState] = useState<"loading" | "authed" | "anon">("loading");
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/account", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!alive) return;
        // SAFETY: /api/account returns the Account contract on 2xx; null otherwise.
        setAccount(body === null ? undefined : (body as Account));
        setState(body === null ? "anon" : "authed");
      })
      .catch(() => { if (alive) setState("anon"); });
    return () => { alive = false; };
  }, [nonce]);
  return <AccountContext.Provider value={{ account, state, refresh: () => setNonce((n) => n + 1) }}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountState {
  const value = useContext(AccountContext);
  if (!value) throw new Error("useAccount must be used inside AccountProvider");
  return value;
}

export type LoadState = "loading" | "ready" | "error";

/**
 * #76 — one GET, its loading state, and a refresh, for the panels that read a
 * single JSON endpoint. Every new dashboard view fetches through this instead
 * of repeating the same useEffect/try/catch/setState block.
 *
 * SAFETY: the caller names the contract its 2xx body satisfies; a non-2xx or a
 * transport failure resolves to `state: "error"` and leaves `data` undefined.
 */
export function useJson<T>(url: string | null) {
  const [data, setData] = useState<T>();
  const [state, setState] = useState<LoadState>("loading");

  const refresh = useCallback(async () => {
    if (url === null) return;
    setState("loading");
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) { setState("error"); return; }
      // SAFETY: only a 2xx body is read, and the caller names the contract that
      // endpoint satisfies; every other outcome sets state to "error" instead.
      setData(await response.json() as T);
      setState("ready");
    } catch { setState("error"); }
  }, [url]);

  useEffect(() => {
    let ignore = false;
    if (url === null) { setState("ready"); return; }
    setState("loading");
    void fetch(url, { credentials: "include" })
      .then(async (response) => {
        if (ignore) return;
        if (!response.ok) { setState("error"); return; }
        // SAFETY: as above — a 2xx body only, typed by the calling view.
        const body = await response.json() as T;
        if (ignore) return;
        setData(body);
        setState("ready");
      })
      .catch(() => { if (!ignore) setState("error"); });
    return () => { ignore = true; };
  }, [url]);

  return { data, state, refresh };
}

/** A mutating call: reports the server's `{ error }` message rather than a generic failure. */
export async function mutate(url: string, init: RequestInit = {}): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: "include", ...init });
    if (response.ok) return null;
    // SAFETY: an error body from the control API is { error?: string }.
    const body = await response.json().catch(() => ({})) as { error?: string };
    return body.error ?? `Request failed (${response.status}).`;
  } catch {
    return "Could not reach the control plane. Try again.";
  }
}

export type Overview = {
  metrics: {
    activeProjects: number; deployments: number; requestsLast24Hours: number; successRate: number | null;
    trend?: Array<{ start: string; count: number; errors: number }>;
  };
  projects: Array<{ name: string; hostname: string; activeDeploymentId: string; deployedAt: string }>;
  deployments: Array<{ id: string; project: string; hostname: string; artifact: string; deployedAt: string; active: boolean }>;
};

const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function useOverview() {
  const [data, setData] = useState<Overview>();
  const [state, setState] = useState<"loading" | "ready" | "sign-in" | "setup" | "error">("loading");
  const refresh = useCallback(async () => {
    await fetch("/api/overview", { credentials: "include" })
      .then(async (response) => {
        if (response.ok) {
          // SAFETY: /api/overview returns the Overview contract for successful responses.
          setData(await response.json() as Overview);
          return setState("ready");
        }
        if (response.status !== 401) return setState("error");
        const account = await fetch("/api/account", { credentials: "include" });
        setState(account.ok ? "setup" : "sign-in");
      })
      .catch(() => setState("error"));
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, state, error: state === "error", refresh };
}

/**
 * State shared across the `/projects/:name` control-room sections (#5). The
 * layout route provides it; each section reads it instead of fetching again.
 *
 * #76 — `deployments` is the project's *complete* version list from
 * `/api/projects/:name/deployments`, not the 20-newest-across-all-projects
 * slice `/api/overview` carries, which silently truncated this view.
 */
export type ProjectDeployment = {
  id: string; project: string; hostname: string; artifact: string; deployedAt: string; active: boolean;
};

export type ProjectView = {
  name: string;
  deployments: ProjectDeployment[];
  active: Overview["projects"][number] | undefined;
  refresh: () => Promise<void>;
};
const ProjectContext = createContext<ProjectView | undefined>(undefined);
export const ProjectProvider = ProjectContext.Provider;
export function useProject(): ProjectView {
  const value = useContext(ProjectContext);
  if (!value) throw new Error("useProject must be used inside a project route");
  return value;
}

export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : DATE_FORMATTER.format(new Date(value));
}
