/**
 * Serve the built dashboard SPA from control itself.
 *
 * Used when SPROUTBOAT_DASHBOARD_DIR is set (install.sh does that for
 * SB_PROXY=external, where there is no Caddy to serve the files). It mirrors the
 * Caddy site block: `try_files {path} /_shell.html`, then `file_server`.
 */
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const TYPES = new Map(
  Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
  }),
);

const SHELL = "_shell.html";

function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot < 0 ? "" : file.slice(dot).toLowerCase();
  return TYPES.get(ext) ?? "application/octet-stream";
}

/** Whether this request is the dashboard's to answer (not an API path). */
export function isDashboardRequest(request: Request, pathname: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return !pathname.startsWith("/api/") && !pathname.startsWith("/internal/");
}

async function regularFile(path: string, root: string): Promise<number | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    // A symlink must not lead out of the dashboard directory.
    const real = await realpath(path);
    if (real !== root && !real.startsWith(root + sep)) return null;
    return info.size;
  } catch {
    return null;
  }
}

/**
 * Answer a GET/HEAD for the dashboard: the file under `dir` when it exists, the
 * prerendered shell otherwise. Returns 404 for a traversal attempt.
 */
export async function serveDashboard(request: Request, dir: string): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) {
    return new Response("not found", { status: 404 });
  }
  const base = resolve(dir);
  let root: string;
  try {
    root = await realpath(base);
  } catch {
    return new Response("not found", { status: 404 });
  }
  const wanted = resolve(join(base, decoded));
  if (wanted !== base && !wanted.startsWith(base + sep)) return new Response("not found", { status: 404 });

  let file = wanted;
  let size = await regularFile(file, root);
  if (size === null) {
    file = join(base, SHELL);
    size = await regularFile(file, root);
    if (size === null) return new Response("not found", { status: 404 });
  }
  const html = file.endsWith(".html");
  const immutable = !html && decoded.startsWith("/assets/");
  const headers = new Headers({
    "content-type": contentType(file),
    "content-length": String(size),
    "cache-control": immutable ? "public, max-age=31536000, immutable" : html ? "no-cache" : "public, max-age=3600",
  });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(Bun.file(file), { headers });
}
