import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDashboardRequest, serveDashboard } from "./dashboard-static";

let root: string;
let dir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-dash-"));
  dir = join(root, "client");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "_shell.html"), "<html>shell</html>");
  await writeFile(join(dir, "assets", "app-abc123.js"), "console.log(1)");
  await writeFile(join(dir, "favicon.svg"), "<svg/>");
  await writeFile(join(root, "secret.txt"), "top secret");
  await symlink(join(root, "secret.txt"), join(dir, "leak.txt"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const get = (path: string, method = "GET") => serveDashboard(new Request(`http://x${path}`, { method }), dir);

test("serves an existing file with its type; hashed assets are immutable", async () => {
  const res = await get("/assets/app-abc123.js");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/javascript");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await res.text()).toBe("console.log(1)");
  const icon = await get("/favicon.svg");
  expect(icon.headers.get("content-type")).toBe("image/svg+xml");
  expect(icon.headers.get("cache-control")).not.toContain("immutable");
});

test("unknown paths and the root fall back to the shell, uncached", async () => {
  for (const path of ["/", "/projects/foo", "/assets/missing.js"]) {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("<html>shell</html>");
  }
});

test("HEAD has the headers and no body", async () => {
  const res = await get("/favicon.svg", "HEAD");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-length")).toBe("6");
  expect(await res.text()).toBe("");
});

test("traversal and symlink escapes are refused", async () => {
  // The URL parser already folds literal and %2e dot segments; the rest reach the handler.
  for (const path of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
    expect(await (await get(path)).text(), path).not.toContain("top secret");
  }
  for (const path of ["/assets/..%2f..%2fsecret.txt", "/..%2fsecret.txt", "/a%00b", "/a%5c..%5cb"]) {
    expect((await get(path)).status, path).toBe(404);
  }
  const leak = await get("/leak.txt");
  expect(await leak.text()).not.toContain("top secret");
  expect((await get("/%zz")).status).toBe(400);
});

test("only GET and HEAD outside /api/ and /internal/ are the dashboard's", () => {
  const req = (path: string, method = "GET") => new Request(`http://x${path}`, { method });
  expect(isDashboardRequest(req("/projects"), "/projects")).toBe(true);
  expect(isDashboardRequest(req("/api/x"), "/api/x")).toBe(false);
  expect(isDashboardRequest(req("/internal/health"), "/internal/health")).toBe(false);
  expect(isDashboardRequest(req("/projects", "POST"), "/projects")).toBe(false);
});
