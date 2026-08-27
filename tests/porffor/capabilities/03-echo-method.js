export default {
  fetch(request) {
    return new Response(request.method);
  }
};
