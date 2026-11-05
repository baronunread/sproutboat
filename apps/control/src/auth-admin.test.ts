import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each step is its own process: auth.ts caches the Better Auth instance and the
// seeded flag per process, and other test files configure it differently.
const root = join(import.meta.dir, "..", "..", "..");

async function bun(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

test("auth-admin reset-password: the dashboard password follows the current bootstrap token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sb-auth-admin-"));
  const base = {
    SPROUTBOAT_DATABASE_PATH: join(dir, "sproutboat.sqlite"),
    BETTER_AUTH_SECRET: "x".repeat(40),
    BETTER_AUTH_URL: "https://dashboard.example.test",
    SPROUTBOAT_ADMIN_EMAILS: "admin@example.test",
    SPROUTBOAT_BOOTSTRAP_USERNAME: "admin",
  };
  const signIn = (password: string) =>
    bun(
      [
        "-e",
        `import { getAuth } from "./apps/control/src/auth";
         try { await getAuth().api.signInEmail({ body: { email: "admin@example.test", password: process.env.TRY! } }); console.log("in"); }
         catch { console.log("refused"); }`,
      ],
      { ...base, SPROUTBOAT_BOOTSTRAP_TOKEN: "unused", TRY: password },
    );
  try {
    const migrate = await bun(
      [
        "-e",
        `import { getAuth } from "./apps/control/src/auth";
         import { getMigrations } from "better-auth/db/migration";
         await (await getMigrations(getAuth().options)).runMigrations();`,
      ],
      { ...base, SPROUTBOAT_BOOTSTRAP_TOKEN: "unused" },
    );
    expect(migrate.err).toBe("");

    // The restored database holds the old box's password (token-old)...
    const first = await bun(["apps/control/src/auth-admin.ts", "reset-password"], {
      ...base,
      SPROUTBOAT_BOOTSTRAP_TOKEN: "token-old-0123456789",
    });
    expect(first.out).toBe("admin password set for admin@example.test");
    expect((await signIn("token-old-0123456789")).out).toBe("in");

    // ...and the new install's control.env carries a different token.
    const second = await bun(["apps/control/src/auth-admin.ts", "reset-password"], {
      ...base,
      SPROUTBOAT_BOOTSTRAP_TOKEN: "token-new-0123456789",
    });
    expect(second.out).toBe("admin password set for admin@example.test");
    expect((await signIn("token-new-0123456789")).out).toBe("in");
    expect((await signIn("token-old-0123456789")).out).toBe("refused");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
