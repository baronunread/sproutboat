import { expect, test } from "bun:test";
import { edgeIdleTimeoutSeconds } from "./idle-timeout";

test("connections stay open past the request deadline, so the edge's 504 reaches the client", () => {
  expect(edgeIdleTimeoutSeconds(30_000)).toBe(35);
  expect(edgeIdleTimeoutSeconds(1_500)).toBe(7);
});

test("a request timeout beyond Bun's 255-second maximum is clamped to it", () => {
  expect(edgeIdleTimeoutSeconds(600_000)).toBe(255);
});
