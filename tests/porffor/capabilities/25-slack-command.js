export default {
  async fetch(request) {
    const form = new URLSearchParams(await request.text());
    const command = form.get("command");
    const text = (form.get("text") || "").trim();
    if (command !== "/deploy") return new Response("unknown command", { status: 400 });
    return Response.json({ response_type: "ephemeral", text: text ? "Deploying " + text : "Missing target" });
  },
};
