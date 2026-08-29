import { afterEach, beforeEach, expect, test } from "bun:test";
import { clientIp, guardDeploy, guardNewProject, LIMITS, rateHit, resetLimiter } from "./limits";

beforeEach(() => {
  resetLimiter();
  for (const key of [
    "SPROUTBOAT_DEPLOY_RATE_PER_MIN", "SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN",
    "SPROUTBOAT_MAX_PROJECTS_PER_ACCOUNT", "SPROUTBOAT_MAX_VERSIONS_PER_PROJECT",
  ]) delete process.env[key];
});
afterEach(() => resetLimiter());

const req = (ip = "1.2.3.4") => new Request("https://control.test/api/projects/x/deployments", { headers: { "x-forwarded-for": ip } });

test("rateHit: allows `limit` in a window, then returns a positive retry-after", () => {
  for (let i = 0; i < 3; i++) expect(rateHit("k", 3, 1000)).toBe(0);
  const retry = rateHit("k", 3, 1000);
  expect(retry).toBeGreaterThan(0);
  expect(retry).toBeLessThanOrEqual(60);
});

test("rateHit: window resets after 60s", () => {
  expect(rateHit("k", 1, 0)).toBe(0);
  expect(rateHit("k", 1, 0)).toBeGreaterThan(0);
  expect(rateHit("k", 1, 60_000)).toBe(0);
});

test("clientIp: first X-Forwarded-For hop, then X-Real-IP, then 'unknown'", () => {
  expect(clientIp(new Request("https://c.test", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } }))).toBe("9.9.9.9");
  expect(clientIp(new Request("https://c.test", { headers: { "x-real-ip": "8.8.8.8" } }))).toBe("8.8.8.8");
  expect(clientIp(new Request("https://c.test"))).toBe("unknown");
});

test("guardDeploy: 429 + Retry-After once the per-account limit is hit", async () => {
  process.env.SPROUTBOAT_DEPLOY_RATE_PER_MIN = "2";
  process.env.SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN = "100";
  expect(await guardDeploy("acct-1", req())).toBeNull();
  expect(await guardDeploy("acct-1", req())).toBeNull();
  const blocked = await guardDeploy("acct-1", req());
  expect(blocked?.status).toBe(429);
  expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);
  // a different account is unaffected
  expect(await guardDeploy("acct-2", req())).toBeNull();
});

test("guardDeploy: per-IP limit is independent of the account", async () => {
  process.env.SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN = "2";
  process.env.SPROUTBOAT_DEPLOY_RATE_PER_MIN = "100";
  expect(await guardDeploy("a", req("5.5.5.5"))).toBeNull();
  expect(await guardDeploy("b", req("5.5.5.5"))).toBeNull();
  expect((await guardDeploy("c", req("5.5.5.5")))?.status).toBe(429);
  expect(await guardDeploy("d", req("6.6.6.6"))).toBeNull();
});

test("guardNewProject: 429 at the cap, allowed below it", async () => {
  process.env.SPROUTBOAT_MAX_PROJECTS_PER_ACCOUNT = "3";
  expect(await guardNewProject("acct", req(), 2)).toBeNull();
  const capped = await guardNewProject("acct", req(), 3);
  expect(capped?.status).toBe(429);
});

test("LIMITS: env overrides, sane defaults", () => {
  expect(LIMITS.versionsPerProject()).toBe(25);
  process.env.SPROUTBOAT_MAX_VERSIONS_PER_PROJECT = "5";
  expect(LIMITS.versionsPerProject()).toBe(5);
});
