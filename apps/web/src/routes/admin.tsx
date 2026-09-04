import { createFileRoute, Link, Navigate, Outlet } from "@tanstack/react-router";

import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/admin")({
  component: AdminLayout,
  head: () => ({ meta: [{ title: "Admin · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function AdminLayout() {
  const { account, state } = useAccount();
  if (state === "loading") return null;
  if (!account?.isAdmin) return <Navigate to="/" />;
  return (
    <>
      <section className="mb-8 flex items-center justify-between gap-8 border-b border-border pb-7 max-[800px]:mb-10 max-[800px]:flex-col max-[800px]:items-start [&_h1]:m-0 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&_h1]:max-[480px]:text-[1.6rem] [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.875rem] [&_p]:leading-normal [&_p]:text-muted-foreground">
        <div>
          <h1>Admin</h1>
          <p>Platform-wide status and account administration.</p>
        </div>
      </section>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-border" aria-label="Admin sections">
        <Link
          to="/admin"
          activeOptions={{ exact: true }}
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          Overview
        </Link>
        <Link
          to="/admin/users"
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          Users
        </Link>
        <Link
          to="/admin/backups"
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          Backups
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
