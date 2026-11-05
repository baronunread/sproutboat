/**
 * Operator CLI for the dashboard admin account (run by `sbctl restore`):
 *
 *   bun apps/control/src/auth-admin.ts reset-password
 *
 * Sets the admin credential account's password to the current
 * SPROUTBOAT_BOOTSTRAP_TOKEN. `ensureAdminSeeded()` only sets it when the
 * account is created, so after restoring an archive onto a fresh install the
 * dashboard kept the OLD box's password while the CLI token was the new one.
 */
import { adminEmail, ensureAdminSeeded, getAuth } from "./auth";

export async function resetAdminPassword(): Promise<string> {
  const token = process.env.SPROUTBOAT_BOOTSTRAP_TOKEN;
  const email = adminEmail();
  if (!token || !email) throw new Error("SPROUTBOAT_BOOTSTRAP_TOKEN and SPROUTBOAT_ADMIN_EMAILS must be set");
  const ctx = await getAuth().$context;
  let found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found?.user) {
    // Nothing to reset: seed the account the normal way, with this token.
    await ensureAdminSeeded();
    found = await ctx.internalAdapter.findUserByEmail(email);
    if (!found?.user) throw new Error(`no account for ${email}`);
    return email;
  }
  const password = await ctx.password.hash(token);
  const credential = (await ctx.internalAdapter.findAccounts(found.user.id)).find(
    (account) => account.providerId === "credential",
  );
  if (!credential) throw new Error(`${email} has no password account to reset`);
  await ctx.adapter.update({ model: "account", where: [{ field: "id", value: credential.id }], update: { password } });
  return email;
}

if (import.meta.main) {
  try {
    if (process.argv[2] !== "reset-password") throw new Error("usage: auth-admin.ts reset-password");
    console.log(`admin password set for ${await resetAdminPassword()}`);
  } catch (error) {
    console.error(`auth-admin: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
