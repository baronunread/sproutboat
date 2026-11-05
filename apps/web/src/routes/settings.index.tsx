import { DescriptionList, SegmentedControl } from "@sproutboat/ikada";
import { createFileRoute } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { DeleteAccount } from "../account";
import { useAccount } from "../dashboard-data";
import { Section } from "../page-state";
import { isTheme, setTheme, subscribeTheme, themePref, themePrefOnServer } from "../theme-store";

export const Route = createFileRoute("/settings/")({ component: General });

const THEMES = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

function General() {
  const { account } = useAccount();
  // The same store the account menu in the shell reads, so a change here updates it and vice versa.
  const theme = useSyncExternalStore(subscribeTheme, themePref, themePrefOnServer);
  const username = account?.profile?.username;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <Section
        title="Appearance"
        description="Choose the workspace appearance that works best for your environment. This preference stays on this browser."
      >
        <SegmentedControl
          aria-label="Theme"
          className="max-w-sm"
          options={THEMES}
          value={theme}
          onValueChange={(next) => {
            if (isTheme(next)) setTheme(next);
          }}
        />
      </Section>
      <Section title="Account">
        <DescriptionList
          items={[
            { id: "namespace", term: "Namespace", details: username ?? "Not assigned", mono: Boolean(username) },
            { id: "name", term: "Name", details: account?.user?.name ?? "Not set" },
            { id: "email", term: "Email", details: account?.user?.email ?? "Not set" },
            { id: "role", term: "Role", details: account?.isAdmin ? "Admin" : "Member" },
          ]}
        />
      </Section>
      <DeleteAccount username={username} />
    </div>
  );
}
