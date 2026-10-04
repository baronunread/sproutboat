// Reduced from the independently executed native probe: json-lone
export default {
  port: 18082,
  fetch() {
    return new Response(JSON.stringify(String.fromCharCode(55296)));
  },
};
