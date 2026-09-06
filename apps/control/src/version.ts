/**
 * The version handshake a CLI reads off every `/api/` response.
 *
 * A CLI and a node update independently — npm on one side, `SB_REF` on the
 * other — so skew is normal, not exceptional. Advertising both numbers lets the
 * CLI say "upgrade" instead of leaving the user with a 400 from a route that
 * moved. Response-only, so an old CLI simply ignores the headers.
 */
import packageJson from "../../../package.json" with { type: "json" };

export const CONTROL_VERSION: string = packageJson.version;

/**
 * The oldest CLI this API is known to work with.
 *
 * Deliberately `0.0.0`: no incompatibility has shipped yet, and every bump
 * warns every user below it. Move it only when an API change actually breaks
 * older CLIs — it is a considered act, not a release chore.
 */
export const MIN_CLI_VERSION = "0.0.0";

/**
 * Stamp the handshake onto an API response.
 *
 * Returns the same response. Non-`/api/` paths are left alone (the dashboard
 * and the Caddy hooks have no use for it), and a response whose headers are
 * immutable — `Response.redirect()` builds one — is passed through untouched
 * rather than throwing on the way out of the server.
 */
export function stampVersion(response: Response, pathname: string): Response {
  if (!pathname.startsWith("/api/")) return response;
  try {
    response.headers.set("x-sproutboat-control", CONTROL_VERSION);
    response.headers.set("x-sproutboat-min-cli", MIN_CLI_VERSION);
  } catch {
    /* immutable headers (Response.redirect) — advertising is best-effort */
  }
  return response;
}
