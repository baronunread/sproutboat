/** Harness entry for the Bun edge when a case registers scoped binding credentials. */
import { syncCredentials } from "./credentials-sync";

syncCredentials("bun");
await import("../../services/edge/src/main");
