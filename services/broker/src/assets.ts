/**
 * Static-asset manifest. `sproutboat build` copies the project's `assets`
 * directory next to the artifact and writes `assets.json` (this manifest); the
 * edge serves matching files directly (assets-first, like Cloudflare), and the
 * broker's `assets.get` op backs `env.<ASSETS>.fetch(request)` for the paths
 * the worker chooses to serve itself.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export type AssetEntry = { hash: string; size: number; type: string };
/** `/absolute/posix/path` -> entry. Serialised into `assets.json`. */
export type AssetFiles = { [path: string]: AssetEntry };
export type AssetManifest = {
  /** Fallback for requests that match no file, applied by the broker. */
  notFound: "none" | "single-page-application" | "404-page";
  /** `true` = every path to the sprout first; string[] = selective (leading `!` negates). */
  runSproutFirst: boolean | string[];
  files: AssetFiles;
};

const TYPES = new Map<string, string>([
  ["html", "text/html; charset=utf-8"], ["css", "text/css; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"], ["mjs", "text/javascript; charset=utf-8"],
  ["json", "application/json; charset=utf-8"], ["map", "application/json; charset=utf-8"],
  ["txt", "text/plain; charset=utf-8"], ["xml", "application/xml; charset=utf-8"],
  ["svg", "image/svg+xml"], ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"],
  ["gif", "image/gif"], ["webp", "image/webp"], ["avif", "image/avif"], ["ico", "image/x-icon"],
  ["woff2", "font/woff2"], ["woff", "font/woff"], ["ttf", "font/ttf"], ["wasm", "application/wasm"],
  ["webmanifest", "application/manifest+json"],
]);

export function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 ? TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
}

/** Walk `dir` recursively, returning `{ "/path": {hash,size,type} }`. */
export function walkAssets(dir: string) {
  const out: AssetFiles = {};
  const recurse = (abs: string, rel: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      if (ent.name.startsWith(".")) continue;
      const childAbs = join(abs, ent.name);
      const childRel = posix.join(rel, ent.name);
      if (ent.isDirectory()) { recurse(childAbs, childRel); continue; }
      if (!ent.isFile()) continue;
      const body = readFileSync(childAbs);
      out[`/${childRel}`] = { hash: createHash("sha256").update(body).digest("hex"), size: body.byteLength, type: contentType(ent.name) };
    }
  };
  recurse(dir, "");
  return out;
}

/** Does `pathname` hit the sprout before assets, given a `runSproutFirst` spec? */
export function isSproutFirst(spec: boolean | string[], pathname: string): boolean {
  if (!Array.isArray(spec)) return spec;
  let matched = false;
  for (const raw of spec) {
    const negate = raw.startsWith("!");
    const pattern = negate ? raw.slice(1) : raw;
    if (globMatch(pattern, pathname)) matched = !negate;
  }
  return matched;
}

/** `*` matches within a segment, `**` across segments. Anchored both ends. */
function globMatch(pattern: string, path: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${rx}$`).test(path);
}
