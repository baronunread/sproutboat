// Reduced from the independently executed native probe: encoder-astral
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      return Array.from(new TextEncoder().encode("🚤"));
    })();
    return new Response(JSON.stringify(result));
  },
};
