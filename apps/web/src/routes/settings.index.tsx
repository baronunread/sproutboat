import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DeleteAccount } from "../account";
import { PanelHeading } from "../components";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/settings/")({ component: General });

const THEMES = [["dark", "Dark"], ["light", "Light"]] as const;

function General() {
  const { account } = useAccount();
  // The theme is applied by an inline script before hydration, so read it back
  // from the element rather than keeping a second source of truth.
  const [theme, setThemeState] = useState<string>("dark");
  useEffect(() => { setThemeState(document.documentElement.dataset.theme ?? "dark"); }, []);

  const choose = (next: string) => {
    document.documentElement.dataset.theme = next;
    localStorage.setItem("sproutboat-theme", next);
    setThemeState(next);
  };

  return (
    <>
      <section className="data-panel settings-panel">
        <PanelHeading title="Theme" description="Choose the workspace appearance that works best for your environment. This preference stays on this browser." />
        <div className="segmented" role="group" aria-label="Theme">
          {THEMES.map(([value, label]) => (
            <button key={value} type="button" className="segment" aria-pressed={theme === value} onClick={() => choose(value)}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <DeleteAccount username={account?.profile?.username} />
    </>
  );
}
