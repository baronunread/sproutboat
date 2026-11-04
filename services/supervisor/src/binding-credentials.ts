/**
 * Who may vouch for a service-binding call at the edge (#48).
 *
 * A broker that calls services sends a credential in `x-sb-edge-secret`. A scoped credential
 * is good only for the hostnames in its own broker's `services` map and is dropped when that
 * broker exits (the contract of #339). It is kept by hash, so a lookup compares nothing secret.
 *
 * `acceptBindingCall` is the one question both edges ask (the Bun edge in process, the Rust
 * edge through the sidecar's `/verify-binding-call`). Until the supervisor registers per-broker
 * credentials it also accepts the edge-wide secret, exactly as before; when #339 lands its
 * `verifyBindingCall` replaces the body of this function and the legacy branch goes.
 */
import { createHash } from "node:crypto";
import { isEdgeSecret } from "./run";

const scoped = new Map<string, ReadonlySet<string>>();
const keyOf = (credential: string): string => createHash("sha256").update(credential).digest("hex");

/** A Host header value as the edge routes on it: port stripped, lower case. */
export const hostOnly = (host: string): string => host.split(":")[0]!.toLowerCase();

/** Make `credential` valid for `hosts` until the returned function is called. */
export function registerBindingCredential(credential: string, hosts: Iterable<string>): () => void {
  const key = keyOf(credential);
  scoped.set(key, new Set([...hosts].map(hostOnly)));
  return () => void scoped.delete(key);
}

/** Whether `credential` is a live scoped credential allowed to call `host`. */
export function verifyScopedCredential(credential: string | null, host: string): boolean {
  if (!credential) return false;
  return scoped.get(keyOf(credential))?.has(hostOnly(host)) ?? false;
}

/** A scoped credential for `host`, or the edge-wide secret. */
export function acceptBindingCall(credential: string | null, host: string): boolean {
  return verifyScopedCredential(credential, host) || isEdgeSecret(credential);
}
