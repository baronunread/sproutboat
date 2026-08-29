# @sproutboat/cli

The Wrangler-shaped CLI for Sproutboat. **MIT licensed** (the rest of this repo is not).

It talks to a control plane over HTTP and is endpoint-agnostic — the same binary
works against a **self-hosted** instance or the **cloud**:

```sh
sproutboat login --api-url https://control.example.com --token <admin-token>
# or per-invocation:
export SPROUTBOAT_API_URL=https://control.example.com SPROUTBOAT_TOKEN=<token>

sproutboat init hello
sproutboat deploy
sproutboat tail hello
sproutboat versions list hello
sproutboat rollback <id>
```

Credentials are keyed by API URL in `~/.config/sproutboat/credentials.json`, so
you can hold logins for several instances at once.

## Status

This lives in the monorepo for now; it will move to its own repository
(`sproutboat-cli`) so it can version and release independently of any one
control plane. It has no dependency on server internals — only the documented
`/api` contract.
