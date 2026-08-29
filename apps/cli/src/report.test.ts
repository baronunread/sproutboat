import { expect, test } from "bun:test";
import { printDeployReport } from "./report";
import type { ArtifactManifest } from "../../../packages/artifact/src/manifest";

const manifest: ArtifactManifest = {
  schemaVersion: 2, project: "hello", target: "linux-x86_64", runtime: "native-fetch",
  capabilityProfile: "http-sync-v0", porfforVersion: "alpha-4 (a415d19)", esbuildVersion: "0.28.2",
  buildImage: "ghcr.io/baronunread/sproutboat/build@sha256:" + "a".repeat(64),
  sourceHash: "sha256:a", binaryHash: "sha256:b", binarySize: 2048, builtAt: "2026-08-29T00:00:00.000Z",
};

function capture(fn: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { fn(); } finally { console.log = orig; }
  return lines.join("\n");
}

test("deploy report: files table, sizes, and env bindings", () => {
  const out = capture(() => printDeployReport(
    { name: "hello", main: "src/index.js", compatibility_date: "2026-08-26", vars: { GREETING: "hej", N: "3" } },
    manifest, new Uint8Array(2048), 512,
  ));
  expect(out).toContain("🌱 sproutboat");
  expect(out).toContain("Porffor alpha-4 (a415d19)");
  expect(out).toContain("2.00 KiB");        // worker size
  expect(out).toContain("512 B");           // manifest size
  expect(out).toContain("Total upload: 2.50 KiB");
  expect(out).toContain("env.GREETING");
  expect(out).toContain('"hej"');
  expect(out).toContain("env.N");
});

test("deploy report: no vars -> hint, not a table", () => {
  const out = capture(() => printDeployReport(
    { name: "h", main: "s", compatibility_date: "2026-08-26" }, manifest, new Uint8Array(10), 10,
  ));
  expect(out).toContain("(none — add [vars] to sproutboat.jsonc)");
  expect(out).not.toContain("env.");
});
