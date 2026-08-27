export default {
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path.startsWith("/users/")) return new Response(path.slice(7));
    return new Response("home");
  }
};
