# Porffor capability fixtures

`capabilities/` contains the accepted `http-sync-v0` handler fixtures. Every
file is import-free, default-exports a `fetch(request)` handler, and is run
against the fixed Bun reference probes before it is used in a Porffor
compatibility comparison.

Run the suite from the repository root:

```sh
bun run check
bun run diff
```

`rejected/` contains intentionally unsupported source shapes. The local CLI
will refuse them before bundling or compiling.
