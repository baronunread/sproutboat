import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { Shell } from "../components";
import { CliCredentials, DeleteAccount } from "../account";

export const Route = createFileRoute("/settings")({ component: Settings, head: () => ({ meta: [{ title: "Settings · Sproutboat" }] }) });

function setTheme(theme: "light" | "dark") { document.documentElement.dataset.theme = theme; localStorage.setItem("sproutboat-theme", theme); }

function Settings() {
  const account = useLoaderData({ from: "__root__" });
  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Settings</h1><p>Appearance preferences stay on this browser.</p></div>
      </section>
      <section className="data-panel settings-panel">
        <h2>Theme</h2>
        <p>Choose the workspace appearance that works best for your environment.</p>
        <div className="theme-actions">
          <button className="button quiet" type="button" onClick={() => setTheme("dark")}>Dark</button>
          <button className="button quiet" type="button" onClick={() => setTheme("light")}>Light</button>
        </div>
      </section>
      <CliCredentials />
      <DeleteAccount username={account?.profile?.username} />
    </Shell>
  );
}
