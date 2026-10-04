// Reduced from the independently executed native probe: encoder-lone
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      return Array.from(new TextEncoder().encode(String.fromCharCode(55296)));
    })();
    return new Response(JSON.stringify(result));
  },
};
