import { expect, test } from "bun:test";
import { acceptBindingCall, registerBindingCredential, verifyScopedCredential } from "./binding-credentials";

test("a scoped credential is good for its own hosts only, port and case ignored", () => {
  const revoke = registerBindingCredential("c".repeat(48), ["B.test", "c.test"]);
  expect(verifyScopedCredential("c".repeat(48), "b.test")).toBe(true);
  expect(verifyScopedCredential("c".repeat(48), "C.TEST:8443")).toBe(true);
  expect(verifyScopedCredential("c".repeat(48), "a.test")).toBe(false);
  expect(verifyScopedCredential("c".repeat(48), "b.test.")).toBe(false);
  revoke();
});

test("a revoked, unknown, empty or missing credential is refused", () => {
  const revoke = registerBindingCredential("d".repeat(48), ["b.test"]);
  revoke();
  expect(acceptBindingCall("d".repeat(48), "b.test")).toBe(false);
  expect(acceptBindingCall("e".repeat(48), "b.test")).toBe(false);
  expect(acceptBindingCall("", "b.test")).toBe(false);
  expect(acceptBindingCall(null, "b.test")).toBe(false);
});

test("two credentials do not share hosts", () => {
  const first = registerBindingCredential("1".repeat(48), ["a.test"]);
  const second = registerBindingCredential("2".repeat(48), ["b.test"]);
  expect(acceptBindingCall("1".repeat(48), "b.test")).toBe(false);
  expect(acceptBindingCall("2".repeat(48), "b.test")).toBe(true);
  first();
  second();
});
