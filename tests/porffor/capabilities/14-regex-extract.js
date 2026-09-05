export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "order-42";
    const match = /^([a-z]+)-(\d+)$/.exec(value);
    return Response.json(match ? { kind: match[1], id: Number(match[2]) } : null);
  },
};
