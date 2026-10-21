/** Bun's per-connection idle timeout is a whole number of seconds, at most 255. */
const BUN_IDLE_MAX_SECONDS = 255;

/**
 * The idle timeout for the edge's connections: long enough that the edge's own
 * request deadline always fires first. Bun's default of 10 seconds closed any
 * response slower than that with an empty reply, so a slow sprout gave clients a
 * dropped connection instead of the edge's 504, and the 30-second request timeout
 * never applied. A request timeout beyond Bun's maximum is clamped to it.
 */
export function edgeIdleTimeoutSeconds(requestTimeoutMs: number): number {
  return Math.min(BUN_IDLE_MAX_SECONDS, Math.ceil(requestTimeoutMs / 1000) + 5);
}
