import { expect, test } from "bun:test";
import { readJsonBody, readJsonObject, rejectOversizeBody } from "./body";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://control.test/x", { method: "POST", body, headers });

test("rejectOversizeBody: 413 over 1 MiB unless multipart", async () => {
  const big = { "content-length": String(1024 * 1024 + 1) };
  const response = rejectOversizeBody(post("x", { ...big, "content-type": "application/json" }));
  expect(response?.status).toBe(413);
  expect(rejectOversizeBody(post("x", { ...big, "content-type": "multipart/form-data; boundary=a" }))).toBeNull();
  expect(rejectOversizeBody(post("x", { "content-length": "1024" }))).toBeNull();
  expect(rejectOversizeBody(post("x"))).toBeNull();
});

test("readJsonBody: parses within the cap, null past it or when malformed", async () => {
  expect(await readJsonBody(post(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
  expect(await readJsonBody(post(JSON.stringify({ a: "x".repeat(100) })), 50)).toBeNull();
  expect(await readJsonBody(post("{nope"))).toBeNull();
  expect(await readJsonBody(new Request("http://control.test/x", { method: "POST" }))).toBeNull();
});

test("readJsonBody enforces the cap on a stream without a content-length", async () => {
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode("1".repeat(20_000)));
      controller.close();
    },
  });
  // SAFETY: duplex is required for streamed request bodies but missing from RequestInit typings.
  const request = new Request("http://control.test/x", { method: "POST", body: stream, duplex: "half" } as RequestInit);
  expect(await readJsonBody(request)).toBeNull();
});

test("readJsonObject: {} for non-objects", async () => {
  expect(await readJsonObject(post("[1]"))).toEqual({});
  expect(await readJsonObject(post("nope"))).toEqual({});
  expect(await readJsonObject(post('{"a":"b"}'))).toEqual({ a: "b" });
});
