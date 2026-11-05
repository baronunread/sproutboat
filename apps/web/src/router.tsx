import { EmptyState, Link } from "@sproutboat/ikada";
import { createRouter, Link as RouterLink } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Router-level fallback for any unmatched route, including a `notFound()`
 * thrown from a loader. Without it TanStack renders its own bare
 * `<p>Not Found</p>` and warns on every miss.
 */
function NotFound() {
  return (
    <div className="rounded-xl bg-surface p-4 shadow-card">
      <EmptyState
        title="Not found"
        description="That page does not exist, or the project it belonged to has been deleted."
        action={<Link render={<RouterLink to="/" />}>Back to overview</Link>}
      />
    </div>
  );
}

export function getRouter() {
  return createRouter({
    routeTree,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
