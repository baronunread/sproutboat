import { expect, test } from "bun:test";
import { USERNAME_RULE } from "./dashboard-data";

/** The forms promise "3–32 lowercase letters, digits or hyphens". Pin the ends:
 *  an earlier optional middle run also matched a single character, so the form
 *  accepted "a" and the API rejected it. */
test("USERNAME_RULE matches exactly what the forms say it does", () => {
  for (const ok of ["abc", "a-c", "a1b", "a".repeat(32), "a-b-c-9"]) {
    expect(USERNAME_RULE.test(ok)).toBe(true);
  }
  for (const bad of ["a", "ab", "a".repeat(33), "-ab", "ab-", "Abc", "a_b", "a b", ""]) {
    expect(USERNAME_RULE.test(bad)).toBe(false);
  }
});
