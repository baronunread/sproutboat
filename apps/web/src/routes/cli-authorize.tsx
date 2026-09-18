import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, SproutboatMark, StatusMessage } from "../components";
import { useAccount } from "../dashboard-data";
import { buttonVariants } from "@/components/ui/button";

export const Route = createFileRoute("/cli-authorize")({
  component: CliAuthorize,
  head: () => ({ meta: [{ title: "Connect the CLI · Sproutboat" }] }),
});

/**
 * What `sproutboat login`'s device flow opens instead of dropping the visitor
 * straight onto the dashboard with an "approve" button bolted on. That gave
 * no explanation of what approving grants, and never showed the code back to
 * the person clicking it — nothing to compare against the terminal's "Confirm
 * code: XXXX-XXXX", so a link to someone else's pending login looked exactly
 * like your own.
 */
function CliAuthorize() {
  const { account, state } = useAccount();
  const code = import.meta.env.SSR ? null : new URLSearchParams(location.search).get("cli_code");
  const [outcome, setOutcome] = useState<"pending" | "approved" | "error">("pending");
  const [busy, setBusy] = useState(false);
  const hasNamespace = Boolean(account?.profile?.username);

  async function approve() {
    if (!code || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/cli/authorizations/${encodeURIComponent(code)}/approve`, {
        method: "POST",
        credentials: "include",
      });
      setOutcome(response.ok ? "approved" : "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="content" className="grid min-h-screen place-items-center p-8">
      <Link
        className="absolute top-6 left-6 inline-flex items-center gap-2.5 text-2xl font-[650] tracking-tight no-underline"
        to="/"
      >
        <SproutboatMark />
        <span className="-translate-y-0.5">Sproutboat</span>
      </Link>
      <section className="w-full max-w-[27rem] rounded-xl border border-border bg-card p-8 [&>h1]:m-0 [&>h1]:text-[1.6rem] [&>h1]:leading-tight [&>h1]:font-bold [&>h1]:tracking-[-0.03em] [&>p]:mt-3 [&>p]:text-[0.875rem] [&>p]:leading-relaxed [&>p]:text-muted-foreground">
        {!code ? (
          <>
            <h1>Nothing to approve</h1>
            <p>This page connects a CLI login to your account, but the link is missing its request code.</p>
          </>
        ) : outcome === "approved" ? (
          <>
            <h1>Connected</h1>
            <p>The CLI has its token. Close this tab and go back to your terminal.</p>
          </>
        ) : (
          <>
            <h1>Connect the Sproutboat CLI</h1>
            <p>
              A CLI on your machine is asking for a token with the same access as signing in yourself: it can deploy,
              inspect, and delete every project on this account, until you revoke it from Settings → Tokens.
            </p>
            <p className="mt-5 rounded-lg border border-border bg-background px-4 py-3 text-center font-mono text-[1.1rem] tracking-[0.08em] text-foreground">
              {code}
            </p>
            <p className="text-[0.8rem]">
              Only approve if this matches the confirm code your terminal printed — anyone with this link can see it
              too.
            </p>
            {state === "authed" && !hasNamespace ? (
              <>
                <p className="text-[0.8rem]">Claim a namespace before connecting a CLI to this account.</p>
                <Link className={buttonVariants({ variant: "default", className: "mt-3" })} to="/profile">
                  Set up profile
                </Link>
              </>
            ) : state === "authed" ? (
              <>
                <p className="text-[0.8rem]">
                  Approving as{" "}
                  <strong className="text-foreground">{account?.profile?.username ?? account?.user?.email}</strong>.
                </p>
                <div className="mt-5 flex flex-wrap gap-2.5">
                  <Button variant="primary" busy={busy} busyLabel="Approving…" onClick={() => void approve()}>
                    Approve
                  </Button>
                  <Link className={buttonVariants({ variant: "outline" })} to="/">
                    Cancel
                  </Link>
                </div>
                {outcome === "error" && (
                  <StatusMessage tone="error">
                    Could not approve — the request may have expired. Run `sproutboat login` again.
                  </StatusMessage>
                )}
              </>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
