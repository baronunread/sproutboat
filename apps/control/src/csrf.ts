/**
 * Cross-site request gate for cookie-authenticated, state-changing requests.
 *
 * A browser attaches the session cookie to any request the page makes, so a
 * request that carries a cookie and no explicit credential header must come
 * from our own dashboard. Callers using `x-api-key` or `authorization` are
 * exempt: a browser cannot add those cross-site without a CORS preflight, and
 * control never answers one.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const refuse = (error: string, status: number): Response => Response.json({ error }, { status });

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/** Origins the dashboard is served from: its configured URLs plus the request's own Host. */
export function allowedOriginsFor(request: Request): string[] {
  const origins = [
    originOf(process.env.SPROUTBOAT_DASHBOARD_URL || "https://dashboard.sproutboat.com"),
    originOf(process.env.BETTER_AUTH_URL),
  ];
  const host = request.headers.get("host");
  if (host) origins.push(`https://${host}`, `http://${host}`);
  return origins.filter((origin): origin is string => Boolean(origin));
}

function hasBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  if (length !== null) return length.trim() !== "0";
  return request.headers.has("transfer-encoding") || request.body !== null;
}

/** @returns a 403/415 response to send back, or null to proceed. */
export function rejectCrossSite(request: Request, allowedOrigins: string[]): Response | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const headers = request.headers;
  if (!headers.get("cookie")) return null;
  if (headers.has("x-api-key") || headers.has("authorization")) return null;

  const site = headers.get("sec-fetch-site");
  if (site !== null) {
    if (site !== "same-origin" && site !== "none") return refuse("cross-site request refused", 403);
  } else {
    const origin = headers.get("origin");
    if (origin !== null && !allowedOrigins.includes(origin)) return refuse("cross-site request refused", 403);
  }

  if (hasBody(request)) {
    const type = (headers.get("content-type") || "").trim().toLowerCase();
    if (!type || type.startsWith("text/plain") || type.startsWith("application/x-www-form-urlencoded"))
      return refuse("expected application/json", 415);
  }
  return null;
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via"];

/** True when the request carries any header a reverse proxy adds. */
export function viaProxy(request: Request): boolean {
  return PROXY_HEADERS.some((name) => request.headers.has(name));
}
