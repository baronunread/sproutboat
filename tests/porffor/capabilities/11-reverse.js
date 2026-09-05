export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "drawer";
    return new Response(value.split("").reverse().join(""));
  },
};
