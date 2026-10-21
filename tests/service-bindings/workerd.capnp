# The reference: the same caller and callee on workerd, bound to each other.
# workerd serve workerd.capnp   (from this directory; the caller answers on :18431)
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "svc-caller", worker = .caller),
    (name = "svc-callee", worker = .callee),
  ],
  sockets = [(name = "http", address = "127.0.0.1:18431", http = (), service = "svc-caller")],
);

const caller :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "caller/src/index.js")],
  compatibilityDate = "2026-09-27",
  bindings = [
    (name = "PEER", service = "svc-callee"),
    (name = "SELF", service = "svc-caller"),
  ],
);

const callee :Workerd.Worker = (
  modules = [(name = "index.js", esModule = embed "callee/src/index.js")],
  compatibilityDate = "2026-09-27",
  bindings = [(name = "CALLER", service = "svc-caller")],
);
