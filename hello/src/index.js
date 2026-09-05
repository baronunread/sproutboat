export default {
  fetch(request) {
    const name = new URL(request.url).searchParams.get("name");
    return new Response(name ? `${env.GREETING}, ${name}` : env.GREETING);
  },
};
