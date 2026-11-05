import { afterEach, describe, expect, test } from "bun:test";
import { descendants, listenerOwner, listeningInodes } from "./listener-owner";

const linux = process.platform === "linux";
const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill(9);
});

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

const listenScript = (port: number, reusePort = false) =>
  `Bun.listen({hostname:"127.0.0.1",port:${port},reusePort:${reusePort},socket:{data(){}}});setInterval(()=>{},1000)`;

function spawnListener(port: number, reusePort = false): Bun.Subprocess {
  const child = Bun.spawn([process.execPath, "-e", listenScript(port, reusePort)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  return child;
}

describe("listenerOwner", () => {
  test.skipIf(!linux)("a listener inside the spawned tree is owned", async () => {
    const port = freePort();
    const child = spawnListener(port);
    await waitFor(() => listeningInodes(port).size > 0);
    expect(listenerOwner(port, child.pid)).toBe("owned");
  });

  test.skipIf(!linux)("a listener inside a grandchild is owned", async () => {
    const port = freePort();
    const shell = Bun.spawn(["bash", "-c", `"${process.execPath}" -e '${listenScript(port)}'; true`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    children.push(shell);
    await waitFor(() => listeningInodes(port).size > 0);
    expect(descendants(shell.pid).length).toBeGreaterThan(1);
    expect(listenerOwner(port, shell.pid)).toBe("owned");
  });

  test.skipIf(!linux)("a listener held by this process while the root is unrelated is foreign", async () => {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    const bystander = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    children.push(bystander);
    try {
      expect(listenerOwner(port, bystander.pid)).toBe("foreign");
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(!linux)("nobody listening is none", () => {
    expect(listenerOwner(freePort(), process.pid)).toBe("none");
  });

  test.skipIf(!linux)("a second listener sharing the port is foreign", async () => {
    const port = freePort();
    const mine = spawnListener(port, true);
    await waitFor(() => listeningInodes(port).size > 0);
    spawnListener(port, true);
    await waitFor(() => listeningInodes(port).size > 1);
    expect(listenerOwner(port, mine.pid)).toBe("foreign");
  });

  test.skipIf(linux)("is unsupported without /proc/net/tcp", () => {
    expect(listenerOwner(1, process.pid)).toBe("unsupported");
  });
});
