export default {
  fetch(request) {
    const action = new URL(request.url).searchParams.get("q") || "start";
    const transitions = { idle: { start: "running" }, running: { finish: "done", fail: "failed" } };
    let state = request.headers.get("x-state") || "idle";
    state = transitions[state] && transitions[state][action] ? transitions[state][action] : state;
    return new Response(state);
  }
};
