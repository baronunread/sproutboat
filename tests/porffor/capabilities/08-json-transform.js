export default {
  async fetch(request) {
    const value = request.body ? await request.json() : {};
    return Response.json({ name: String(value.name || "").trim(), active: !!value.active });
  },
};
