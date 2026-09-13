/**
 * A build-tool content-fingerprint token: one `.`/`-`/`_`-delimited piece of
 * the filename that's 8+ characters and mixes letters with digits -- not a
 * plain word, not a plain number. `index.Ke7awTe2.css`, `main-a1b2c3d4.css`,
 * and webpack's stacked `main.8f3a2b1c.chunk.js` (the hash isn't the last
 * token there, hence checking every token, not just the one before the
 * extension) all have one. This is how Vite, Astro, webpack/CRA, Next, Nuxt,
 * and SvelteKit all fingerprint bundle output, whatever directory or
 * separator convention each one otherwise uses -- the same technique
 * Cloudflare Pages and friends use to auto-detect a cache-forever asset,
 * because it doesn't require knowing which framework or directory layout
 * produced the file at all.
 */
function isFingerprinted(assetKey: string): boolean {
  const filename = assetKey.split("/").pop() ?? "";
  return filename.split(/[.\-_]/).some((token) => token.length >= 8 && /[0-9]/.test(token) && /[A-Za-z]/.test(token));
}

/**
 * `Cache-Control` for an edge-served static asset (the sprout never sees the
 * request -- see main.ts's asset-manifest lookup). Every asset previously got
 * `max-age=0, must-revalidate` regardless of type -- correct (etag-checked
 * every time, never stale) but a real network round trip for every font,
 * script, and stylesheet on every single page load, reload included. Nothing
 * here was ever actually cached in the browser's usual sense, so a font
 * arriving a beat late made already-rendered text pop in visibly once it
 * finally showed up.
 *
 * sproutboat deploys whatever a project's build produces, so this has to
 * work across frameworks, not just Astro -- an earlier version of this
 * checked for a hardcoded, framework-specific directory name (`_astro/`),
 * which meant Vite, webpack, and everything else got no benefit at all.
 * Matching the filename's own fingerprint instead (see above) works the same
 * way regardless of framework: the URL changes whenever the content does, so
 * there's nothing to ever revalidate -- safe to cache for a year as
 * `immutable`.
 *
 * Everything else (fonts, favicon, OG images, and any other asset with a
 * plain, human-chosen name) keeps a stable URL across deploys, so a long
 * `immutable` cache risks serving genuinely stale content after a redeploy
 * changes it; a day still removes the round trip for every reload within
 * that window (the common case) while bounding staleness to something that
 * heals itself quickly.
 */
export function cacheControlFor(assetKey: string): string {
  if (isFingerprinted(assetKey)) return "public, max-age=31536000, immutable";
  return "public, max-age=86400";
}
