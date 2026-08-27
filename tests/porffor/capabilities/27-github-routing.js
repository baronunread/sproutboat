export default {
  fetch(request) {
    const event = request.headers.get("x-github-event") || "unknown";
    if (event === "push") return new Response("queue-build");
    if (event === "pull_request") return new Response("preview");
    if (event === "ping") return new Response("pong");
    return new Response("ignored", { status: 202 });
  }
};
