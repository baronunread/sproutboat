// Reduced from the independently executed native probe: json-unicode
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      const text = JSON.parse('{"id":"\ud83d\udea4"}').id;
      return { length: text.length, first: text.charCodeAt(0), second: text.charCodeAt(1) };
    })();
    return new Response(JSON.stringify(result));
  },
};
