import value from "./value.js";

export default {
  fetch() {
    return new Response(value);
  }
};
