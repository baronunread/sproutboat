export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "hello";
    return new Response(value.toUpperCase());
  }
};
