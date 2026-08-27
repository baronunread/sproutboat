export default {
  async fetch(request) {
    const value = request.body ? await request.json() : {};
    return Response.json(value);
  }
};
