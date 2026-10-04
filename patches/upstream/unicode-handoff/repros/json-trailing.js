// Reduced from the independently executed native probe: json-trailing
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      let rejected = false;
      try {
        JSON.parse('{"x":1} garbage');
      } catch {
        rejected = true;
      }
      return rejected;
    })();
    return new Response(JSON.stringify(result));
  },
};
