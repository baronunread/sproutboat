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

export type Overview = {
  metrics: { activeProjects: number; deployments: number; requestsLast24Hours: number; successRate: number | null };
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
 * One overview fetch shared across the `/projects/:name` control-room sections
 * (#5). The layout route filters it to one project and provides this; each
 * section reads it instead of fetching again.
 */
export type ProjectView = {
  name: string;
  deployments: Overview["deployments"];
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
