import { useCallback, useEffect, useState } from "react";

export type Overview = {
  metrics: { activeProjects: number; deployments: number; requestsLast24Hours: number; successRate: number | null };
  projects: Array<{ name: string; hostname: string; activeDeploymentId: string; deployedAt: string }>;
  deployments: Array<{ id: string; project: string; hostname: string; artifact: string; deployedAt: string; active: boolean }>;
};

export function useOverview() {
  const [data, setData] = useState<Overview>();
  const [state, setState] = useState<"loading" | "ready" | "sign-in" | "setup" | "error">("loading");
  const refresh = useCallback(async () => {
    await fetch("/v1/overview", { credentials: "include" })
      .then(async (response) => {
        if (response.ok) { setData(await response.json() as Overview); return setState("ready"); }
        if (response.status !== 401) return setState("error");
        const account = await fetch("/v1/me", { credentials: "include" });
        setState(account.ok ? "setup" : "sign-in");
      })
      .catch(() => setState("error"));
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { data, state, error: state === "error", refresh };
}

export function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}
