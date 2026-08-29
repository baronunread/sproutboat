# Phase 0 compatibility

Porffor alpha-4 (a415d19); generated 2026-08-29T11:21:56.288Z; 3 probes per handler.

**30/30 compile, 28/30 match, median binary 0.37 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 368792 | 4853 | 191 |  |
| 02-static-json.js | yes | yes | 368800 | 4491 | 160 |  |
| 03-echo-method.js | yes | yes | 368800 | 4512 | 160 |  |
| 04-query-param.js | yes | yes | 368800 | 4523 | 161 |  |
| 05-query-default.js | yes | yes | 368800 | 4527 | 161 |  |
| 06-url-routing.js | yes | yes | 368800 | 4511 | 188 |  |
| 07-json-echo.js | yes | yes | 385472 | 4673 | 187 |  |
| 08-json-transform.js | yes | yes | 385472 | 4663 | 187 |  |
| 09-json-stringify.js | yes | yes | 368800 | 4524 | 186 |  |
| 10-uppercase.js | yes | yes | 368800 | 4550 | 186 |  |
| 11-reverse.js | yes | yes | 368792 | 4605 | 185 |  |
| 12-slugify.js | yes | yes | 467960 | 5421 | 187 |  |
| 13-regex-email.js | yes | yes | 451440 | 5265 | 188 |  |
| 14-regex-extract.js | yes | yes | 451440 | 5278 | 187 |  |
| 15-date-iso.js | yes | no | 401896 | 4833 | 191 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 401904 | 4847 | 186 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 368808 | 4659 | 186 |  |
| 18-math-stats.js | yes | yes | 402816 | 4942 | 188 |  |
| 19-header-echo.js | yes | yes | 368800 | 4601 | 186 |  |
| 20-auth-header.js | yes | yes | 368800 | 4603 | 185 |  |
| 21-response-headers.js | yes | yes | 368800 | 4582 | 186 |  |
| 22-status-created.js | yes | yes | 368800 | 4594 | 187 |  |
| 23-status-not-found.js | yes | yes | 368800 | 4575 | 185 |  |
| 24-status-no-content.js | yes | yes | 368808 | 4551 | 186 |  |
| 25-slack-command.js | yes | yes | 385472 | 4695 | 189 |  |
| 26-stripe-shape.js | yes | yes | 368816 | 4620 | 187 |  |
| 27-github-routing.js | yes | yes | 368800 | 4583 | 187 |  |
| 28-state-machine.js | yes | yes | 368800 | 4564 | 185 |  |
| 29-form-urlencoded.js | yes | yes | 385472 | 4679 | 186 |  |
| 30-content-negotiation.js | yes | yes | 368824 | 4603 | 186 |  |
