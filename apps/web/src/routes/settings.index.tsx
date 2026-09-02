import { createFileRoute } from "@tanstack/react-router";
import { DeleteAccount } from "../account";
import { Button, PanelHeading } from "../components";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/settings/")({ component: General });

function setTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sproutboat-theme", theme);
}

function General() {
  const { account } = useAccount();
  return (
    <>
      <section className="data-panel settings-panel">
        <PanelHeading title="Theme" description="Choose the workspace appearance that works best for your environment. This preference stays on this browser." />
        <div className="form-actions">
          <Button onClick={() => setTheme("dark")}>Dark</Button>
          <Button onClick={() => setTheme("light")}>Light</Button>
        </div>
      </section>
      <DeleteAccount username={account?.profile?.username} />
    </>
  );
}
