export default {
  fetch(request) {
    const values = (new URL(request.url).searchParams.get("q") || "1,2,3").split(",").map(Number);
    return new Response(String(values.reduce((sum, value) => sum + value, 0)));
  },
};
