/**
 * The sidecar the Rust edge talks to: spawned for real over a unix socket with a stand-in
 * sprout (a tiny Bun script, like tests/tail.e2e.test.ts), so the JSON API, the pool and
 * the shutdown path are all exercised.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SPROUT = `#!/usr/bin/env bun
import { createServer } from "node:http";
createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("stand-in " + req.url);
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

let dir: string;
let socket: string;
let child: Bun.Subprocess<"pipe", "pipe", "inherit">;
let sproutPath: string;

type Body = null | boolean | number | string | Body[] | { readonly [key: string]: Body };

/** The sidecar's JSON replies: an Endpoint, PoolStats, {ok} or {error}. */
interface ReplyBody {
  readonly coldStart?: boolean;
  readonly url?: string;
  readonly error?: string;
  readonly ok?: boolean;
  readonly live?: number;
  readonly spawns?: number;
}

const call = async (method: string, path: string, body?: Body): Promise<{ status: number; json: ReplyBody }> => {
  const response = await fetch(`http://sidecar${path}`, {
    method,
    unix: socket,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: ReplyBody = await response.json();
  return { status: response.status, json };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "sb-sidecar-"));
  socket = join(dir, "s.sock");
  await mkdir(join(dir, "art"), { recursive: true });
  sproutPath = join(dir, "art", "sprout");
  await writeFile(sproutPath, SPROUT);
  await chmod(sproutPath, 0o755);
  child = Bun.spawn(["bun", join(import.meta.dir, "sidecar.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: {
      ...process.env,
      SPROUTBOAT_SIDECAR_SOCKET: socket,
      SPROUTBOAT_SIDECAR_EXIT_ON_STDIN_EOF: "1",
      SPROUTBOAT_SPROUT_SANDBOX: "none",
      SPROUTBOAT_UNSAFE_NO_SANDBOX: "1",
      SPROUTBOAT_BROKER_STATE_DIR: join(dir, "brokers"),
    },
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("sidecar ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`sidecar exited early: ${seen}`);
    seen += decoder.decode(value);
  }
});

afterAll(async () => {
  child.kill();
  await rm(dir, { recursive: true, force: true });
});

test("endpoint spawns the sprout once, then answers warm; the url serves requests", async () => {
  const first = await call("POST", "/endpoint", { sproutPath, secretsPath: null, services: null, r2: null });
  expect(first.status).toBe(200);
  expect(first.json.coldStart).toBe(true);
  expect(first.json.url).toBeString();
  expect(await (await fetch(`${first.json.url}/hello`)).text()).toBe("stand-in /hello");
  const second = await call("POST", "/endpoint", { sproutPath });
  expect(second.json.coldStart).toBe(false);
  expect(second.json.url).toBe(first.json.url);
  expect((await call("POST", "/touch", { sproutPath })).status).toBe(200);
  const stats = await call("GET", "/stats");
  expect(stats.json).toMatchObject({ live: 1, spawns: 1 });
});

test("an endpoint that cannot start is a 500 with the message", async () => {
  const bad = await call("POST", "/endpoint", { sproutPath: join(dir, "missing", "sprout") });
  expect(bad.status).toBe(500);
  expect(bad.json.error).toBeString();
  expect((await call("POST", "/endpoint", {})).status).toBe(500);
});

test("verify-binding-call rejects anything it was not given", async () => {
  expect((await call("POST", "/verify-binding-call", { credential: "nope", host: "a.test" })).json).toEqual({
    ok: false,
  });
  expect((await call("POST", "/verify-binding-call", {})).json).toEqual({ ok: false });
});

test("reconcile answers at once; dispose and dispose-all stop sprouts", async () => {
  expect((await call("POST", "/reconcile", [])).json).toEqual({ ok: true });
  expect((await call("POST", "/dispose", { sproutPath })).json).toEqual({ ok: true });
  expect((await call("GET", "/stats")).json).toMatchObject({ live: 0 });
  await call("POST", "/endpoint", { sproutPath });
  expect((await call("GET", "/stats")).json).toMatchObject({ live: 1 });
  expect((await call("POST", "/dispose-all")).json).toEqual({ ok: true });
  expect((await call("GET", "/stats")).json).toMatchObject({ live: 0 });
  expect((await call("POST", "/nope")).status).toBe(404);
});

test("closing stdin (the edge died) disposes everything and exits", async () => {
  child.stdin.end();
  await Promise.race([child.exited, Bun.sleep(5000)]);
  expect(child.exitCode).toBe(0);
  expect(existsSync(socket)).toBe(false);
});
