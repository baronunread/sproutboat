// Runs the service-binding suite on the platform: starts a local edge serving the built
// caller and callee, bound to each other, drives it, and stops it.
//   bun tests/service-bindings/platform.ts OUT.json
// Build both apps first (`sproutboat build --target host` in caller/ and callee/); the
// newest artifact under each .sproutboat/dist is used. SB_SUITE_EDGE_ROOT runs the edge
// from another checkout of this repo.
import { mkdtempSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: bun tests/service-bindings/platform.ts OUT.json");
  process.exit(2);
}
const here = import.meta.dir;
// The edge to run: this checkout's, or another one's (to score an edge branch).
const root = process.env.SB_SUITE_EDGE_ROOT ?? join(here, "../..");
const newestSprout = (app: string) => {
  const dist = join(here, app, ".sproutboat/dist");
  const dirs = readdirSync(dist)
    .map((d) => join(dist, d))
    .filter((d) => statSync(join(d, "sprout"), { throwIfNoEntry: false }));
  if (!dirs.length) throw new Error(`no built artifact in ${dist}: run sproutboat build --target host in ${app}/`);
  return join(dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0], "sprout");
};

const tmp = mkdtempSync(join(tmpdir(), "sb-svc-"));
await Bun.write(
  join(tmp, "routes.json"),
  JSON.stringify([
    { hostname: "svc-callee.test", sproutPath: newestSprout("callee"), services: { CALLER: "svc-caller.test" } },
    {
      hostname: "svc-caller.test",
      sproutPath: newestSprout("caller"),
      services: { PEER: "svc-callee.test", SELF: "svc-caller.test" },
    },
  ]),
);
const edge = Bun.spawn(["bun", "services/edge/src/main.ts"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: "0",
    SPROUTBOAT_ROUTE_SNAPSHOT: join(tmp, "routes.json"),
    SPROUTBOAT_BROKER_STATE_DIR: join(tmp, "brokers"),
    SPROUTBOAT_RESOURCE_DIR: join(tmp, "resources"),
    SPROUTBOAT_EDGE_CACHE: "off",
  },
  stdout: "pipe",
  stderr: "inherit",
});
try {
  // The edge prints its address once it accepts requests. Keep draining its stdout after
  // that, so a full pipe never stalls it.
  const port = await new Promise<string>((resolve, reject) => {
    const decoder = new TextDecoder();
    void (async () => {
      for await (const chunk of edge.stdout) {
        const match = /listening on http:\/\/[\d.]+:(\d+)/.exec(decoder.decode(chunk));
        if (match) resolve(match[1]);
      }
      reject(new Error("the edge exited before listening"));
    })();
  });
  const driver = Bun.spawn(["bun", join(here, "driver.ts"), `http://127.0.0.1:${port}`, out, "svc-caller.test"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await driver.exited;
} finally {
  edge.kill("SIGTERM");
  await edge.exited;
  rmSync(tmp, { recursive: true, force: true });
}
