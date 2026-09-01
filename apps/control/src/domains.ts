/**
 * #2 — custom domains per project. A project is always reachable at its
 * generated `<project>.<user>.<domain>`; this lets the owner also attach their
 * own hostname.
 *
 * Flow (Cloudflare's zone-attach model): claim a hostname -> add the TXT record
 * we hand back -> call verify. Control resolves `_sproutboat.<hostname>` TXT and,
 * on a token match, marks it verified and rewrites the route snapshot. From then
 * the edge serves that hostname from whatever version of the project is active,
 * and Caddy's `on_demand_tls` ask endpoint (`/internal/tls/allow`) will issue a
 * cert for it because it now appears in the snapshot.
 */
import { resolveTxt } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { actorFor, type Actor } from "./identity";
import { LIMITS } from "./limits";
import { deploymentDomain } from "./deployments";
import {
  addCustomDomain,
  customDomainByHostname,
  deleteCustomDomain,
  markCustomDomainVerified,
  projectCustomDomains,
  projectDeployments,
  syncRoutes,
} from "./store";

type JsonInput = string | number | boolean | null | undefined | JsonInput[] | { readonly [key: string]: JsonInput };
const asText = (value: JsonInput): string =>
  Object(value) !== value && value === String(value) ? String(value).trim() : "";

const TXT_PREFIX = "sproutboat-verify=";
const txtName = (hostname: string) => `_sproutboat.${hostname}`;

// Lowercase FQDN, 2+ labels, each label 1-63 chars, TLD starts with a letter.
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

async function authorized(request: Request): Promise<Actor | Response> {
  try {
    const actor = await actorFor(request);
    return actor || Response.json({ error: "sign in and reserve a username before using this endpoint" }, { status: 401 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "authentication is unavailable" }, { status: 503 });
  }
}

const publicView = (domain: { hostname: string; verifiedAt: string | null; token: string; createdAt: string }) => ({
  hostname: domain.hostname,
  verified: domain.verifiedAt !== null,
  verifiedAt: domain.verifiedAt,
  createdAt: domain.createdAt,
  verification: domain.verifiedAt !== null ? null : { type: "TXT", name: txtName(domain.hostname), value: `${TXT_PREFIX}${domain.token}` },
});

export async function listDomains(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  return Response.json(projectCustomDomains(actor.id, project).map(publicView));
}

export async function addDomain(request: Request, project: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  if (projectDeployments(actor.id, project).length === 0) {
    return Response.json({ error: "deploy the project at least once before attaching a domain" }, { status: 409 });
  }

  const body: { readonly [key: string]: JsonInput } = await request.json().catch(() => ({}));
  const hostname = asText(body.hostname).toLowerCase();

  if (!HOSTNAME.test(hostname)) return Response.json({ error: "hostname must be a valid lowercase FQDN" }, { status: 400 });
  if (hostname === deploymentDomain() || hostname.endsWith(`.${deploymentDomain()}`)) {
    return Response.json({ error: `${deploymentDomain()} hostnames are managed by the platform` }, { status: 400 });
  }
  const existing = customDomainByHostname(hostname);
  if (existing) {
    const mine = existing.ownerId === actor.id && existing.project === project;
    return Response.json({ error: mine ? "this project already has that domain" : "that hostname is already claimed" }, { status: 409 });
  }
  if (projectCustomDomains(actor.id, project).length >= LIMITS.domainsPerProject()) {
    return Response.json({ error: `a project may hold at most ${LIMITS.domainsPerProject()} custom domains` }, { status: 429 });
  }

  const token = randomUUID().replace(/-/g, "");
  const created = addCustomDomain({ hostname, ownerId: actor.id, project, token });
  if (!created) return Response.json({ error: "that hostname is already claimed" }, { status: 409 });
  return Response.json(publicView(created), { status: 201 });
}

export async function verifyDomain(request: Request, project: string, hostname: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;

  const domain = projectCustomDomains(actor.id, project).find((entry) => entry.hostname === hostname.toLowerCase());
  if (!domain) return Response.json({ error: "domain not found" }, { status: 404 });
  if (domain.verifiedAt !== null) return Response.json(publicView(domain));

  const want = `${TXT_PREFIX}${domain.token}`;
  let records: string[][];
  try { records = await resolveTxt(txtName(domain.hostname)); }
  catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const detail = code === "ENOTFOUND" || code === "ENODATA" ? "no TXT record found" : "TXT lookup failed";
    return Response.json({ error: detail, expected: { type: "TXT", name: txtName(domain.hostname), value: want } }, { status: 400 });
  }
  const found = records.some((chunks) => chunks.join("").trim() === want);
  if (!found) {
    return Response.json({ error: "TXT record does not match", expected: { type: "TXT", name: txtName(domain.hostname), value: want } }, { status: 400 });
  }

  markCustomDomainVerified(actor.id, project, domain.hostname);
  await syncRoutes();
  return Response.json({ ...publicView(domain), verified: true, verifiedAt: new Date().toISOString(), verification: null });
}

export async function deleteDomain(request: Request, project: string, hostname: string): Promise<Response> {
  const actor = await authorized(request);
  if (actor instanceof Response) return actor;
  const removed = deleteCustomDomain(actor.id, project, hostname.toLowerCase());
  if (!removed) return Response.json({ error: "domain not found" }, { status: 404 });
  await syncRoutes();
  return Response.json({ deleted: hostname.toLowerCase() });
}
