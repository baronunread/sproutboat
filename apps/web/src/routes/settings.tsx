import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
  head: () => ({ meta: [{ title: "Settings · Sproutboat" }] }),
});

const activeProps = { "aria-current": "page" as const };

function SettingsLayout() {
  return (
    <>
      <section className="mb-8 flex items-center justify-between gap-8 border-b border-border pb-7 max-[800px]:mb-10 max-[800px]:flex-col max-[800px]:items-start [&_h1]:m-0 [&_h1]:text-[1.85rem] [&_h1]:font-bold [&_h1]:tracking-[-0.035em] [&_h1]:max-[480px]:text-[1.6rem] [&_p]:mt-1.5 [&_p]:max-w-[38rem] [&_p]:text-[0.875rem] [&_p]:leading-normal [&_p]:text-muted-foreground">
        <div>
          <h1>Settings</h1>
          <p>Your account, the credentials that reach it, and what this box allows.</p>
        </div>
      </section>
      <nav className="mb-6 flex flex-wrap gap-1 border-b border-border" aria-label="Settings sections">
        <Link
          to="/settings"
          activeOptions={{ exact: true }}
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          General
        </Link>
        <Link
          to="/settings/tokens"
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          API tokens
        </Link>
        <Link
          to="/settings/usage"
          activeProps={activeProps}
          className="-mb-px border-b-2 border-transparent px-3 py-2 text-[0.85rem] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:border-brand aria-[current=page]:text-foreground"
        >
          Usage &amp; limits
        </Link>
      </nav>
      <Outlet />
    </>
  );
}
