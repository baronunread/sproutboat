import { resolve } from "node:path";

type Handler = { fetch(request: Request): Response | Promise<Response> };

export async function loadHandler(file: string): Promise<Handler> {
  const module = await import(`${Bun.pathToFileURL(resolve(file)).href}?t=${Date.now()}`);
  if (!module.default || typeof module.default.fetch !== "function") {
    throw new TypeError(`${file} must default-export an object with fetch(request)`);
  }
  return module.default;
}

export async function invokeHandler(handler: Handler, request: Request): Promise<Response> {
  const response = await handler.fetch(request);
  if (!(response instanceof Response)) throw new TypeError("handler fetch() must return a Response");
  return response;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: bun run tools/refserve.ts <handler.js> [port]");
  const handler = await loadHandler(file);
  const server = Bun.serve({
    port: Number(process.argv[3] || Bun.env.PORT || 3000),
    fetch: (request) => invokeHandler(handler, request),
  });
  console.log(`reference server: http://localhost:${server.port}`);
}
