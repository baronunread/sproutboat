import { Banner, Button, buttonStyles } from "@sproutboat/ikada";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useAccount } from "../dashboard-data";
import { SproutboatMark } from "../shell";

export const Route = createFileRoute("/cli-authorize")({
  component: CliAuthorize,
  head: () => ({ meta: [{ title: "Connect the CLI · Sproutboat" }] }),
});

/**
 * What `sproutboat login`'s device flow opens instead of dropping the visitor
 * straight onto the dashboard with an "approve" button bolted on. That gave
 * no explanation of what approving grants, and never showed the code back to
 * the person clicking it: nothing to compare against the terminal's "Confirm
 * code: XXXX-XXXX", so a link to someone else's pending login looked exactly
 * like your own.
 */
function CliAuthorize() {
  const { account, state } = useAccount();
  const code = import.meta.env.SSR ? null : new URLSearchParams(location.search).get("cli_code");
  const [outcome, setOutcome] = useState<"pending" | "approved" | "error">("pending");
  const [busy, setBusy] = useState(false);

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
    <main id="content" className="flex min-h-dvh flex-col items-center justify-center gap-6 p-5 sm:p-8">
      <Link
        to="/"
        className="inline-flex items-center gap-2.5 rounded-md text-xl font-bold outline-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <SproutboatMark />
        <span>Sproutboat</span>
      </Link>
      <section className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-surface p-6 shadow-card sm:p-8">
        {!code ? (
          <>
            <h1 className="text-xl font-bold">Nothing to approve</h1>
            <p className="text-base text-fg-muted">
              This page connects a CLI login to your account, but the link is missing its request code.
            </p>
          </>
        ) : outcome === "approved" ? (
          <>
            <h1 className="text-xl font-bold">Connected</h1>
            <p className="text-base text-fg-muted">
              The CLI has its token. Close this tab and go back to your terminal.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">Connect the Sproutboat CLI</h1>
            <p className="text-base text-fg-muted">
              A CLI on your machine is asking for a token with the same access as signing in yourself: it can deploy,
              inspect, and delete every project on this account, until you revoke it from Settings, Tokens.
            </p>
            <p className="rounded-lg bg-code-bg px-4 py-3 text-center font-mono text-lg tracking-widest break-all text-fg">
              <span className="sr-only">Confirm code: </span>
              {code}
            </p>
            <p className="text-sm text-fg-muted">
              Only approve if this matches the confirm code your terminal printed. Anyone with this link can see it too.
            </p>
            {state === "authed" ? (
              <>
                <p className="text-sm text-fg-muted">
                  Approving as <strong className="text-fg">{account?.profile?.username ?? account?.user?.email}</strong>
                  .
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <Button variant="primary" loading={busy} onClick={() => void approve()}>
                    Approve
                  </Button>
                  <Link to="/" className={buttonStyles({ variant: "secondary" })}>
                    Cancel
                  </Link>
                </div>
                {outcome === "error" && (
                  <Banner tone="danger">
                    Could not approve. The request may have expired: run `sproutboat login` again.
                  </Banner>
                )}
              </>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
