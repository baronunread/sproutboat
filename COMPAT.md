# Phase 0 compatibility

Porffor alpha-4 (a415d19); generated 2026-08-29T12:22:19.552Z; 3 probes per handler.

**31/31 compile, 29/31 match, median binary 0.42 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 418408 | 8660 | 195 |  |
| 02-static-json.js | yes | yes | 418416 | 7617 | 188 |  |
| 03-echo-method.js | yes | yes | 418416 | 7709 | 187 |  |
| 04-query-param.js | yes | yes | 418416 | 8078 | 190 |  |
| 05-query-default.js | yes | yes | 418416 | 8088 | 188 |  |
| 06-url-routing.js | yes | yes | 418416 | 8052 | 187 |  |
| 07-json-echo.js | yes | yes | 435088 | 8442 | 187 |  |
| 08-json-transform.js | yes | yes | 451600 | 8589 | 477 |  |
| 09-json-stringify.js | yes | yes | 418416 | 8196 | 187 |  |
| 10-uppercase.js | yes | yes | 418416 | 8033 | 213 |  |
| 11-reverse.js | yes | yes | 418408 | 8446 | 476 |  |
| 12-slugify.js | yes | yes | 534088 | 10071 | 215 |  |
| 13-regex-email.js | yes | yes | 517568 | 10015 | 214 |  |
| 14-regex-extract.js | yes | yes | 517568 | 10080 | 214 |  |
| 15-date-iso.js | yes | no | 451496 | 10596 | 247 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 451504 | 10618 | 187 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 434920 | 8410 | 188 |  |
| 18-math-stats.js | yes | yes | 468928 | 8505 | 213 |  |
| 19-header-echo.js | yes | yes | 418416 | 8071 | 242 |  |
| 20-auth-header.js | yes | yes | 418416 | 8346 | 186 |  |
| 21-response-headers.js | yes | yes | 418416 | 9683 | 186 |  |
| 22-status-created.js | yes | yes | 418416 | 7809 | 214 |  |
| 23-status-not-found.js | yes | yes | 418416 | 8156 | 187 |  |
| 24-status-no-content.js | yes | yes | 418424 | 10737 | 244 |  |
| 25-slack-command.js | yes | yes | 451600 | 8884 | 219 |  |
| 26-stripe-shape.js | yes | yes | 434944 | 8543 | 186 |  |
| 27-github-routing.js | yes | yes | 418416 | 7902 | 187 |  |
| 28-state-machine.js | yes | yes | 418416 | 8329 | 187 |  |
| 29-form-urlencoded.js | yes | yes | 435088 | 11197 | 213 |  |
| 30-content-negotiation.js | yes | yes | 434936 | 8506 | 379 |  |
| 31-web-apis.js | yes | yes | 434920 | 8212 | 215 |  |
