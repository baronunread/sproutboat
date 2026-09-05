export default {
  fetch() {
    return new Response(process.cwd());
  },
};
