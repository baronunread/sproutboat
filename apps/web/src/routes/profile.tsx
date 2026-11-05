import { Avatar, DescriptionList, Link, PageHeader } from "@sproutboat/ikada";
import { createFileRoute, Link as RouterLink } from "@tanstack/react-router";
import { useAccount } from "../dashboard-data";

export const Route = createFileRoute("/profile")({
  component: Profile,
  head: () => ({ meta: [{ title: "Profile · Sproutboat" }] }),
});

/** A read-only account card. Namespaces are assigned when an account is created, so there is nothing to edit here. */
function Profile() {
  const { account } = useAccount();
  const username = account?.profile?.username;
  const name = username || account?.user?.name || "account";
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <PageHeader title="Profile" description="Your deployment namespace is used in every project route." />
      <section aria-label="Account" className="flex flex-col gap-5 rounded-xl bg-surface p-5 shadow-card sm:p-6">
        <div className="flex items-center gap-4">
          <Avatar name={name} src={account?.user?.image} size="lg" />
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold">{name}</h2>
            {account?.user?.email ? <p className="truncate text-base text-fg-muted">{account.user.email}</p> : null}
          </div>
        </div>
        <DescriptionList
          items={[
            { id: "namespace", term: "Namespace", details: username ?? "Not assigned", mono: Boolean(username) },
            { id: "name", term: "Name", details: account?.user?.name ?? "Not set" },
            { id: "email", term: "Email", details: account?.user?.email ?? "Not set" },
            { id: "role", term: "Role", details: account?.isAdmin ? "Admin" : "Member" },
          ]}
        />
        <p className="text-sm text-fg-muted">Namespace changes are unavailable while deployments exist.</p>
      </section>
      <p>
        <Link render={<RouterLink to="/settings" />}>Appearance and account settings</Link>
      </p>
    </div>
  );
}
