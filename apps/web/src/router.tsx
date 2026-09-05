import { createRouter, Link } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { Panel, PanelHeading } from "./components";

/**
 * Router-level fallback for any unmatched route, including a `notFound()`
 * thrown from a loader. Without it TanStack renders its own bare
 * `<p>Not Found</p>` and warns on every miss.
 */
function NotFound() {
  return (
    <Panel>
      <PanelHeading
        title="Not found"
        description="That page does not exist, or the project it belonged to has been deleted."
      />
      <p className="mt-3 text-[0.75rem] text-muted-foreground">
        <Link className="text-[0.8rem] text-sky underline-offset-2 hover:underline" to="/">
          Back to overview
        </Link>
      </p>
    </Panel>
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
