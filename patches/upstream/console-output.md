# Native fetch drops handler console output when stdout is not a TTY (#165)

**Version:** `alpha-5` @ `1f4ae4ae`, `compiler/render.js`, native-fetch build.

A handler's `console.log` / `console.error` reaches `__Porffor_printString`,
which writes to **stdout** via `printf`. When stdout is a pipe or a file (a
service manager, a container, anything but an interactive terminal) the C
runtime makes it fully buffered, and the native-fetch server loop never
returns, so `fflush` / `exit`-time flush never happens. The output is simply
lost: no error, nothing on stdout or stderr, during the run or after a clean
signal. Porffor's own banner and diagnostics go to stderr, so only the
handler's logs disappear.

**Local patch** (`@sproutboat/toolchain`'s `patchRenderJs` in
`packages/toolchain/src/patch.ts`): in
`porf_native_fetch_runtime_init`, `dup2(2, 1)` to route stdout at the handler's
`console` to stderr, and `setvbuf(stdout, NULL, _IONBF, 0)` so records appear as
they happen.

**Upstream shape** (rewrite before filing, per `AI_POLICY`; file as an issue):
the native-fetch server should flush stdout (line-buffered at least), or send
`console` to stderr as most server runtimes do. A long-lived server that
silently swallows every log line until it exits is a sharp edge for anyone
running a compiled handler under a supervisor.

Repro: `porf native` a handler with `console.log("x")` in `fetch`, run it with
stdout redirected to a file, hit it: the file stays empty.
