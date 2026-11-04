/** Route reload (mtime poll, request-driven, SIGHUP), invalid snapshots, and the activation protocol. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Fixture, Json } from "./lib";
import { sleep } from "./lib";
import { asRecord, isString } from "./json";
import type { Case, Ctx } from "./runner";
import { get, json, supRoute } from "./helpers";

const G = "reload";

/** Two routable apps "a" and "b", each answering `/who` with its name. */
async function twoApps(fx: Fixture): Promise<{ a: Json; b: Json }> {
  return { a: await supRoute(fx, "app.test", "a"), b: await supRoute(fx, "app.test", "b") };
}

/**
 * A supervisor route boots the new sprout on the first request after a flip, which on a loaded
 * machine takes seconds: wait generously and only judge reload latency where no process is
 * spawned. Every window here is a ceiling for a hung edge, not a speed test.
 */
const BOOT_MS = 20_000;

const appOf = (obs: Parameters<typeof json>[0]) => {
  const parsed = asRecord(json(obs));
  return parsed === null ? "?" : String(parsed.app);
};

/** Poll `/who` until it answers `name`; returns whether that happened within the deadline. */
async function flipsTo(ctx: Ctx, name: string, deadlineMs = 1500): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    const res = await ctx.quiet({ path: "/who", timeoutMs: 4000 });
    if (appOf(res) === name) return { ok: true, ms: Date.now() - started };
    await sleep(25);
  }
  return { ok: false, ms: Date.now() - started };
}

const trafficLoop = (): Case => ({
  id: "reload-under-traffic",
  group: G,
  logs: "off",
  timeoutMs: 40_000,
  setup: async (fx) => [(await twoApps(fx)).a],
  run: async (ctx) => {
    const seen: { app: string; status: number; at: number }[] = [];
    let stop = false;
    const loop = (async () => {
      while (!stop) {
        const res = await ctx.quiet({ path: "/who", timeoutMs: 5000 });
        seen.push({ app: appOf(res), status: res.status, at: Date.now() });
        await sleep(10);
      }
    })();
    await ctx.sleep(500);
    const b = ctx.fx.sprouts.get("b");
    const next: Json[] = [{ hostname: "app.test", sproutPath: b! }];
    const writtenAt = Date.now();
    ctx.writeRoutes(next); // rename: atomic
    const deadline = Date.now() + BOOT_MS;
    while (Date.now() < deadline && !seen.some((s) => s.app === "b")) await sleep(20);
    await ctx.sleep(300);
    stop = true;
    await loop;
    const firstB = seen.find((s) => s.app === "b");
    const firstBIndex = seen.findIndex((s) => s.app === "b");
    const monotone = firstBIndex >= 0 && seen.slice(firstBIndex).every((s) => s.app === "b");
    // The per-request observations of the loop are timing-dependent; only the summary is compared.
    const summary: Json = {
      failedRequests: seen.filter((s) => s.status !== 200).length,
      sawA: seen.some((s) => s.app === "a"),
      sawB: Boolean(firstB),
      flippedWithin1500ms: firstB ? firstB.at - writtenAt <= 1500 : false,
      monotone,
      unknownApps: seen.filter((s) => s.app !== "a" && s.app !== "b").length,
    };
    ctx.note("summary", summary);
  },
});

const flipCase = (id: string, how: "rename" | "inplace" | "sighup"): Case => ({
  id,
  group: G,
  logs: "off",
  stdout: how === "sighup",
  timeoutMs: 60_000,
  setup: async (fx) => [(await twoApps(fx)).a],
  run: async (ctx) => {
    ctx.note("before", appOf(await ctx.req("before", { path: "/who" })));
    const next: Json[] = [{ hostname: "app.test", sproutPath: ctx.fx.sprouts.get("b")! }];
    await ctx.sleep(30);
    ctx.writeRoutes(next, how !== "inplace");
    if (how === "sighup") ctx.hup();
    const flipped = await flipsTo(ctx, "b", BOOT_MS);
    ctx.note("flipped to b", flipped.ok);
    // The old sprout is disposed when its route goes away.
    const gone = await ctx.waitFor(
      async () => {
        const pool = asRecord(json(await ctx.quiet({ path: "/__sb/pool" })));
        return pool !== null && pool.live === 1;
      },
      15_000,
      100,
    );
    ctx.note("old sprout disposed", gone);
  },
});

const activationDir = (fx: Fixture) => {
  const dir = join(fx.dir, "activation");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** Write `<id>.request.json` and wait for `<id>.reply.json`; returns its text. */
async function activate(ctx: Ctx, id: string, routes: Json | string, deadlineMs = 15_000): Promise<string> {
  const dir = join(ctx.fx.dir, "activation");
  const request = join(dir, `${id}.request.json`);
  const reply = join(dir, `${id}.reply.json`);
  writeFileSync(`${request}.tmp`, isString(routes) ? routes : JSON.stringify(routes));
  renameSync(`${request}.tmp`, request);
  const ok = await ctx.waitFor(() => existsSync(reply), deadlineMs, 20);
  return ok ? readFileSync(reply, "utf8") : "<no reply>";
}

const activationCase = (c: Omit<Case, "group">): Case => ({
  group: "activation",
  env: (fx) => ({ SPROUTBOAT_ACTIVATION_DIR: activationDir(fx) }),
  ...c,
});

export const reloadCases: Case[] = [
  trafficLoop(),
  flipCase("reload-flip-on-request", "rename"),
  flipCase("reload-inplace-rewrite", "inplace"),
  flipCase("reload-sighup", "sighup"),
  {
    id: "reload-idle-timer-picks-up-change",
    group: G,
    logs: "off",
    setup: async (fx) => [(await twoApps(fx)).a],
    run: async (ctx) => {
      ctx.note("before", appOf(await ctx.req("before", { path: "/who" })));
      ctx.writeRoutes([await supRoute(ctx.fx, "app.test", "b")]);
      await ctx.sleep(1800); // no traffic: only a timer can notice
      ctx.note("first request after idle", appOf(await ctx.req("after", { path: "/who" })));
    },
  },
  {
    id: "reload-invalid-keeps-old-routes",
    group: G,
    logs: "off",
    setup: async (fx) => [(await twoApps(fx)).a],
    run: async (ctx) => {
      const good: Json[] = [await supRoute(ctx.fx, "app.test", "b")];
      const attempts: [string, string][] = [
        ["not json", "{{{ nope"],
        ["empty file", ""],
        ["not an array", '{"hostname":"app.test"}'],
        ["bad hostname", '[{"hostname":"APP.test","sproutPath":"/x/sprout"}]'],
        ["relative sproutPath", '[{"hostname":"app.test","sproutPath":"rel/sprout"}]'],
      ];
      for (const [name, text] of attempts) {
        ctx.writeRoutes(text);
        await ctx.sleep(350);
        ctx.note(`after ${name}`, appOf(await ctx.req(name, { path: "/who" })));
      }
      ctx.writeRoutes(good);
      const flipped = await flipsTo(ctx, "b", BOOT_MS);
      ctx.note("valid snapshot applies afterwards", flipped.ok);
      ctx.note("other host is unaffected", (await ctx.req("unknown", { path: "/", host: "nope.test" })).status);
    },
  },
  {
    id: "reload-sighup-invalid-file",
    group: G,
    logs: "off",
    stdout: true,
    setup: async (fx) => [(await twoApps(fx)).a],
    run: async (ctx) => {
      ctx.note("before", appOf(await ctx.req("before", { path: "/who" })));
      ctx.writeRoutes("{{{ nope");
      ctx.hup();
      await ctx.sleep(500);
      const res = await ctx.req("after SIGHUP with a bad file", { path: "/who", timeoutMs: 3000 });
      ctx.note("still serving the old route", [res.status, appOf(res), res.error ?? null]);
      ctx.note("process alive", ctx.edge.proc.exitCode === null);
    },
  },
  {
    id: "reload-sighup-missing-file-clears-routes",
    group: G,
    logs: "off",
    stdout: true,
    setup: async (fx) => [(await twoApps(fx)).a],
    run: async (ctx) => {
      ctx.note("before", appOf(await ctx.req("before", { path: "/who" })));
      ctx.removeRoutes();
      await ctx.sleep(400);
      ctx.note(
        "after deleting the file (request-driven reload ignores a missing file)",
        (await ctx.req("after delete", { path: "/who" })).status,
      );
      ctx.hup();
      await ctx.sleep(300);
      ctx.note("after SIGHUP", (await ctx.req("after hup", { path: "/who" })).status);
    },
  },
  {
    id: "reload-missing-file-at-startup",
    group: G,
    logs: "off",
    setup: async () => null,
    run: async (ctx) => {
      ctx.note("no file", (await ctx.req("no file", { path: "/who" })).status);
      const b = await supRoute(ctx.fx, "app.test", "b");
      ctx.writeRoutes([b]);
      const flipped = await flipsTo(ctx, "b", BOOT_MS);
      ctx.note("file appears", flipped.ok);
    },
  },
  {
    id: "reload-older-mtime-is-ignored-until-sighup",
    group: G,
    logs: "off",
    stdout: true,
    setup: async (fx) => [(await twoApps(fx)).a],
    run: async (ctx) => {
      ctx.note("before", appOf(await ctx.req("before", { path: "/who" })));
      ctx.writeRoutes([await supRoute(ctx.fx, "app.test", "b")], false);
      const past = new Date(Date.now() - 3_600_000);
      utimesSync(ctx.routesPath, past, past);
      await ctx.sleep(1300);
      ctx.note("old mtime: still a", appOf(await ctx.req("after old-mtime write", { path: "/who" })));
      ctx.hup();
      const flipped = await flipsTo(ctx, "b", BOOT_MS);
      ctx.note("SIGHUP reads it regardless", flipped.ok);
    },
  },
  {
    id: "reload-same-tick-rewrite",
    group: G,
    logs: "off",
    setup: async (fx) => [await supRoute(fx, "app.test", "a")],
    intentional: {
      reason:
        "Linux mtimes are coarse: a rewrite in the same tick as the previous write has an identical mtime (to the nanosecond). Bun reloads only on a strictly newer mtime, so it keeps the old routes until SIGHUP; Rust also compares inode, size and ctime, and a content hash while the loaded snapshot is within 2 s of its mtime, so it picks the rewrite up",
      assertRust: (run, h) => {
        const out: string[] = [];
        if (h.note(run, "in-place rewrite, same mtime: now b") !== true)
          out.push("in-place same-tick rewrite not picked up");
        if (h.note(run, "atomic rewrite, same mtime: now a") !== true)
          out.push("atomic same-tick rewrite not picked up");
        return out;
      },
    },
    run: async (ctx) => {
      const seconds = ctx.pinRoutesMtime(); // an exact timestamp both rewrites below can repeat
      await ctx.sleep(1300); // every poll path has seen the pinned file
      ctx.writeRoutesAtMtime([await supRoute(ctx.fx, "app.test", "b")], seconds);
      ctx.note("in-place rewrite, same mtime: now b", (await flipsTo(ctx, "b", BOOT_MS)).ok);
      ctx.writeRoutesAtMtime([await supRoute(ctx.fx, "app.test", "a")], seconds, true);
      ctx.note("atomic rewrite, same mtime: now a", (await flipsTo(ctx, "a", BOOT_MS)).ok);
    },
  },
  {
    id: "reload-adds-and-removes-hosts",
    group: G,
    logs: "off",
    setup: async (fx) => {
      const { a } = await twoApps(fx);
      return [a];
    },
    run: async (ctx) => {
      // ctx.writeRoutes always moves the mtime strictly forward, so Bun's strictly-newer check does not
      // depend on how far apart in time the writes are (see reload-same-tick-rewrite for the other case).
      const a = await supRoute(ctx.fx, "app.test", "a");
      const b = await supRoute(ctx.fx, "second.test", "b");
      ctx.writeRoutes([a, b]);
      const added = await ctx.waitFor(
        async () => (await ctx.quiet({ path: "/who", host: "second.test" })).status === 200,
        2500,
        50,
      );
      ctx.note("second host appears", added);
      ctx.writeRoutes([b]);
      const removed = await ctx.waitFor(async () => (await ctx.quiet({ path: "/who" })).status === 404, 2500, 50);
      ctx.note("first host disappears", removed);
    },
  },
  {
    id: "reload-keeps-sprout-for-unchanged-route",
    group: G,
    setup: async (fx) => [await supRoute(fx, "app.test", "a")],
    run: async (ctx) => {
      await get(ctx, "cold start", "/who");
      ctx.writeRoutes([
        await supRoute(ctx.fx, "app.test", "a"),
        { hostname: "extra.test", sproutPath: ctx.fx.sprouts.get("a")! },
      ]);
      await ctx.sleep(350);
      await get(ctx, "after an unrelated change: still warm", "/who");
      await get(ctx, "pool", "/__sb/pool");
    },
  },

  // ---- activation protocol ----
  activationCase({
    id: "activation-supervisor-route",
    setup: async (fx) => {
      await supRoute(fx, "cand.test", "cand");
      return [];
    },
    run: async (ctx) => {
      ctx.note(
        "reply",
        await activate(ctx, "cand", [{ hostname: "cand.test", sproutPath: ctx.fx.sprouts.get("cand")! }]),
      );
      await get(ctx, "pool: candidate is running", "/__sb/pool");
      await get(ctx, "not routed yet", "/x", { host: "cand.test" });
    },
  }),
  activationCase({
    id: "activation-then-routed-request-is-warm",
    setup: async (fx) => [await supRoute(fx, "app.test", "app")],
    run: async (ctx) => {
      ctx.note(
        "reply",
        await activate(ctx, "warm", [{ hostname: "app.test", sproutPath: ctx.fx.sprouts.get("app")! }]),
      );
      await get(ctx, "first routed request", "/who");
      await get(ctx, "pool", "/__sb/pool");
    },
  }),
  activationCase({
    id: "activation-failing-sprout",
    timeoutMs: 40_000,
    setup: async (fx) => {
      await supRoute(fx, "bad.test", "bad", { script: "#!/bin/sh\nexit 3\n" });
      return [];
    },
    run: async (ctx) => {
      ctx.note("reply", await activate(ctx, "bad", [{ hostname: "bad.test", sproutPath: ctx.fx.sprouts.get("bad")! }]));
    },
  }),
  activationCase({
    id: "activation-missing-executable",
    timeoutMs: 40_000,
    setup: async (fx) => {
      await supRoute(fx, "gone.test", "gone", { missing: true });
      return [];
    },
    run: async (ctx) => {
      ctx.note(
        "reply",
        await activate(ctx, "gone", [{ hostname: "gone.test", sproutPath: ctx.fx.sprouts.get("gone")! }]),
      );
    },
  }),
  activationCase({
    id: "activation-never-listens",
    timeoutMs: 40_000,
    setup: async (fx) => {
      await supRoute(fx, "slow.test", "slow", { script: "#!/bin/sh\nexec sleep 30\n" });
      return [];
    },
    run: async (ctx) => {
      ctx.note(
        "reply (readiness timeout)",
        (
          await activate(ctx, "slow", [{ hostname: "slow.test", sproutPath: ctx.fx.sprouts.get("slow")! }], 30_000)
        ).replace(/:\d+ within/, ":<port> within"),
      );
    },
  }),
  activationCase({
    id: "activation-invalid-requests",
    setup: async () => [],
    run: async (ctx) => {
      ctx.note("object instead of array", await activate(ctx, "obj", "{}"));
      ctx.note("bad hostname", await activate(ctx, "host", '[{"hostname":"BAD","sproutPath":"/x/sprout"}]'));
      ctx.note("empty array", await activate(ctx, "empty", "[]"));
      ctx.note("relative sproutPath", await activate(ctx, "rel", '[{"hostname":"a.test","sproutPath":"x"}]'));
      ctx.note("null", await activate(ctx, "null", "null"));
    },
  }),
  activationCase({
    id: "activation-malformed-json",
    setup: async () => [],
    run: async (ctx) => {
      ctx.note("not json", await activate(ctx, "junk", "this is not json"));
      ctx.note("empty file", await activate(ctx, "blank", ""));
    },
  }),
  activationCase({
    id: "activation-first-route-only",
    setup: async (fx) => {
      await supRoute(fx, "one.test", "one");
      await supRoute(fx, "two.test", "two");
      return [];
    },
    run: async (ctx) => {
      ctx.note(
        "reply",
        await activate(ctx, "two-routes", [
          { hostname: "one.test", sproutPath: ctx.fx.sprouts.get("one")! },
          { hostname: "two.test", sproutPath: ctx.fx.sprouts.get("two")! },
        ]),
      );
      await get(ctx, "pool: only the first started", "/__sb/pool");
    },
  }),
  activationCase({
    id: "activation-several-requests",
    setup: async (fx) => {
      await supRoute(fx, "a.test", "a");
      await supRoute(fx, "b.test", "b");
      return [];
    },
    run: async (ctx) => {
      const a = [{ hostname: "a.test", sproutPath: ctx.fx.sprouts.get("a")! }];
      const b = [{ hostname: "b.test", sproutPath: ctx.fx.sprouts.get("b")! }];
      ctx.note("a", await activate(ctx, "a", a));
      ctx.note("b", await activate(ctx, "b", b));
      ctx.note("a again (new id, already running)", await activate(ctx, "a2", a));
      await get(ctx, "pool", "/__sb/pool");
    },
  }),
  activationCase({
    id: "activation-existing-reply-is-left-alone",
    setup: async () => [],
    run: async (ctx) => {
      const dir = join(ctx.fx.dir, "activation");
      writeFileSync(join(dir, "old.reply.json"), "KEEP");
      writeFileSync(join(dir, "old.request.json"), "[]");
      await ctx.sleep(700);
      ctx.note("reply untouched", readFileSync(join(dir, "old.reply.json"), "utf8"));
    },
  }),
  activationCase({
    id: "activation-ignores-other-files",
    setup: async () => [],
    run: async (ctx) => {
      const dir = join(ctx.fx.dir, "activation");
      writeFileSync(join(dir, "a.request.json.tmp"), "[]");
      writeFileSync(join(dir, "b.json"), "[]");
      writeFileSync(join(dir, "c.reply.json"), "x");
      writeFileSync(join(dir, "request.json"), "[]");
      await ctx.sleep(700);
      ctx.note("files after", readdirSync(dir).sort());
    },
  }),
  activationCase({
    id: "activation-withdrawn-request-drops-reply",
    timeoutMs: 40_000,
    setup: async (fx) => {
      await supRoute(fx, "late.test", "late", {
        script: `#!/bin/sh\nsleep 1.2\nexport APP_NAME=late\nexec bun ${join(import.meta.dir, "fake-app.ts")}\n`,
      });
      return [];
    },
    run: async (ctx) => {
      const dir = join(ctx.fx.dir, "activation");
      const request = join(dir, "late.request.json");
      writeFileSync(request, JSON.stringify([{ hostname: "late.test", sproutPath: ctx.fx.sprouts.get("late")! }]));
      await ctx.sleep(400);
      rmSync(request);
      await ctx.sleep(2500);
      ctx.note("reply written for a withdrawn request", existsSync(join(dir, "late.reply.json")));
    },
  }),
  activationCase({
    id: "activation-not-set",
    env: { SPROUTBOAT_ACTIVATION_DIR: null },
    setup: async () => [],
    run: async (ctx) => {
      const dir = join(ctx.fx.dir, "activation");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.request.json"), "[]");
      await ctx.sleep(500);
      ctx.note("no reply without the env var", existsSync(join(dir, "x.reply.json")));
    },
  }),
];
