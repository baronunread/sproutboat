# http-sync-v0

`http-sync-v0` is the accepted local handler profile. A handler must
default-export an object with `fetch(request)` and return a `Response`. It has
no imports, no bindings, no outbound network access, and no Node or Bun API
contract. The accepted fixtures live in `tests/porffor/capabilities/`.

Unsupported syntax and API fixtures belong in `tests/porffor/rejected/`; they
will be validated by the CLI `check` command before a build can begin.
