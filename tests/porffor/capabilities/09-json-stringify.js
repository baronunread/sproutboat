export default {
  fetch() {
    const value = { event: "ping", attempts: [1, 2, 3], meta: { valid: true } };
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  },
};
