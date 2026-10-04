function run(request) {
  const path = new URL(request.url).pathname;
  if (path === "/encoder-bmp") {
    return Array.from(new TextEncoder().encode("caffè"));
  }
  if (path === "/encoder-astral") {
    return Array.from(new TextEncoder().encode("🚤"));
  }
  if (path === "/encoder-lone") {
    return Array.from(new TextEncoder().encode(String.fromCharCode(55296)));
  }
  if (path === "/encodeinto-short") {
    const dest = new Uint8Array(3);
    const result = new TextEncoder().encodeInto("🚤", dest);
    return { read: result.read, written: result.written, bytes: Array.from(dest) };
  }
  if (path === "/json-unicode") {
    const text = JSON.parse('{"id":"\ud83d\udea4"}').id;
    return { length: text.length, first: text.charCodeAt(0), second: text.charCodeAt(1) };
  }
  if (path === "/json-quoted-key") {
    const value = {};
    value['a"b'] = 1;
    return new Response(JSON.stringify(value));
  }
  if (path === "/json-lone") {
    return new Response(JSON.stringify(String.fromCharCode(55296)));
  }
  if (path === "/json-trailing") {
    let rejected = false;
    try {
      JSON.parse('{"x":1} garbage');
    } catch {
      rejected = true;
    }
    return rejected;
  }
  if (path === "/response-astral") {
    return new Response("🚤");
  }
  return "ok";
}
export default {
  port: 18082,
  fetch(request) {
    const result = run(request);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result));
  },
};
