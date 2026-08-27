export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "Hello, Edge World!";
    const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return new Response(slug);
  }
};
