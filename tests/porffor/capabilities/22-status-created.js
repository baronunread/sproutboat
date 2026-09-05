export default {
  fetch(request) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    return new Response("created", { status: 201 });
  },
};
