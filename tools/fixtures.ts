import type { RequestFixture } from "./types";

export const fixtures: RequestFixture[] = [
  {
    method: "GET",
    url: "http://localhost/?q=known&limit=5",
    headers: {
      accept: "application/json",
      authorization: "Bearer phase-zero",
      "stripe-signature": "t=1724500000,v1=0123456789abcdef",
      "x-github-event": "ping",
      "x-request-id": "request-1",
      "x-state": "idle",
    },
    body: "",
  },
  {
    method: "GET",
    url: "http://localhost/health?q=test%40example.com&limit=250",
    headers: { accept: "text/plain", "x-github-event": "push", "x-request-id": "request-2" },
    body: "",
  },
  {
    // Body is deliberately > 128 bytes: alpha-3 SIGSEGV'd the native-fetch
    // worker on bodies past ~128 B (issue #24, fixed in alpha-4). Keep it large
    // so the differential run keeps exercising that path.
    method: "POST",
    url: "http://localhost/users/42?q=3%2C5%2C8",
    headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-state": "running" },
    body: JSON.stringify({ id: 42, note: "x".repeat(200), tags: ["alpha", "beta", "gamma"], nested: { a: 1, b: 2, c: 3 } }),
  },
];
