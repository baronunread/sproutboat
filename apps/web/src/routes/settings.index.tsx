import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DeleteAccount } from "../account";
import { Panel, PanelHeading } from "../components";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/settings/")({ component: General });

const THEMES = [
  ["dark", "Dark"],
  ["light", "Light"],
] as const;

function General() {
  const { account } = useAccount();
  // The theme is applied by an inline script before hydration, so read it back
  // from the element rather than keeping a second source of truth.
  const [theme, setThemeState] = useState<string>("dark");
  useEffect(() => {
    setThemeState(document.documentElement.dataset.theme ?? "dark");
  }, []);

  const choose = (next: string) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("sproutboat-theme", next);
    setThemeState(next);
  };

  return (
    <>
      <Panel>
        <PanelHeading
          title="Theme"
          description="Choose the workspace appearance that works best for your environment. This preference stays on this browser."
        />
        <div
          className="mt-5 inline-flex gap-0.5 rounded-[7px] border border-border p-0.5"
          role="group"
          aria-label="Theme"
        >
          {THEMES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="min-h-8 rounded-[5px] border-0 bg-transparent px-3.5 text-[0.8rem] text-muted-foreground transition-[background,color] duration-150 hover:text-foreground aria-pressed:bg-secondary aria-pressed:font-medium aria-pressed:text-foreground"
              aria-pressed={theme === value}
              onClick={() => choose(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </Panel>
      <DeleteAccount username={account?.profile?.username} />
    </>
  );
}
