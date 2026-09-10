/**
 * The pinned Porffor identity now lives in `@sproutboat/toolchain` — the same
 * pin and patch set the CLI uses, so the two cannot drift. `PORFFOR_VERSION`
 * still overrides for a one-off retest of another build.
 */
export { porfforVersion } from "@sproutboat/toolchain";
