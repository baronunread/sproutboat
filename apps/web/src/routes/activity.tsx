import { PageHeader } from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { ActivityFeed } from "../activity-feed";

export const Route = createFileRoute("/activity")({
  component: ActivityPage,
  head: () => ({ meta: [{ title: "Activity · Sproutboat" }] }),
});

function ActivityPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Activity"
        description="What changed on this box: deploys, secrets, domains, tokens and backups, newest first."
      />
      <ActivityFeed />
    </div>
  );
}
