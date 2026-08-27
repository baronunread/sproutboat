export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "2024-06-15T12:00:00Z";
    const date = new Date(value);
    return Response.json({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
  }
};
