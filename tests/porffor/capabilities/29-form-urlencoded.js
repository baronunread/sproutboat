export default {
  async fetch(request) {
    const form = new URLSearchParams(await request.text());
    return Response.json({ name: form.get("name") || "anonymous", subscribed: form.get("subscribed") === "yes" });
  },
};
