import { createContext, useCallback, useContext, useEffect, useState } from "react";

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
