/**
 * #38: a small in-memory edge response cache. One process, one node — not a
 * shared/distributed cache. Only GET responses the sprout explicitly marks
 * cacheable (`Cache-Control: max-age` / `s-maxage`) are stored, bounded by an
 * entry count and a total-byte cap, evicted oldest-first.
 *
 * ponytail: FIFO eviction and a flat Map. Swap for an LRU + per-route quotas
 * when one node caches for many hundreds of busy deployments.
 */

export type CacheStatus = "HIT" | "MISS" | "BYPASS" | "DYNAMIC";

export type CachedResponse = {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
  expiresAt: number;
  storedAt: number;
  ageAtStore: number;
};

/**
 * The deliberately small shared-cache policy used by the edge. It is not a
 * general HTTP cache: only anonymous GETs without a request revalidation
 * directive may read or fill it. Cookie-bearing traffic is a product-policy
 * bypass even when a particular response could technically be shared.
 */
export function cacheRequestEligible(request: Request): boolean {
  if (request.method !== "GET") return false;
  if (request.headers.has("authorization") || request.headers.has("cookie")) return false;
  // We do not implement request directives, validators, or ranges. Bypass all
  // of them rather than partly interpreting an RFC 9111 request.
  return ![
    "cache-control",
    "pragma",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "if-unmodified-since",
    "range",
  ].some((name) => request.headers.has(name));
}

/** Seconds a response may be cached, or null if it must not be. */
export function cacheableForSeconds(cacheControl: string | null): number | null {
  if (!cacheControl) return null; // no directive → treat as dynamic, don't cache
  const cc = cacheControl.toLowerCase();
  if (/(^|,)\s*(no-store|private|no-cache)(?:\s*=\s*(?:\"[^\"]*\"|[^,]+))?\s*(,|$)/.test(cc)) return null;
  const directive = (name: string): number | null | undefined => {
    const values = [...cc.matchAll(new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,]+)\\s*(?=,|$)`, "g"))];
    if (values.length === 0) return undefined;
    if (values.length !== 1 || !/^\d+$/.test(values[0]![1]!)) return null;
    return Number(values[0]![1]);
  };
  const sMaxAge = directive("s-maxage");
  const maxAge = directive("max-age");
  if (sMaxAge === null || maxAge === null) return null;
  const seconds = sMaxAge ?? maxAge ?? NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** A response must opt into our narrow shared-cache subset explicitly. */
export function cacheResponseEligible(
  headers: Headers,
  now = Date.now(),
): { expiresAt: number; responseDateMs: number } | null {
  const control = headers.get("cache-control");
  if (!control || !/(^|,)\s*public\s*(?:,|$)/i.test(control)) return null;
  // We do not key variants yet. A Vary field therefore always bypasses rather
  // than risking a representation being served to the wrong request.
  if (headers.has("vary") || headers.has("set-cookie") || headers.has("age")) return null;
  const seconds = cacheableForSeconds(control);
  if (seconds === null) return null;
  const date = headers.get("date");
  const dateMs = date ? Date.parse(date) : now;
  if (!Number.isFinite(dateMs) || dateMs > now) return null;
  const expiresAt = dateMs + seconds * 1000;
  return now < expiresAt ? { expiresAt, responseDateMs: dateMs } : null;
}

const CACHEABLE_STATUS = new Set([200, 203, 301, 404, 410]);

export class EdgeCache {
  #entries = new Map<string, CachedResponse>();
  #bytes = 0;

  constructor(
    private readonly maxEntries = 500,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxEntryBytes = 512 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  static key(host: string, method: string, path: string): string {
    return `${method} ${host} ${path}`;
  }

  get(key: string): CachedResponse | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.#entries.delete(key);
      this.#bytes -= hit.body.byteLength;
      return undefined;
    }
    return hit;
  }

  /** Store if the status is cacheable and the body fits one entry. Returns stored?. */
  set(
    key: string,
    status: number,
    headers: [string, string][],
    body: ArrayBuffer,
    seconds: number,
    ageAtStore = 0,
    expiresAt = this.now() + seconds * 1000,
  ): boolean {
    if (!CACHEABLE_STATUS.has(status) || body.byteLength > this.maxEntryBytes) return false;
    const existing = this.#entries.get(key);
    if (existing) this.#bytes -= existing.body.byteLength;
    const storedAt = this.now();
    this.#entries.set(key, { status, headers, body, expiresAt, storedAt, ageAtStore });
    this.#bytes += body.byteLength;
    while (this.#entries.size > this.maxEntries || this.#bytes > this.maxBytes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#bytes -= this.#entries.get(oldest)!.body.byteLength;
      this.#entries.delete(oldest);
    }
    return true;
  }

  /** Drop every entry for one host — called when its deployment changes. */
  purgeHost(host: string): void {
    for (const key of this.#entries.keys()) {
      if (key.split(" ")[1] === host) {
        this.#bytes -= this.#entries.get(key)!.body.byteLength;
        this.#entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
