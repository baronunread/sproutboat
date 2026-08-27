export default {
  fetch(request) {
    const url = new URL(request.url);
    return new Response(url.searchParams.get("q") || "missing");
  }
};
