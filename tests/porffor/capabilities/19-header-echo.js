export default {
  fetch(request) {
    return new Response(request.headers.get("x-request-id") || "none");
  }
};
