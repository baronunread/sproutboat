/**
 * The Bun egress service as the differential harness runs it: the real `egress.ts`
 * from @sproutboat/wire (the copy in node_modules, i.e. what the platform ships, or
 * `SB_EGRESS_TS_WIRE=<dir of a wire package>`), with the resolver swapped for the DNS
 * stub when `SB_EGRESS_TEST_RESOLVER` is set (the Rust binary does the same under its
 * `test-resolver` feature). When that wire has `tcp.ts` (sproutboat-packages main) the
 * tunnel endpoint runs too.
 *
 *   bun ts-egress.ts   ->   prints "READY http=<port> tcp=<port|0>"
 */
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { resolve as resolvePath } from "node:path";

const wire = process.env.SB_EGRESS_TS_WIRE ?? resolvePath(import.meta.dir, "../../node_modules/@sproutboat/wire");
const { createEgressHandler } = await import(`${wire}/src/egress.ts`);
const token = process.env.SB_EGRESS_TOKEN ?? "";
const allow = (process.env.SB_EGRESS_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const stub = process.env.SB_EGRESS_TEST_RESOLVER;

const resolve = stub
  ? async (host: string) => {
      if (isIP(host)) return [{ address: host }];
      const res = await fetch(`${stub}/resolve?host=${encodeURIComponent(host)}`);
      if (!res.ok) throw new Error(`stub: ${res.status}`);
      const answers: string[] = await res.json();
      return answers.map((address) => ({ address }));
    }
  : undefined;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  fetch: createEgressHandler({ token, allow, resolve }),
});

let tcpPort = 0;
if (existsSync(`${wire}/src/tcp.ts`)) {
  const { createTcpTunnels, listenTunnelService } = await import(`${wire}/src/tcp.ts`);
  const tunnels = createTcpTunnels({ token, allow, maxOpen: 256, resolve });
  tcpPort = listenTunnelService(tunnels, "127.0.0.1", 0).port;
}
console.log(`READY http=${server.port} tcp=${tcpPort}`);
