class Buf extends Uint8Array {
  toString(enc) {
    return enc === "hex" ? "01ff" : "other";
  }
}
const K = {
  taShadow: async () => {
    const b = new Buf(2);
    b[0] = 1;
    b[1] = 255;
    return b.toString("hex");
  },
  fetchThen: async () => {
    const p = fetch("http://127.0.0.1:18080/health");
    return "then is " + typeof p.then;
  },
  fetchRejects: async () => {
    let how = "resolved";
    try {
      const p = fetch("http://127.0.0.1:1/");
      how = "returned " + typeof p.then;
      await p;
    } catch (e) {
      how += ", rejected/thrown: " + e.name;
    }
    return how;
  },
  fetch204: async () => {
    const r = await fetch("http://127.0.0.1:13000/wd_items?id=lt.0", { method: "DELETE" });
    return "status " + r.status;
  },
  captureStackTrace: async () => typeof Error.captureStackTrace,
};
export default {
  async fetch(req) {
    const k = new URL(req.url).searchParams.get("k");
    try {
      return new Response(String(await K[k]()));
    } catch (e) {
      return new Response("THROW " + e.name + ": " + e.message);
    }
  },
};
