import { createRouter, Link } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * Router-level fallback for any unmatched route, including a `notFound()`
 * thrown from a loader. Without it TanStack renders its own bare
 * `<p>Not Found</p>` and warns on every miss.
 */
function NotFound() {
  return (
    <section className="data-panel settings-panel">
      <div className="panel-heading">
        <div>
          <h2>Not found</h2>
          <p>That page does not exist, or the project it belonged to has been deleted.</p>
        </div>
      </div>
      <p className="hint">
        <Link className="text-link" to="/">Back to overview</Link>
      </p>
    </section>
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
  interface Register { router: ReturnType<typeof getRouter>; }
}
