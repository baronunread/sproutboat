import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The project log and tail readers must follow every hostname routed to the
// project (verified custom domains included), and only those.
const TOKEN = "bootstrap-token";
const GENERATED = "site.alice.sb.test";
const CUSTOM = "www.acme.test";
const OTHER_OWN = "blog.alice.sb.test";
const STRANGER = "evil.bob.sb.test";
const OWNER = "bootstrap:alice";
let dir: string;
let logFile: string;
let store: typeof import("./store");
let deployments: typeof import("./deployments");
const roots: string[] = [];

const request = (path: string, signal?: AbortSignal) =>
  new Request(`http://control${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal });
const edgeLine = (hostname: string, over: Record<string, string | number | boolean> = {}) =>
  `${JSON.stringify({ at: new Date().toISOString(), hostname, method: "GET", path: "/", status: 200, durationMs: 5, ...over })}\n`;

function deploy(project: string, hostname: string) {
  store.recordDeployment({
    id: `d-${project}`,
    ownerId: OWNER,
    project,
    username: "alice",
    hostname,
    artifact: project.padEnd(64, "0"),
    sproutPath: join(dir, project, "sprout"),
    deployedAt: new Date().toISOString(),
  });
}

async function readSse(
  open: (signal: AbortSignal) => Promise<Response>,
  act: () => Promise<void>,
  enough: (n: number) => boolean,
) {
  const abort = new AbortController();
  const response = await open(abort.signal);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<{ type: string; event?: { path?: string; event?: { request: { url: string } } } }> = [];
  const pump = (async () => {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      buffer += decoder.decode(next.value);
      for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
      }
    }
  })();
  await Bun.sleep(60);
  await act();
  const deadline = Date.now() + 3000;
  while (!enough(frames.filter((f) => f.type === "event").length) && Date.now() < deadline) await Bun.sleep(20);
  abort.abort();
  await reader.cancel();
  await pump;
  return frames.filter((f) => f.type === "event");
}

beforeAll(async () => {
  store = await import("./store");
  deployments = await import("./deployments");
});
afterAll(async () => {
  store.closeStore();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(async () => {
  store.closeStore();
  dir = await mkdtemp(join(tmpdir(), "sb-project-logs-"));
  roots.push(dir);
  logFile = join(dir, "requests.ndjson");
  await writeFile(logFile, "");
  Object.assign(process.env, {
    SPROUTBOAT_DATABASE_PATH: join(dir, "control.sqlite"),
    SPROUTBOAT_ROUTE_SNAPSHOT: join(dir, "routes.json"),
    SPROUTBOAT_ARTIFACTS_DIR: join(dir, "artifacts"),
    SPROUTBOAT_DEPLOYMENTS_PATH: join(dir, "deployments.json"),
    SPROUTBOAT_LOG_PATH: logFile,
    SPROUTBOAT_BOOTSTRAP_TOKEN: TOKEN,
    SPROUTBOAT_BOOTSTRAP_USERNAME: "alice",
    SPROUTBOAT_DEPLOYMENT_DOMAIN: "sb.test",
  });
  deploy("site", GENERATED);
  deploy("blog", OTHER_OWN);
  store.addCustomDomain({ hostname: CUSTOM, ownerId: OWNER, project: "site", token: "t" });
  store.markCustomDomainVerified(OWNER, "site", CUSTOM);
  store.addCustomDomain({ hostname: "pending.acme.test", ownerId: OWNER, project: "site", token: "t2" });
});

const seed = () =>
  writeFile(
    logFile,
    edgeLine(GENERATED, { path: "/generated" }) +
      edgeLine(CUSTOM, { path: "/custom" }) +
      edgeLine(OTHER_OWN, { path: "/blog" }) +
      edgeLine(STRANGER, { path: "/stranger" }) +
      edgeLine("pending.acme.test", { path: "/pending" }),
  );

test("/logs includes custom-domain requests but nothing from other projects", async () => {
  await seed();
  const page = await (await deployments.projectLogHistory(request("/api/projects/site/logs"), "site")).json();
  expect(page.events.map((e: { path: string }) => e.path).sort()).toEqual(["/custom", "/generated"]);
});

test("/logs/recent includes custom-domain requests but nothing from other projects", async () => {
  await seed();
  const text = await (await deployments.projectLogs(request("/api/projects/site/logs/recent"), "site")).text();
  const paths = text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).path)
    .sort();
  expect(paths).toEqual(["/custom", "/generated"]);
});

test("/logs/tail streams custom-domain requests but nothing from other projects", async () => {
  const events = await readSse(
    (signal) => deployments.projectLogTail(request("/api/projects/site/logs/tail", signal), "site"),
    seed,
    (n) => n >= 2,
  );
  // SAFETY: /logs/tail frames carry a LogRecord in `event`, which has a `path`.
  expect(events.map((f) => (f.event as { path: string }).path).sort()).toEqual(["/custom", "/generated"]);
});

test("/tail streams custom-domain requests under their own hostname, nothing from other projects", async () => {
  const events = await readSse(
    (signal) => deployments.projectTail(request("/api/projects/site/tail", signal), "site"),
    seed,
    (n) => n >= 2,
  );
  // SAFETY: /tail frames carry a Workers-shaped TailEvent in `event`.
  const urls = events.map((f) => (f.event as { event: { request: { url: string } } }).event.request.url).sort();
  expect(urls).toEqual([`https://${GENERATED}/generated`, `https://${CUSTOM}/custom`]);
});

test("/metrics counts custom-domain requests too", async () => {
  await seed();
  const metrics = await (await deployments.projectMetrics(request("/api/projects/site/metrics"), "site")).json();
  expect(metrics.buckets.reduce((sum: number, b: { count: number }) => sum + b.count, 0)).toBe(2);
});

test("the dashboard overview counts custom-domain requests toward the project row", async () => {
  await seed();
  const overview = await (await deployments.dashboardOverview(request("/api/overview"))).json();
  const rows = Object.fromEntries(overview.projects.map((p: { name: string; requests24h: number }) => [p.name, p]));
  expect(rows.site.requests24h).toBe(2);
  expect(rows.blog.requests24h).toBe(1);
});
