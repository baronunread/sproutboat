export default {
  fetch(request) {
    const accept = request.headers.get("accept") || "";
    if (accept.includes("application/json")) return Response.json({ message: "hello" });
    return new Response("hello", { headers: { "content-type": "text/plain" } });
  },
};
