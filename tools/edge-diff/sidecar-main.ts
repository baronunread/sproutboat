/** Harness entry for the Rust edge's sidecar (SPROUTBOAT_SIDECAR_SCRIPT) when a case registers scoped binding credentials. */
import { syncCredentials } from "./credentials-sync";

syncCredentials("sidecar");
await import("../../services/supervisor/src/sidecar");
