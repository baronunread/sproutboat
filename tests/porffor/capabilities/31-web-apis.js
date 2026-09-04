export default {
  fetch(request) {
    const url = new URL(request.url);
    const params = new URLSearchParams(url.search);
    params.set("q", (params.get("q") || "none").toUpperCase());
    params.append("tag", "x");
    params.delete("limit");
    params.sort();
    const echo = structuredClone({ protocol: url.protocol, path: url.pathname, hash: url.hash });
    return Response.json({ query: params.toString(), size: params.size, echo });
  },
};
