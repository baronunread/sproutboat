/**
 * Live tail, end to end, without portless or a browser: the real control plane
 * and the real edge (with its supervisor) run as subprocesses over one temp
 * state directory, the edge serves a stand-in sprout that prints console lines
 * and throws the way the runtime does, and the test watches
 * `GET /api/projects/app/tail` (and, when SPROUTBOAT_CLI_MAIN points at a CLI
 * checkout's src/main.ts, `sproutboat tail --format json`) see it happen.
 *
 * The stand-in is a tiny Bun script rather than a Porffor build so this runs
 * anywhere `bun test` does; it reproduces the three things the tail reads: a
 * stdout/stderr stream with no levels, the `Uncaught (in fetch)` marker, and the
 * `x-sb-uncaught` / `x-sb-cpu-ms` response headers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailEvent, TailFrame } from "../apps/control/src/tail";

const OWNER = "alice";
const TOKEN = "tail-e2e-token";
const HOST = "app.alice.sproutboat.localhost";
const DIGEST = "c".repeat(64);

// node:http rather than Bun.serve: Bun adds a content-type to every response, and the runtime's
// answer to a throwing handler has none.
const SPROUT = `#!/usr/bin/env bun
import { createServer } from "node:http";
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
};
createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/log") {
    console.log("hello from the sprout");
    console.log("second line");
    return send(res, 200, "logged", { "content-type": "text/plain", "x-sb-cpu-ms": "1.250" });
  }
  if (path === "/boom") {
    console.error("Uncaught (in fetch) Error: kaboom\\n    at handler (index.js:3:9)\\n    at dispatch (runtime.js:10:1)");
    // What the runtime does for a throwing handler: a bare 500, no content-type.
    return send(res, 500, "Internal Server Error");
  }
  if (path === "/deliberate") return send(res, 500, "Internal Server Error", { "content-type": "text/plain" });
  if (path === "/marker") {
    const marker = encodeURIComponent(JSON.stringify({ name: "Error", message: "callee" }));
    return send(res, 500, "Internal Server Error", { "content-type": "text/plain", "x-sb-uncaught": marker });
  }
  send(res, 200, "ok", { "content-type": "text/plain", "x-sb-cpu-ms": "0.500" });
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

let dir: string;
let controlUrl: string;
let edgeUrl: string;
const children: Bun.Subprocess[] = [];

/** Resolve with the port a child announces, then keep draining its stdout so a full pipe never stalls it. */
function listening(child: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<string> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const decoder = new TextDecoder();
      let seen = "";
      let announced = false;
      for await (const chunk of child.stdout) {
        if (announced) continue;
        seen += decoder.decode(chunk);
        const match = /listening on http:\/\/[\d.]+:(\d+)/.exec(seen);
        if (match) {
          announced = true;
          resolve(match[1]);
        }
      }
      if (!announced) reject(new Error(`process exited before listening: ${seen}`));
    })();
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-tail-e2e-"));
  const env = {
    ...process.env,
    SPROUTBOAT_DATABASE_PATH: join(dir, "control.sqlite"),
    SPROUTBOAT_ROUTE_SNAPSHOT: join(dir, "routes.json"),
    SPROUTBOAT_ARTIFACTS_DIR: join(dir, "artifacts"),
    SPROUTBOAT_DEPLOYMENTS_PATH: join(dir, "deployments.json"),
    SPROUTBOAT_LOG_PATH: join(dir, "logs", "requests.ndjson"),
    SPROUTBOAT_BROKER_STATE_DIR: join(dir, "brokers"),
    SPROUTBOAT_RESOURCE_DIR: join(dir, "resources"),
    SPROUTBOAT_DEPLOYMENT_DOMAIN: "sproutboat.localhost",
    SPROUTBOAT_BOOTSTRAP_TOKEN: TOKEN,
    SPROUTBOAT_BOOTSTRAP_USERNAME: OWNER,
    SPROUTBOAT_EDGE_CACHE: "off",
    SPROUTBOAT_SPROUT_SANDBOX: "none",
    SPROUTBOAT_UNSAFE_NO_SANDBOX: "1",
    BETTER_AUTH_SECRET: "tail-e2e-secret-at-least-thirty-two-characters",
    BETTER_AUTH_URL: "http://127.0.0.1:1",
    PORT: "0",
  };
  await mkdir(join(dir, "logs"), { recursive: true });
  const artifact = join(dir, "artifacts", DIGEST);
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, "sprout"), SPROUT);
  await chmod(join(artifact, "sprout"), 0o755);

  // Record the project through the store module in a child process: the store reads its paths
  // from the environment, and this test process is shared with other test files.
  const record = Bun.spawnSync(
    [
      "bun",
      "-e",
      `const store = await import("./apps/control/src/store");
store.recordDeployment({
  id: "dep-1",
  ownerId: ${JSON.stringify(`bootstrap:${OWNER}`)},
  project: "app",
  username: ${JSON.stringify(OWNER)},
  hostname: ${JSON.stringify(HOST)},
  artifact: ${JSON.stringify(DIGEST)},
  sproutPath: ${JSON.stringify(join(artifact, "sprout"))},
  deployedAt: new Date().toISOString(),
});
store.activateDeployment(${JSON.stringify(`bootstrap:${OWNER}`)}, "app", "dep-1");
await store.syncRoutes();
store.closeStore();`,
    ],
    { cwd: join(import.meta.dir, ".."), env, stderr: "pipe" },
  );
  if (record.exitCode !== 0) throw new Error(`could not record the deployment: ${record.stderr.toString()}`);

  const control = Bun.spawn(["bun", "apps/control/src/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const edge = Bun.spawn(["bun", "services/edge/src/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  children.push(control, edge);
  const [controlPort, edgePort] = await Promise.all([listening(control), listening(edge)]);
  controlUrl = `http://127.0.0.1:${controlPort}`;
  edgeUrl = `http://127.0.0.1:${edgePort}`;
}, 30_000);

afterAll(async () => {
  for (const child of children) child.kill("SIGTERM");
  await Promise.all(children.map((child) => child.exited));
  await rm(dir, { recursive: true, force: true });
});

const hit = (path: string) => fetch(`${edgeUrl}${path}`, { headers: { host: HOST } });

/** Open the tail and collect frames until `done` or the deadline. */
async function watch(
  query: string,
  act: () => Promise<void>,
  done: (frames: TailFrame[]) => boolean,
): Promise<TailFrame[]> {
  const controller = new AbortController();
  const response = await fetch(`${controlUrl}/api/projects/app/tail${query}`, {
    headers: { "x-api-key": TOKEN },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const frames: TailFrame[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const pump = (async () => {
    try {
      for await (const chunk of response.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (block.startsWith("data: ")) frames.push(JSON.parse(block.slice(6)));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  const readyBy = Date.now() + 5000;
  while (!frames.some((frame) => frame.type === "ready") && Date.now() < readyBy) await Bun.sleep(10);
  await act();
  const deadline = Date.now() + 10_000;
  while (!done(frames) && Date.now() < deadline) await Bun.sleep(25);
  controller.abort();
  await pump;
  return frames;
}

const eventsOf = (frames: TailFrame[]): TailEvent[] =>
  frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));
const urlOf = (event: TailEvent) => event.event?.request.url;

async function traffic(): Promise<void> {
  expect((await hit("/ok")).status).toBe(200);
  expect((await hit("/log")).status).toBe(200);
  expect((await hit("/boom")).status).toBe(500);
}

test("rejects missing auth and bad filters before streaming", async () => {
  expect((await fetch(`${controlUrl}/api/projects/app/tail`)).status).toBe(401);
  const bad = await fetch(`${controlUrl}/api/projects/app/tail?status=teapot`, { headers: { "x-api-key": TOKEN } });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ error: expect.stringContaining("status") });
  const rate = await fetch(`${controlUrl}/api/projects/app/tail?sampling-rate=7`, { headers: { "x-api-key": TOKEN } });
  expect(rate.status).toBe(400);
});

test("SSE: requests, console output and a thrown error arrive, in tail shape", async () => {
  const frames = await watch("", traffic, (all) => {
    const events = eventsOf(all);
    return (
      events.some((e) => urlOf(e)?.endsWith("/boom")) &&
      events.some((e) => e.logs.some((log) => log.message[0] === "second line")) &&
      events.some((e) => e.exceptions.length > 0)
    );
  });
  const events = eventsOf(frames);

  const ok = events.find((e) => urlOf(e) === `https://${HOST}/ok`);
  expect(ok).toMatchObject({
    scriptName: "app",
    outcome: "ok",
    event: { request: { method: "GET" }, response: { status: 200 } },
    cpuTime: 0.5,
    logs: [],
    exceptions: [],
  });
  expect(ok?.wallTime).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(ok?.eventTimestamp)).toBe(true);

  const log = events.find((e) => urlOf(e) === `https://${HOST}/log`);
  expect(log?.cpuTime).toBe(1.25);

  const boom = events.find((e) => urlOf(e)?.endsWith("/boom"));
  expect(boom).toMatchObject({ outcome: "exception", event: { response: { status: 500 } } });

  // Console lines: their own events, never attached to a request.
  const consoleEvents = events.filter((e) => e.logs.length > 0);
  expect(consoleEvents.every((e) => e.event === null)).toBe(true);
  expect(consoleEvents.flatMap((e) => e.logs.map((l) => l.message[0]))).toEqual([
    "hello from the sprout",
    "second line",
  ]);
  expect(consoleEvents[0].logs[0].level).toBe("log");

  const thrown = events.find((e) => e.exceptions.length > 0);
  expect(thrown?.outcome).toBe("exception");
  expect(thrown?.event).toBeNull();
  expect(thrown?.exceptions[0]).toMatchObject({ name: "Error", message: "kaboom" });
  expect(thrown?.exceptions[0].stack).toContain("at handler (index.js:3:9)");
  expect(boom?.cpuTime).toBeNull(); // the runtime did not report CPU for this response
}, 30_000);

test("outcome: the runtime's bare 500 and the binding marker are exceptions, a deliberate 500 is not", async () => {
  const frames = await watch(
    "?status=500",
    async () => {
      expect((await hit("/deliberate")).status).toBe(500);
      expect((await hit("/marker")).status).toBe(500);
      expect((await hit("/boom")).status).toBe(500);
    },
    (all) => eventsOf(all).filter((e) => e.event).length >= 3,
  );
  const outcomes = Object.fromEntries(
    eventsOf(frames).flatMap((e) => (e.event ? [[urlOf(e)?.split("/").pop(), e.outcome]] : [])),
  );
  expect(outcomes).toEqual({ deliberate: "ok", marker: "exception", boom: "exception" });
}, 30_000);

test("SSE: server-side filters narrow the stream", async () => {
  const frames = await watch("?status=5xx&method=GET", traffic, (all) =>
    eventsOf(all).some((e) => urlOf(e)?.endsWith("/boom")),
  );
  await Bun.sleep(1500); // give a wrongly passed event time to show up
  const events = eventsOf(frames);
  expect(events.map(urlOf)).toEqual([`https://${HOST}/boom`]);

  const search = await watch("?search=hello%20from", traffic, (all) => eventsOf(all).length > 0);
  await Bun.sleep(1200);
  expect(eventsOf(search).flatMap((e) => e.logs.map((l) => l.message[0]))).toEqual(["hello from the sprout"]);

  const errors = await watch("?outcome=exception", traffic, (all) => eventsOf(all).length >= 2);
  await Bun.sleep(1200);
  expect(eventsOf(errors).every((e) => e.outcome === "exception")).toBe(true);
  expect(eventsOf(errors).length).toBeGreaterThanOrEqual(2); // the /boom request and the exception
}, 30_000);

test.skipIf(!process.env.SPROUTBOAT_CLI_MAIN)(
  "CLI: sproutboat tail --format json sees the same events",
  async () => {
    const project = await mkdtemp(join(tmpdir(), "sb-tail-cli-"));
    try {
      await writeFile(
        join(project, "sproutboat.jsonc"),
        JSON.stringify({ name: "app", main: "src/index.js", compatibility_date: "2026-09-07" }),
      );
      const child = Bun.spawn(
        ["bun", process.env.SPROUTBOAT_CLI_MAIN!, "tail", project, "--format", "json", "--status", "5xx"],
        {
          env: {
            ...process.env,
            SPROUTBOAT_API_URL: controlUrl,
            SPROUTBOAT_TOKEN: TOKEN,
            SPROUTBOAT_NO_UPDATE_CHECK: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const lines: string[] = [];
      const decoder = new TextDecoder();
      let buffer = "";
      const reading = (async () => {
        for await (const chunk of child.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          lines.push(...parts.filter(Boolean));
        }
      })();
      await Bun.sleep(1500); // let the CLI connect before the traffic
      await traffic();
      const deadline = Date.now() + 10_000;
      while (lines.length < 1 && Date.now() < deadline) await Bun.sleep(25);
      child.kill("SIGINT");
      expect(await child.exited).toBe(0);
      await reading;
      const events: TailEvent[] = lines.map((line) => JSON.parse(line));
      expect(events.map(urlOf)).toEqual([`https://${HOST}/boom`]);
      expect(events[0].outcome).toBe("exception");
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  },
  30_000,
);
