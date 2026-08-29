import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { Shell } from "../components";

export const Route = createFileRoute("/operator")({
  beforeLoad: ({ context }: { context: { account?: { isOperator?: boolean } } }) => {
    if (!context.account?.isOperator) throw redirect({ to: "/" });
  },
  component: OperatorLayout,
  head: () => ({ meta: [{ title: "Operator · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function OperatorLayout() {
  return (
    <Shell>
      <section className="page-heading">
        <div><h1>Operator</h1><p>Platform-wide status and account administration.</p></div>
      </section>
      <nav className="section-nav" aria-label="Operator sections">
        <Link to="/operator" activeOptions={{ exact: true }} activeProps={activeProps} className="section-tab">Overview</Link>
        <Link to="/operator/users" activeProps={activeProps} className="section-tab">Users</Link>
      </nav>
      <Outlet />
    </Shell>
  );
}
