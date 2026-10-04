// Reduced from the independently executed native probe: json-quoted-key
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      const value = {};
      value['a"b'] = 1;
      return new Response(JSON.stringify(value));
    })();
    return new Response(JSON.stringify(result));
  },
};
