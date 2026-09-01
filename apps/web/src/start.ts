import { createMiddleware, createStart } from "@tanstack/react-start";

// Auth is a client-side check (dashboard-data.ts `useAccount` + __root.tsx
// `AuthGate`) since this is a prerendered SPA. This middleware just threads the
// request into serverContext for any loader that wants it.
const withRequest = createMiddleware().server(({ next, request }) => next({ context: { request } }));

export const startInstance = createStart(() => ({ requestMiddleware: [withRequest] }));
