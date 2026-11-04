/** The tunnel (connect()) cases: typed frames to the Bun and the Rust tunnel endpoints. */
import {
  TOKEN,
  T,
  openFrame,
  tunnel,
  typed,
  type Frame,
  type Json,
  type JsonObject,
  type Service,
  type TunnelCtx,
} from "./lib";

type TunnelCase = {
  id: string;
  suite: "tunnel";
  run: (svc: Service, ctx: TunnelCtx) => Promise<Json>;
};
type TunnelResult = "UNSUPPORTED" | { frames: Array<[number, string]>; closed: boolean };
export const tunnelCases: TunnelCase[] = [];

/** Adjacent data frames are one stream of bytes; where the chunks fall is not contract. */
function coalesce(frames: Frame[]): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const f of frames) {
    const last = out[out.length - 1];
    if (f.type === T.DATA && last && last[0] === T.DATA) last[1] += f.text;
    else out.push([f.type, f.text]);
  }
  return out;
}

const add = (id: string, run: TunnelCase["run"]) => tunnelCases.push({ id: `tunnel/${id}`, suite: "tunnel", run });
const head = (host: string | number, port: Json, mode: Json = "off", extra: JsonObject = {}): JsonObject => ({
  token: TOKEN,
  op: "tcp.open",
  host,
  port,
  mode,
  ...extra,
});
const unsupported = (svc: Service) => svc.tcp === 0;

async function run(
  svc: Service,
  first: Buffer,
  steps: Array<Buffer | number> = [],
  quiet = 400,
): Promise<TunnelResult> {
  if (unsupported(svc)) return "UNSUPPORTED";
  const r = await tunnel(svc.tcp, first, steps, quiet);
  return { frames: coalesce(r.frames), closed: r.closed };
}

add("echo-roundtrip", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.DATA, "hello "), typed(T.DATA, "world")]),
);
add("echo-large", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.DATA, "x".repeat(300_000))], 600).then(summariseData),
);
add("echo-by-name-localhost", (svc, ctx) =>
  run(svc, openFrame(head("localhost", ctx.echo.port)), [typed(T.DATA, "hi")]),
);
add("echo-host-short-form", (svc, ctx) => run(svc, openFrame(head("127.1", ctx.echo.port)), [typed(T.DATA, "hi")]));
add("echo-data-with-open-frame", (svc, ctx) =>
  run(svc, Buffer.concat([openFrame(head("127.0.0.1", ctx.echo.port)), typed(T.DATA, "early")]), []),
);
add("half-close-from-origin", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.DATA, "HALFCLOSE\n"), 300, typed(T.SHUTDOWN)]),
);
add("shutdown-from-client", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.DATA, "one"), typed(T.SHUTDOWN)]),
);
add("close-from-client", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.DATA, "one"), typed(T.CLOSE)]),
);
add("unknown-frame-ignored", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(99, "zz"), typed(T.DATA, "after")]),
);
add("frame-too-large", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [Buffer.from([T.DATA, 0, 0, 0x20, 0])]),
);
add("starttls-on-plain-socket", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.echo.port)), [typed(T.START_TLS, "localhost")]),
);
add("tls-on-verified-by-name", (svc, ctx) =>
  run(svc, openFrame(head("localhost", ctx.tlsEcho!.port, "on")), [typed(T.DATA, "secure hi")]),
);
add("tls-on-servername-override", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.tlsEcho!.port, "on", { servername: "localhost" })), [typed(T.DATA, "sni")]),
);
add("tls-on-name-mismatch", (svc, ctx) =>
  run(svc, openFrame(head("127.0.0.1", ctx.tlsEcho!.port, "on")), []).then(errorClass),
);
add("tls-on-plain-server", (svc, ctx) =>
  run(svc, openFrame(head("localhost", ctx.echo.port, "on")), []).then(errorClass),
);

// --- admission ------------------------------------------------------------------------------

add("bad-token", (svc, ctx) => run(svc, openFrame({ ...head("127.0.0.1", ctx.echo.port), token: "nope" }), []));
add("no-token", (svc, ctx) =>
  run(svc, openFrame({ op: "tcp.open", host: "127.0.0.1", port: ctx.echo.port, mode: "off" }), []),
);
add("token-wrong-type", (svc, ctx) => run(svc, openFrame({ ...head("127.0.0.1", ctx.echo.port), token: 5 }), []));
add("port-25", (svc) => run(svc, openFrame(head("127.0.0.1", 25)), []));
add("port-0", (svc) => run(svc, openFrame(head("127.0.0.1", 0)), []));
add("port-65536", (svc) => run(svc, openFrame(head("127.0.0.1", 65536)), []));
add("port-string", (svc, ctx) => run(svc, openFrame(head("127.0.0.1", String(ctx.echo.port))), []));
add("port-fraction", (svc) => run(svc, openFrame(head("127.0.0.1", 80.5)), []));
add("port-missing", (svc) => run(svc, openFrame({ token: TOKEN, op: "tcp.open", host: "127.0.0.1", mode: "off" }), []));
add("mode-bogus", (svc, ctx) => run(svc, openFrame(head("127.0.0.1", ctx.echo.port, "bogus")), []));
add("mode-missing", (svc, ctx) =>
  run(svc, openFrame({ token: TOKEN, op: "tcp.open", host: "127.0.0.1", port: ctx.echo.port }), []),
);
add("host-empty", (svc, ctx) => run(svc, openFrame(head("", ctx.echo.port)), []));
add("host-too-long", (svc, ctx) => run(svc, openFrame(head("a".repeat(256), ctx.echo.port)), []));
add("host-not-string", (svc, ctx) => run(svc, openFrame(head(5, ctx.echo.port)), []));
add("not-a-tcp-open", (svc) => run(svc, openFrame({ token: TOKEN, op: "something.else" }), []));
add("head-wrong-marker", (svc) => run(svc, Buffer.from([5, 0, 0, 0, 2, 0, 0, 0, 0]), []));
add("head-too-large", (svc) => run(svc, Buffer.from([0, 0, 0x10, 0, 1, 0, 0, 0]), []));

// --- the vetting ------------------------------------------------------------------------------

for (const [label, host] of [
  ["private-10", "10.0.0.1"],
  ["loopback-127.0.0.2", "127.0.0.2"],
  ["metadata", "169.254.169.254"],
  ["unspecified", "0.0.0.0"],
  ["cgnat", "100.64.0.1"],
  ["v6-ula", "fd00::1"],
  ["v6-link-local", "fe80::1"],
  ["v6-mapped", "::ffff:7f00:1"],
  ["v6-mapped-bracketed", "[::ffff:7f00:1]"],
  ["v6-mapped-dotted", "::ffff:10.0.0.1"],
  ["v6-nat64", "64:ff9b::7f00:1"],
  ["v6-6to4", "2002:a9fe:a9fe::1"],
  ["v6-compat", "::7f00:1"],
  ["v6-unnormalised", "0:0:0:0:0:ffff:7f00:2"],
  ["v6-scoped", "fe80::1%eth0"],
  ["nxdomain", "nonexistent.invalid"],
  ["bracketed-name", "[nonexistent.invalid]"],
  ["host-hex-private", "0xA.0.0.1"],
  ["host-decimal-private", "167772161"],
] as const) {
  add(`refuse/${label}`, (svc) => run(svc, openFrame(head(host, 80)), []));
}
add("connect-refused", (svc) => run(svc, openFrame(head("127.0.0.1", 1)), []));
add("connect-refused-v6", (svc) => run(svc, openFrame(head("::1", 1)), []));
add("connect-refused-by-name", (svc) => run(svc, openFrame(head("localhost", 1)), []));

// Last on purpose: with the Bun tcp.ts this one kills the service (uncaught JSON parse error).
add("head-not-json", (svc) => {
  const body = Buffer.from('not json at all {{{ "op":"tcp.open"');
  const out = Buffer.allocUnsafe(9 + body.length);
  out.writeUInt32LE(5 + body.length, 0);
  out.writeUInt8(1, 4);
  out.writeUInt32LE(body.length, 5);
  body.copy(out, 9);
  return run(svc, out, []);
});

function summariseData(r: TunnelResult): Json {
  if (r === "UNSUPPORTED") return r;
  const { frames, closed } = r;
  return { frames: frames.map(([t, text]) => (t === T.DATA ? [t, text.length, text.slice(0, 8)] : [t, text])), closed };
}
function errorClass(r: TunnelResult): Json {
  if (r === "UNSUPPORTED") return r;
  const { frames, closed } = r;
  return { frames: frames.map(([t, text]) => (t === T.ERROR ? [t, "<error>"] : [t, text])), closed };
}
