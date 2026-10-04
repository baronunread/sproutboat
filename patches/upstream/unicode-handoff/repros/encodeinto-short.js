// Reduced from the independently executed native probe: encodeinto-short
export default {
  port: 18082,
  fetch() {
    const result = (() => {
      const dest = new Uint8Array(3);
      const result = new TextEncoder().encodeInto("🚤", dest);
      return { read: result.read, written: result.written, bytes: Array.from(dest) };
    })();
    return new Response(JSON.stringify(result));
  },
};
