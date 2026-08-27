# Node enrollment v1

Provisioning creates an explicit enrollment request with a stable lowercase
node name, a provider-neutral region, one of `all-in-one`, `control`, or
`edge`, the `x86_64` target architecture, and a public enrollment key. The
control plane validates and records that request before issuing any long-lived
node credential. Knowing the API address alone is never sufficient to join a
node.
