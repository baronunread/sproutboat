export default {
  fetch() {
    return new Response("cached", { headers: { "content-type": "text/plain", "cache-control": "max-age=60" } });
  }
};
