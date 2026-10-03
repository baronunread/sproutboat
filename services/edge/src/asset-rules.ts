import { matchHeaders, matchRedirect, type AssetManifest } from "@sproutboat/assets";

/**
 * The first `_redirects` rule matching `pathname`, as a ready response (#61).
 * Checked before asset lookup: like Cloudflare Pages, a redirect wins even
 * when a file exists at the path.
 */
export function assetRedirect(manifest: AssetManifest, pathname: string): Response | null {
  for (const rule of manifest.redirects ?? []) {
    const location = matchRedirect(rule, pathname);
    if (location !== null) return new Response(null, { status: rule.status, headers: { location } });
  }
  return null;
}

/**
 * Apply every matching `_headers` block to an asset response's headers, in
 * file order (#61): a rule's value replaces the edge default (a custom
 * `Cache-Control` overrides ours) and a later rule overrides or unsets an
 * earlier one.
 */
export function applyAssetHeaders(headers: Headers, manifest: AssetManifest, pathname: string): Headers {
  for (const rule of matchHeaders(manifest.headers ?? [], pathname)) {
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) headers.set(name, value);
  }
  return headers;
}
