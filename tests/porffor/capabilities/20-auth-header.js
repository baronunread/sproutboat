export default {
  fetch(request) {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
    return new Response("accepted");
  }
};
