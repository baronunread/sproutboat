import { createMiddleware, createStart } from "@tanstack/react-start";

// Auth is gated in __root.tsx's beforeLoad (server + client, every route). This
// middleware only threads the request into serverContext for the loaders.
const withRequest = createMiddleware().server(({ next, request }) => next({ context: { request } }));

export const startInstance = createStart(() => ({ requestMiddleware: [withRequest] }));
