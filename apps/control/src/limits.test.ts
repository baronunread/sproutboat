import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  clientIp,
  guardDeploy,
  guardNewProject,
  LIMITS,
  rateHit,
  resetLimiter,
  setPeerAddressResolver,
  tlsIssuanceAllowed,
} from "./limits";

let peer: string | undefined;
beforeEach(() => {
  peer = "127.0.0.1";
  setPeerAddressResolver(() => peer);
  delete process.env.SPROUTBOAT_TRUSTED_PROXIES;
  resetLimiter();
  for (const key of [
    "SPROUTBOAT_DEPLOY_RATE_PER_MIN",
    "SPROUTBOAT_DEPLOY_RATE_PER_IP_PER_MIN",
    "SPROUTBOAT_MAX_PROJECTS_PER_ACCOUNT",
    "SPROUTBOAT_MAX_VERSIONS_PER_PROJECT",
  ])
    delete process.env[key];
  delete process.env.SPROUTBOAT_TLS_NEW_CERTS_PER_HOUR;
});
afterEach(() => resetLimiter());

const req = (ip = "1.2.3.4") =>
  new Request("https://control.test/api/projects/x/deployments", { headers: { "x-forwarded-for": ip } });

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

const fwd = (headers: Record<string, string>) => new Request("https://c.test", { headers });

test("clientIp: behind a loopback proxy, the last X-Forwarded-For hop, then X-Real-IP, then the peer", () => {
  expect(clientIp(fwd({ "x-forwarded-for": "6.6.6.6, 9.9.9.9" }))).toBe("9.9.9.9");
  expect(clientIp(fwd({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
  expect(clientIp(fwd({}))).toBe("127.0.0.1");
  peer = "::ffff:127.0.0.1";
  expect(clientIp(fwd({ "x-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
});

test("clientIp: an untrusted peer's forwarding headers are ignored", () => {
  peer = "203.0.113.7";
  expect(clientIp(fwd({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }))).toBe("203.0.113.7");
});

test("clientIp: SPROUTBOAT_TRUSTED_PROXIES adds addresses and CIDRs", () => {
  process.env.SPROUTBOAT_TRUSTED_PROXIES = "198.51.100.4, 10.1.0.0/16";
  for (const trusted of ["198.51.100.4", "10.1.200.9"]) {
    peer = trusted;
    expect(clientIp(fwd({ "x-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
  }
  peer = "10.2.0.1";
  expect(clientIp(fwd({ "x-forwarded-for": "9.9.9.9" }))).toBe("10.2.0.1");
});

test("clientIp: no resolvable peer is 'unknown'", () => {
  peer = undefined;
  expect(clientIp(fwd({ "x-forwarded-for": "9.9.9.9" }))).toBe("unknown");
});

test("rateHit sweeps expired buckets on every hit once the map is large", () => {
  for (let i = 0; i < 5000; i++) rateHit("k" + i, 1, 0);
  rateHit("fresh", 1, 120_000);
  // the expired buckets are gone: a key from the old window starts a new count
  expect(rateHit("k1", 1, 120_001)).toBe(0);
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

test("tlsIssuanceAllowed: caps NEW hostnames per hour, repeats don't count", () => {
  process.env.SPROUTBOAT_TLS_NEW_CERTS_PER_HOUR = "3";
  const t = 1_000_000;
  expect(tlsIssuanceAllowed("a.x.test", t)).toBe(true);
  expect(tlsIssuanceAllowed("b.x.test", t)).toBe(true);
  expect(tlsIssuanceAllowed("c.x.test", t)).toBe(true);
  expect(tlsIssuanceAllowed("d.x.test", t)).toBe(false); // 4th new host in the window
  expect(tlsIssuanceAllowed("a.x.test", t + 1000)).toBe(true); // a repeat is a renewal, always allowed
  expect(tlsIssuanceAllowed("d.x.test", t + 3_600_001)).toBe(true); // window rolled over
});

test("LIMITS: env overrides, sane defaults", () => {
  expect(LIMITS.versionsPerProject()).toBe(25);
  process.env.SPROUTBOAT_MAX_VERSIONS_PER_PROJECT = "5";
  expect(LIMITS.versionsPerProject()).toBe(5);
});

test("tlsIssuanceAllowed: a hostname refused at the cap is not remembered as seen", () => {
  process.env.SPROUTBOAT_TLS_NEW_CERTS_PER_HOUR = "1";
  const t = 1_000_000;
  expect(tlsIssuanceAllowed("a.x.test", t)).toBe(true);
  expect(tlsIssuanceAllowed("b.x.test", t)).toBe(false);
  expect(tlsIssuanceAllowed("b.x.test", t + 1000)).toBe(false); // immediate retry stays refused
});
