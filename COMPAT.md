# Phase 0 compatibility

Porffor alpha-15 (72d048d); generated 2026-10-05T00:53:02.160Z; 3 probes per handler.

**32/32 compile, 30/32 match, median binary 1.03 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 1033336 | 5383 | 303 |  |
| 02-static-json.js | yes | yes | 1033344 | 3701 | 186 |  |
| 03-echo-method.js | yes | yes | 1033344 | 3659 | 186 |  |
| 04-query-param.js | yes | yes | 1033344 | 3567 | 188 |  |
| 05-query-default.js | yes | yes | 1033344 | 3613 | 188 |  |
| 06-url-routing.js | yes | yes | 1033344 | 3447 | 176 |  |
| 07-json-echo.js | yes | yes | 1033344 | 3553 | 188 |  |
| 08-json-transform.js | yes | yes | 1033344 | 3361 | 186 |  |
| 09-json-stringify.js | yes | yes | 1033344 | 3570 | 188 |  |
| 10-uppercase.js | yes | yes | 1033344 | 3699 | 187 |  |
| 11-reverse.js | yes | yes | 1033336 | 3670 | 195 |  |
| 12-slugify.js | yes | yes | 1033352 | 3613 | 187 |  |
| 13-regex-email.js | yes | yes | 1033344 | 3767 | 186 |  |
| 14-regex-extract.js | yes | yes | 1033344 | 3613 | 158 |  |
| 15-date-iso.js | yes | no | 1049896 | 3821 | 189 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 1049904 | 3776 | 193 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 1033352 | 3671 | 187 |  |
| 18-math-stats.js | yes | yes | 1116944 | 4010 | 187 |  |
| 19-header-echo.js | yes | yes | 1033344 | 3578 | 187 |  |
| 20-auth-header.js | yes | yes | 1033344 | 3639 | 187 |  |
| 21-response-headers.js | yes | yes | 1033344 | 3620 | 186 |  |
| 22-status-created.js | yes | yes | 1033344 | 3743 | 159 |  |
| 23-status-not-found.js | yes | yes | 1033344 | 3712 | 188 |  |
| 24-status-no-content.js | yes | yes | 1033352 | 3688 | 188 |  |
| 25-slack-command.js | yes | yes | 1033344 | 3601 | 159 |  |
| 26-stripe-shape.js | yes | yes | 1033360 | 3755 | 186 |  |
| 27-github-routing.js | yes | yes | 1033344 | 3651 | 186 |  |
| 28-state-machine.js | yes | yes | 1033344 | 3551 | 187 |  |
| 29-form-urlencoded.js | yes | yes | 1033344 | 3554 | 187 |  |
| 30-content-negotiation.js | yes | yes | 1033352 | 3513 | 184 |  |
| 31-web-apis.js | yes | yes | 1033336 | 3667 | 185 |  |
| 32-date-offset.js | yes | yes | 1049904 | 3777 | 159 |  |
