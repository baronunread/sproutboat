# Retracted environment-access finding

**Draft C, formerly in the platform note ("env access for handlers"), cut.** Its premise,
"native-fetch handler JS has no way to read the process environment", is
false: handler code can already call `getenv` today via an inline `Porffor.c`
block (the exact mechanism sproutboat's own bindings use), verified with a
real `porf native` build (`getenv("SB_TEST_ENV")` from handler-level
`Porffor.c` sees the process environment correctly). Not upstream's problem
to solve; if a nicer surface than raw `Porffor.c` is ever wanted, that's a
sproutboat-side helper, not a Porffor gap.
