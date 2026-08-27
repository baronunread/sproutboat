# Phase 0 compatibility

Porffor alpha 2 (20383ef 2026-08-26); generated 2026-08-26T08:05:30.523Z; 3 probes per handler.

**30/30 compile, 11/30 match, median binary 0.28 MB**

Decision: **NO-GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 15 runtime, 4 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 253064 | 3518 | 84 |  |
| 02-static-json.js | yes | no | 253072 | 3366 | 28 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError |
| 03-echo-method.js | yes | yes | 253072 | 3402 | 82 |  |
| 04-query-param.js | yes | no | 286128 | 3589 | 29 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 05-query-default.js | yes | no | 286128 | 3931 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 06-url-routing.js | yes | yes | 286128 | 3547 | 81 |  |
| 07-json-echo.js | yes | no | 269760 | 4148 | 28 | request 1 mismatch: expected {"status":200,"body":"{}","content-type":"application/json;charset=utf-8"}, got {"status":500,"body":"native fetch promise rejected","content-type":"text/plain; charset=utf-8"} |
| 08-json-transform.js | yes | no | 269760 | 3917 | 28 | request 1 mismatch: expected {"status":200,"body":"{\"name\":\"\",\"active\":false}","content-type":"application/json;charset=utf-8"}, got {"status":500,"body":"native fetch promise rejected","content-type":"text/plain; charset=utf-8"} |
| 09-json-stringify.js | yes | yes | 269584 | 4732 | 82 |  |
| 10-uppercase.js | yes | no | 286128 | 5428 | 28 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 11-reverse.js | yes | no | 319176 | 4326 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 12-slugify.js | yes | no | 401816 | 4838 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 13-regex-email.js | yes | no | 385296 | 4768 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 14-regex-extract.js | yes | no | 401808 | 4894 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 15-date-iso.js | yes | no | 302712 | 3856 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 16-date-parts.js | yes | no | 302720 | 3824 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 17-math-sum.js | yes | no | 319176 | 4153 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 18-math-stats.js | yes | no | 353184 | 4330 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 19-header-echo.js | yes | yes | 253072 | 3365 | 82 |  |
| 20-auth-header.js | yes | yes | 253072 | 3416 | 82 |  |
| 21-response-headers.js | yes | yes | 253072 | 3359 | 82 |  |
| 22-status-created.js | yes | yes | 253072 | 3416 | 84 |  |
| 23-status-not-found.js | yes | no | 286128 | 3536 | 28 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 24-status-no-content.js | yes | yes | 253080 | 3364 | 82 |  |
| 25-slack-command.js | yes | no | 269744 | 3586 | 28 | request 1 mismatch: expected {"status":400,"body":"unknown command","content-type":null}, got {"status":500,"body":"native fetch promise rejected","content-type":"text/plain; charset=utf-8"} |
| 26-stripe-shape.js | yes | yes | 302640 | 3962 | 82 |  |
| 27-github-routing.js | yes | yes | 253072 | 3465 | 98 |  |
| 28-state-machine.js | yes | no | 286128 | 3549 | 28 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError: Cannot read property of undefined |
| 29-form-urlencoded.js | yes | no | 269744 | 3455 | 27 | request 1 mismatch: expected {"status":200,"body":"{\"name\":\"anonymous\",\"subscribed\":false}","content-type":"application/json;charset=utf-8"}, got {"status":500,"body":"native fetch promise rejected","content-type":"text/plain; charset=utf-8"} |
| 30-content-negotiation.js | yes | no | 253096 | 3469 | 27 | request 1: Error: Porffor native fetch server listening on http://127.0.0.1:43129 Uncaught TypeError |
