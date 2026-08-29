# Phase 0 compatibility

Porffor alpha-3 (03b6b54); generated 2026-08-27T20:42:16.508Z; 3 probes per handler.

**30/30 compile, 28/30 match, median binary 0.37 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 368792 | 4554 | 194 |  |
| 02-static-json.js | yes | yes | 368800 | 4989 | 187 |  |
| 03-echo-method.js | yes | yes | 368800 | 4775 | 186 |  |
| 04-query-param.js | yes | yes | 368800 | 4863 | 159 |  |
| 05-query-default.js | yes | yes | 368800 | 4712 | 161 |  |
| 06-url-routing.js | yes | yes | 368800 | 4910 | 187 |  |
| 07-json-echo.js | yes | yes | 368960 | 4934 | 186 |  |
| 08-json-transform.js | yes | yes | 385472 | 4946 | 188 |  |
| 09-json-stringify.js | yes | yes | 368800 | 4754 | 187 |  |
| 10-uppercase.js | yes | yes | 368800 | 4901 | 159 |  |
| 11-reverse.js | yes | yes | 368792 | 4700 | 186 |  |
| 12-slugify.js | yes | yes | 467960 | 5682 | 188 |  |
| 13-regex-email.js | yes | yes | 451440 | 5668 | 187 |  |
| 14-regex-extract.js | yes | yes | 451440 | 5628 | 159 |  |
| 15-date-iso.js | yes | no | 401896 | 5108 | 160 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-01T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 401904 | 5165 | 187 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":1}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 368808 | 4677 | 159 |  |
| 18-math-stats.js | yes | yes | 402816 | 4929 | 158 |  |
| 19-header-echo.js | yes | yes | 368800 | 4542 | 186 |  |
| 20-auth-header.js | yes | yes | 368800 | 4653 | 158 |  |
| 21-response-headers.js | yes | yes | 368800 | 4532 | 158 |  |
| 22-status-created.js | yes | yes | 368800 | 4536 | 160 |  |
| 23-status-not-found.js | yes | yes | 368800 | 4536 | 186 |  |
| 24-status-no-content.js | yes | yes | 368808 | 4559 | 187 |  |
| 25-slack-command.js | yes | yes | 385472 | 4716 | 157 |  |
| 26-stripe-shape.js | yes | yes | 368816 | 4623 | 186 |  |
| 27-github-routing.js | yes | yes | 368800 | 4591 | 159 |  |
| 28-state-machine.js | yes | yes | 368800 | 4590 | 190 |  |
| 29-form-urlencoded.js | yes | yes | 385472 | 4822 | 166 |  |
| 30-content-negotiation.js | yes | yes | 368824 | 4794 | 166 |  |
