import { createFileRoute } from "@tanstack/react-router";
import { ActivityFeed } from "../activity-feed";
import { useProject } from "../dashboard-data";

/** The project's own slice of the Activity feed. The layout adds the "Activity" tab that links here. */
export const Route = createFileRoute("/projects_/$name/activity")({ component: ProjectActivity });

function ProjectActivity() {
  const { name } = useProject();
  return <ActivityFeed project={name} />;
}
