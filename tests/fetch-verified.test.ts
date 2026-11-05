import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs install.sh's real fetch_verified (extracted with sed) against a local server.
const payload = "sproutboat pinned dependency payload\n";
let dir = "";
let server: ReturnType<typeof Bun.serve>;
let helper = "";

async function run(dest: string, hash: string, algo?: string) {
  const script = [
    "set -euo pipefail",
    'die() { echo "DIE: $*" >&2; exit 1; }',
    helper,
    `fetch_verified "http://127.0.0.1:${server.port}/file" "$1" "$2" ${algo ?? ""}`,
  ].join("\n");
  const proc = Bun.spawn(["bash", "-c", script, "bash", dest, hash], { stdout: "pipe", stderr: "pipe" });
  const [stderr] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode, stderr };
}

describe("install.sh fetch_verified", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "sb-fetch-"));
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(payload) });
    const sed = Bun.spawnSync(["sed", "-n", "/^fetch_verified() {/,/^}/p", "install.sh"]);
    helper = sed.stdout.toString();
    await writeFile(join(dir, ".keep"), "");
  });
  afterAll(async () => {
    server.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("extracted the function", () => {
    expect(helper).toContain("fetch_verified() {");
  });

  for (const algo of ["sha256", "sha512"]) {
    const hash = createHash(algo).update(payload).digest("hex");
    test(`${algo}: matching hash installs the file`, async () => {
      const dest = join(dir, `ok-${algo}`);
      const r = await run(dest, hash, algo);
      expect(r.code).toBe(0);
      expect(await Bun.file(dest).text()).toBe(payload);
      expect(existsSync(`${dest}.part`)).toBe(false);
    });
    test(`${algo}: mismatch fails and leaves no file`, async () => {
      const dest = join(dir, `bad-${algo}`);
      const wrong = "0".repeat(hash.length);
      const r = await run(dest, wrong, algo);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain(`expected ${wrong}`);
      expect(r.stderr).toContain(`got ${hash}`);
      expect(existsSync(dest)).toBe(false);
      expect(existsSync(`${dest}.part`)).toBe(false);
    });
  }
});
