import { PageHeader } from "@sproutboat/ikada";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { RouteTabs } from "../route-tabs";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
  head: () => ({ meta: [{ title: "Settings · Sproutboat" }] }),
});

function SettingsLayout() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Your account, the credentials that reach it, and what this box allows."
        tabs={
          <RouteTabs
            label="Settings sections"
            tabs={[
              { to: "/settings", label: "General", exact: true },
              { to: "/settings/tokens", label: "API tokens" },
              { to: "/settings/usage", label: "Limits" },
              { to: "/activity", label: "Activity" },
              { to: "/settings/webhooks", label: "Webhooks" },
            ]}
          />
        }
      />
      <Outlet />
    </div>
  );
}
