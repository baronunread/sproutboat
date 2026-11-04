/** WebSockets through the edge, via a sproutd-routed backend and via a supervisor route. */
import type { Hdrs, WsConn } from "./lib";
import type { Case, Ctx } from "./runner";
import { both, hdrs } from "./helpers";

const G = "websocket";

const handshake = (...extra: [string, string][]): Hdrs =>
  hdrs(
    ["connection", "Upgrade"],
    ["upgrade", "websocket"],
    ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
    ["sec-websocket-version", "13"],
    ...extra,
  );

const closedOrTimeout = async (ctx: Ctx, conn: WsConn, ms = 3000) =>
  await Promise.race([conn.closed, ctx.sleep(ms).then(() => ({ code: -1, reason: "<still open>" }))]);

export const wsCases: Case[] = [
  ...both("ws-echo", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      ctx.note("opened", c.opened);
      c.send("hi");
      ctx.note("text echo", await c.next());
      c.send(new Uint8Array([0, 1, 2, 255]));
      ctx.note("binary echo", await c.next());
      c.send("");
      ctx.note("empty text", await c.next());
      c.send(new Uint8Array(0));
      ctx.note("empty binary", await c.next());
      c.send("héllo wörld ✓");
      ctx.note("unicode", await c.next());
      c.send("x".repeat(2 * 1024 * 1024));
      ctx.note("2 MiB text", await c.next(15_000));
      c.send(new Uint8Array(1024 * 1024).fill(7));
      ctx.note("1 MiB binary", await c.next(15_000));
      c.close(4001, "done");
      ctx.note("client close", await closedOrTimeout(ctx, c));
    },
  })),
  ...both("ws-many-messages-in-order", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      for (let i = 0; i < 50; i++) c.send(`m${i}`);
      const got: string[] = [];
      for (let i = 0; i < 50; i++) got.push(String(await c.next()));
      ctx.note(
        "in order",
        got.every((m, i) => m === `echo:m${i}`),
      );
      c.close();
      ctx.note("client close without a code", await closedOrTimeout(ctx, c));
    },
  })),
  ...both("ws-subprotocol", G, () => ({
    run: async (ctx) => {
      const chosen = await ctx.ws("/proto", { protocols: ["other", "chat"] });
      ctx.note("offered other, chat -> proto", [chosen.opened, chosen.protocol]);
      chosen.send("hi");
      ctx.note("echo", await chosen.next());
      chosen.close();
      await closedOrTimeout(ctx, chosen);
      const none = await ctx.ws("/proto", { protocols: ["other"] });
      ctx.note("offered other -> proto", [none.opened, none.protocol]);
      none.close();
      await closedOrTimeout(ctx, none);
      const plain = await ctx.ws("/echo", { protocols: ["chat"] });
      ctx.note("path that picks none", [plain.opened, plain.protocol]);
      plain.close();
      await closedOrTimeout(ctx, plain);
      const nothing = await ctx.ws("/proto");
      ctx.note("no offer", [nothing.opened, nothing.protocol]);
      nothing.close();
      await closedOrTimeout(ctx, nothing);
    },
  })),
  ...both("ws-handshake-101-headers", G, () => ({
    run: async (ctx) => {
      await ctx.req("101 on /echo", { path: "/echo", headers: handshake(), upgrade: true });
      await ctx.req("101 on /proto with offered protocols", {
        path: "/proto",
        headers: handshake(["sec-websocket-protocol", "other, chat"]),
        upgrade: true,
      });
      await ctx.req("101 on /proto, nothing matching", {
        path: "/proto",
        headers: handshake(["sec-websocket-protocol", "other"]),
        upgrade: true,
      });
      await ctx.req("101 with query", { path: "/echo?x=1&y=2", headers: handshake(), upgrade: true });
      await ctx.req("101 with extensions offered", {
        path: "/echo",
        headers: handshake(["sec-websocket-extensions", "permessage-deflate; client_max_window_bits"]),
        upgrade: true,
      });
    },
  })),
  ...both("ws-handshake-variants", G, () => ({
    run: async (ctx) => {
      const label = (name: string, h: Hdrs) =>
        ctx.req(name, { path: "/echo", headers: h, upgrade: true, timeoutMs: 4000 });
      await label(
        "connection: keep-alive, Upgrade; upgrade: WebSocket",
        hdrs(
          ["connection", "keep-alive, Upgrade"],
          ["upgrade", "WebSocket"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "13"],
        ),
      );
      await label(
        "connection: upgrade (lower case)",
        hdrs(
          ["connection", "upgrade"],
          ["upgrade", "websocket"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "13"],
        ),
      );
      await label("upgrade: h2c is not a websocket", hdrs(["connection", "Upgrade"], ["upgrade", "h2c"]));
      await label(
        "connection without upgrade token",
        hdrs(
          ["connection", "keep-alive"],
          ["upgrade", "websocket"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "13"],
        ),
      );
      await label(
        "no Upgrade header",
        hdrs(
          ["connection", "Upgrade"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "13"],
        ),
      );
      await label(
        "missing Sec-WebSocket-Key",
        hdrs(["connection", "Upgrade"], ["upgrade", "websocket"], ["sec-websocket-version", "13"]),
      );
      await label(
        "wrong Sec-WebSocket-Version",
        hdrs(
          ["connection", "Upgrade"],
          ["upgrade", "websocket"],
          ["sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ=="],
          ["sec-websocket-version", "8"],
        ),
      );
      await ctx.req("POST with websocket headers is a plain request", {
        method: "POST",
        path: "/seen",
        body: "x",
        headers: handshake(),
      });
    },
  })),
  ...both("ws-greeting-before-open", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/greet");
      ctx.note("greeting", await c.next());
      c.close();
      await closedOrTimeout(ctx, c);
    },
  })),
  ...both("ws-forwarded-request-headers", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/headers?x=1", {
        headers: {
          cookie: "a=1; b=2",
          "x-custom": "yes",
          authorization: "Bearer t",
          origin: "https://o.example",
          "x-sb-edge-secret": "forged",
          "x-sb-edge-token": "forged",
          "x-sb-binding-call": "1",
          "x-sb-url": "https://evil.example/",
        },
      });
      ctx.note("opened", c.opened);
      ctx.note("headers the app saw", JSON.parse(String(await c.next())));
      c.close();
      await closedOrTimeout(ctx, c);
    },
  })),
  ...both("ws-server-closes-with-code", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      c.send("bye");
      ctx.note("close the app sent", await closedOrTimeout(ctx, c));
    },
  })),
  ...both("ws-server-closes-without-code", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      c.send("nocode");
      ctx.note("close frame without a status", await closedOrTimeout(ctx, c));
    },
  })),
  ...both("ws-server-closes-immediately", G, () => ({
    run: async (ctx) => {
      const c = await ctx.ws("/silent-close");
      ctx.note("opened", c.opened);
      ctx.note("close", await closedOrTimeout(ctx, c));
    },
  })),
  ...both("ws-client-close-codes", G, () => ({
    run: async (ctx) => {
      for (const code of [1000, 1001, 3000, 4999]) {
        const c = await ctx.ws("/echo");
        c.send("ping");
        await c.next();
        c.close(code, `bye ${code}`);
        ctx.note(`client closes ${code}`, await closedOrTimeout(ctx, c));
      }
      const alive = await ctx.ws("/echo");
      alive.send("still");
      ctx.note("edge still relays afterwards", await alive.next());
      alive.close();
      await closedOrTimeout(ctx, alive);
    },
  })),
  ...both("ws-refused-upstream", G, () => ({
    run: async (ctx) => {
      await ctx.req("raw handshake to a path the app refuses", {
        path: "/refuse",
        headers: handshake(),
        upgrade: true,
      });
      const c = await ctx.ws("/refuse");
      ctx.note("client sees the refusal", [c.opened]);
    },
  })),
  ...both("ws-unknown-host", G, () => ({
    run: async (ctx) => {
      await ctx.req("handshake to an unknown host", {
        path: "/echo",
        host: "nope.test",
        headers: handshake(),
        upgrade: true,
      });
      const c = await ctx.ws("/echo", { host: "nope.test" });
      ctx.note("client open", c.opened);
    },
  })),
  ...both("ws-concurrent-sockets", G, () => ({
    logs: "sorted",
    run: async (ctx) => {
      // Warm first: which of the concurrent sockets starts a cold sprout is a race, and only that one logs coldStart.
      await ctx.req("warm the sprout", { path: "/hello" });
      const sockets = await Promise.all([ctx.ws("/echo"), ctx.ws("/echo"), ctx.ws("/proto", { protocols: ["chat"] })]);
      ctx.note(
        "all open",
        sockets.map((s) => s.opened),
      );
      sockets.forEach((s, i) => s.send(`from ${i}`));
      ctx.note("replies", await Promise.all(sockets.map((s) => s.next())));
      for (const s of sockets) s.close();
      await Promise.all(sockets.map((s) => closedOrTimeout(ctx, s)));
    },
  })),
  {
    id: "ws-message-over-32mib.sup",
    group: G,
    timeoutMs: 60_000,
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      c.send("y".repeat(33 * 1024 * 1024));
      ctx.note("close after an oversized message", await closedOrTimeout(ctx, c, 20_000));
    },
  },
  {
    id: "ws-http-still-works-after-sockets.sup",
    group: G,
    run: async (ctx) => {
      const c = await ctx.ws("/echo");
      c.send("a");
      await c.next();
      await ctx.req("plain request while a socket is open", { path: "/hello" });
      c.close();
      await closedOrTimeout(ctx, c);
      await ctx.req("pool", { path: "/__sb/pool" });
    },
  },
];
