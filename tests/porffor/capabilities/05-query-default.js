export default {
  fetch(request) {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get("limit") || "10");
    return Response.json({ limit: Math.min(Math.max(limit, 1), 100) });
  }
};
