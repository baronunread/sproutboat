/**
 * A stand-in for sproutd's control adapter (sproutd repo, deploy/adapter) that keeps apps in memory and
 * speaks the same HTTP API over a unix socket, so control's client, reconcile and deploy flows run for real.
 * It models only what control relies on: versions with their secrets, `rollback` picking the newest entry
 * for a version, hosts, limits, and a pruning knob to simulate sproutd's `versions-keep`.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeVersion = {
  id: string;
  uploadedAt: number;
  secrets: string | null;
  active: boolean;
  bytes: Uint8Array;
};
type FailNext = { status: number; body: { error: string } };
export type FakeApp = {
  id: string;
  owner: string;
  project: string;
  versions: FakeVersion[];
  limits: Record<string, number>;
  hosts: string[];
};

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
export const FAKE_TOKEN = "f".repeat(40);

export function startFakeAdapter() {
  const dir = mkdtempSync(join(tmpdir(), "sb-fake-adapter-"));
  const socket = join(dir, "adapter.sock");
  const apps = new Map<string, FakeApp>();
  const calls: string[] = [];
  let failDeploy: FailNext | undefined;
  const idOf = (owner: string, project: string) => `${project}_${sha(owner).slice(0, 12)}`;
  const secretsRef = (secrets: Record<string, string>) =>
    Object.keys(secrets).length ? sha(JSON.stringify(secrets, Object.keys(secrets).sort())).slice(0, 16) : null;
  const view = (app: FakeApp) => {
    const active = app.versions.find((v) => v.active);
    return {
      id: app.id,
      exists: true,
      state: "asleep",
      hosts: app.hosts,
      activeVersion: active?.id ?? null,
      versions: [...app.versions].reverse().map(({ bytes: _bytes, ...v }) => v),
      limits: {
        memoryMb: app.limits.memoryMb ?? 32,
        cpuMs: app.limits.cpuMs ?? 2000,
        wallMs: app.limits.wallMs ?? 30000,
      },
    };
  };

  const server = Bun.serve({
    unix: socket,
    async fetch(request) {
      if (request.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`)
        return Response.json({ error: "unauthorized" }, { status: 401 });
      const url = new URL(request.url);
      const owner = request.headers.get("x-sb-owner") ?? "";
      calls.push(`${request.method} ${url.pathname}${owner ? ` [${owner}]` : ""}`);
      if (url.pathname === "/v1/health") return Response.json({ ok: true, apps: apps.size });
      if (url.pathname === "/v1/apps")
        return Response.json({ apps: [...apps.values()].map((a) => ({ id: a.id, state: "asleep", hosts: a.hosts })) });
      const match = /^\/v1\/projects\/([^/]+)(?:\/([a-z]+))?$/.exec(url.pathname);
      if (!match || !owner) return Response.json({ error: "not found" }, { status: 404 });
      const [, project, action] = match;
      const id = idOf(owner, project);
      const app = apps.get(id);
      if (!action && request.method === "GET") return Response.json(app ? view(app) : { id, exists: false });
      if (!action && request.method === "DELETE") {
        apps.delete(id);
        return Response.json({ id, removed: !!app });
      }
      if (action === "deploy") {
        if (failDeploy) {
          const { status, body } = failDeploy;
          failDeploy = undefined;
          return Response.json(body, { status });
        }
        const form = await request.formData();
        const file = form.get("module");
        if (!(file instanceof File)) return Response.json({ error: "module is required" }, { status: 400 });
        const bytes = new Uint8Array(await file.arrayBuffer());
        const vid = sha(bytes).slice(0, 16);
        const secrets = secretsRef(JSON.parse(String(form.get("secrets") ?? "{}")));
        const limits = JSON.parse(String(form.get("limits") ?? "{}"));
        const next = app ?? { id, owner, project, versions: [], limits: {}, hosts: [] };
        const newest = next.versions[next.versions.length - 1];
        for (const v of next.versions) v.active = false;
        if (!newest || newest.id !== vid || newest.secrets !== secrets)
          next.versions.push({ id: vid, uploadedAt: Date.now(), secrets, active: true, bytes });
        else newest.active = true;
        Object.assign(next.limits, limits);
        apps.set(id, next);
        return Response.json({ id, vid, created: !app });
      }
      if (!app) return Response.json({ error: "unknown app", reason: "unknown-app" }, { status: 404 });
      if (action === "rollback") {
        const body: { vid: string; secrets: Record<string, string> } = await request.json();
        const secrets = secretsRef(body.secrets ?? {});
        const known = [...app.versions].reverse().find((v) => v.id === body.vid);
        if (!known)
          return Response.json({ error: "version is not stored", reason: "unknown-version" }, { status: 404 });
        const via = known.secrets === secrets ? "rollback" : "deploy";
        for (const v of app.versions) v.active = false;
        if (via === "rollback") known.active = true;
        else app.versions.push({ id: known.id, uploadedAt: Date.now(), secrets, active: true, bytes: known.bytes });
        return Response.json({ id, vid: body.vid, via });
      }
      if (action === "secrets") {
        const body: { secrets: Record<string, string> } = await request.json();
        const secrets = secretsRef(body.secrets ?? {});
        const active = app.versions.find((v) => v.active)!;
        if (active.secrets === secrets) return Response.json({ id, changed: false });
        for (const v of app.versions) v.active = false;
        app.versions.push({ id: active.id, uploadedAt: Date.now(), secrets, active: true, bytes: active.bytes });
        return Response.json({ id, changed: true });
      }
      if (action === "hosts") {
        const body: { hosts: string[] } = await request.json();
        app.hosts = body.hosts.toSorted();
        return Response.json({ id, hosts: app.hosts });
      }
      if (action === "limits") {
        Object.assign(app.limits, await request.json());
        return Response.json({ id, ok: true });
      }
      if (action === "logs") return Response.json({ id, lines: ["console: hello"] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  return {
    socket,
    apps,
    calls,
    /** The next deploy is refused, as sproutd does for a module that will not load. */
    failNextDeploy(status: number, error: string) {
      failDeploy = { status, body: { error } };
    },
    idOf,
    /** Forget a version, as sproutd's `versions-keep` would. */
    prune(owner: string, project: string, vid: string) {
      const app = apps.get(idOf(owner, project));
      if (app) app.versions = app.versions.filter((v) => v.id !== vid || v.active);
    },
    stop() {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
