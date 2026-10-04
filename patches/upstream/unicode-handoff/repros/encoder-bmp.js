// Reduced from the independently executed native probe: encoder-bmp
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      return Array.from(new TextEncoder().encode("caffè"));
    })();
    return new Response(JSON.stringify(result));
  },
};
