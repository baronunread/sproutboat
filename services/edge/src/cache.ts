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
};

/** Seconds a response may be cached, or null if it must not be. */
export function cacheableForSeconds(cacheControl: string | null): number | null {
  if (!cacheControl) return null; // no directive → treat as dynamic, don't cache
  const cc = cacheControl.toLowerCase();
  if (/(^|,)\s*(no-store|private|no-cache)\s*(,|$)/.test(cc)) return null;
  const sMaxAge = /(^|,)\s*s-maxage\s*=\s*(\d+)/.exec(cc);
  const maxAge = /(^|,)\s*max-age\s*=\s*(\d+)/.exec(cc);
  const seconds = Number(sMaxAge?.[2] ?? maxAge?.[2] ?? NaN);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
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
  set(key: string, status: number, headers: [string, string][], body: ArrayBuffer, seconds: number): boolean {
    if (!CACHEABLE_STATUS.has(status) || body.byteLength > this.maxEntryBytes) return false;
    const existing = this.#entries.get(key);
    if (existing) this.#bytes -= existing.body.byteLength;
    this.#entries.set(key, { status, headers, body, expiresAt: this.now() + seconds * 1000 });
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

  get size(): number { return this.#entries.size; }
}
