import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "../src/components/button";
import { Switch } from "../src/components/switch";
import { ToastProvider, toast } from "../src/components/toast";
import { TooltipProvider } from "../src/components/tooltip";
import { PortalContainer } from "../src/lib/portal";
import { Gallery, openState } from "./gallery";
import { setReduced, setSpeed } from "./motion";

type Theme = "light" | "dark";
type View = "both" | Theme;

const params = new URLSearchParams(location.search);

/**
 * One panel per theme. `data-theme` on the panel re-scopes every token, and floating
 * layers mount inside it (PortalContainer), so a menu opened in the dark panel is dark.
 */
function ThemePanel({ theme, children }: { theme: Theme; children: ReactNode }) {
  const [scope, setScope] = useState<HTMLElement | null>(null);
  return (
    <div
      ref={setScope}
      data-theme={theme}
      data-panel={theme}
      className="relative min-w-0 rounded-2xl bg-canvas p-4 text-fg sm:p-6"
    >
      <h2 className="mb-5 text-lg font-bold capitalize">{theme} theme</h2>
      <PortalContainer value={scope}>{children}</PortalContainer>
    </div>
  );
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  );
  // An open state (?open=...) is one overlay on one page: render only the page theme.
  const initialView = params.get("view");
  const [view, setView] = useState<View>(
    openState
      ? theme
      : initialView === "light" || initialView === "dark" || initialView === "both"
        ? initialView
        : "both",
  );
  const [density, setDensity] = useState("comfortable");
  const [slow, setSlow] = useState(1);
  const [reduced, setReducedState] = useState(false);

  useEffect(() => {
    if (!openState) return;
    document
      .querySelector(`[data-panel] [data-section="${openState === "select" ? "Form controls" : "Overlays"}"]`)
      ?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => setSpeed(slow), [slow]);
  useEffect(() => setReduced(reduced), [reduced]);

  function pickTheme(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("sb-theme", next);
    } catch {
      // Private mode: the choice just will not persist.
    }
    setTheme(next);
    if (view !== "both") setView(next);
  }

  const panels: Theme[] = view === "both" ? ["light", "dark"] : [view];

  return (
    <TooltipProvider>
      <ToastProvider>
        <div data-density={density} className="min-h-dvh">
          <header className="z-(--sb-z-sticky) sm:sticky sm:top-0 flex flex-wrap items-center gap-x-3 gap-y-2 bg-canvas/90 px-4 py-2.5 shadow-card backdrop-blur sm:px-6">
            <h1 className="min-w-0 flex-1 basis-40 truncate text-md font-semibold">@sproutboat/ikada</h1>
            <div className="flex flex-wrap items-center gap-2">
              {(["both", "light", "dark"] as const).map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={view === v ? "primary" : "secondary"}
                  aria-pressed={view === v}
                  onClick={() => {
                    setView(v);
                    if (v !== "both") pickTheme(v);
                  }}
                  className="capitalize"
                >
                  {v}
                </Button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDensity(density === "compact" ? "comfortable" : "compact")}
                aria-pressed={density === "compact"}
              >
                Density: {density}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSlow(slow === 1 ? 4 : 1)} aria-pressed={slow !== 1}>
                {slow === 1 ? "Slow motion: off" : `Slow motion: ${slow}x`}
              </Button>
              <Switch label="Reduced motion" checked={reduced} onCheckedChange={setReducedState} className="text-sm" />
              <Button size="sm" variant="ghost" onClick={() => toast.close()}>
                Clear toasts
              </Button>
            </div>
          </header>

          <main className="mx-auto flex w-full max-w-[1800px] flex-col gap-6 px-3 py-6 sm:px-6">
            <p className="max-w-prose text-fg-muted">
              Every component in every state, in both themes. Add <code className="font-mono text-sm">?view=light</code>{" "}
              or <code className="font-mono text-sm">?view=dark</code> for one theme, and{" "}
              <code className="font-mono text-sm">?open=menu</code>, select, dialog, tooltip, popover or toast to open
              that state.
            </p>
            <div
              className={
                view === "both" ? "grid items-start gap-6 min-[1500px]:grid-cols-2" : "mx-auto w-full max-w-5xl"
              }
            >
              {panels.map((t) => (
                <ThemePanel key={t} theme={t}>
                  <Gallery />
                </ThemePanel>
              ))}
            </div>
          </main>
          {openState === "toast" ? <ToastOnLoad /> : null}
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}

function ToastOnLoad() {
  useState(() => {
    queueMicrotask(() => {
      toast.add({ title: "Deployment ready", description: "v12 is live on all regions.", type: "success", timeout: 0 });
      toast.add({
        title: "Fell back to supervisor",
        description: "sproutd refused to load v12.",
        type: "warning",
        timeout: 0,
      });
    });
  });
  return null;
}
