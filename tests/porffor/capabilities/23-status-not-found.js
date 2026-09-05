export default {
  fetch(request) {
    const found = new URL(request.url).searchParams.get("q") === "known";
    return found ? new Response("record") : new Response("not found", { status: 404 });
  },
};
