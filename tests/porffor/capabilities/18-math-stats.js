export default {
  fetch(request) {
    const values = (new URL(request.url).searchParams.get("q") || "2,4,8").split(",").map(Number);
    const total = values.reduce((sum, value) => sum + value, 0);
    return Response.json({ min: Math.min(...values), max: Math.max(...values), mean: total / values.length });
  },
};
