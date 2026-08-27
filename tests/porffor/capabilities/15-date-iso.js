export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "2024-01-02T03:04:05Z";
    const date = new Date(value);
    return new Response(Number.isNaN(date.getTime()) ? "invalid date" : date.toISOString());
  }
};
