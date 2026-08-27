import { createMiddleware, createStart } from "@tanstack/react-start";
import { redirect } from "@tanstack/react-router";

const protectedPaths = new Set(["/", "/projects", "/deployments", "/profile", "/settings"]);

const requireSession = createMiddleware().server(async ({ next, request }) => {
  if (protectedPaths.has(new URL(request.url).pathname) && !/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get("cookie") || "")) {
    throw redirect({ to: "/login" });
  }
  return next();
});

export const startInstance = createStart(() => ({ requestMiddleware: [requireSession] }));
