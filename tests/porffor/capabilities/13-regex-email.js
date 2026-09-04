export default {
  fetch(request) {
    const value = new URL(request.url).searchParams.get("q") || "";
    const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    return Response.json({ valid });
  },
};
