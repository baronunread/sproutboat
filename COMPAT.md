# Phase 0 compatibility

Porffor alpha-17 (731f1b2); generated 2026-10-11T10:13:12.165Z; 3 probes per handler.

**32/32 compile, 30/32 match, median binary 1.50 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 1497640 | 11284 | 201 |  |
| 02-static-json.js | yes | yes | 1497648 | 7648 | 186 |  |
| 03-echo-method.js | yes | yes | 1497648 | 12684 | 187 |  |
| 04-query-param.js | yes | yes | 1497648 | 13321 | 189 |  |
| 05-query-default.js | yes | yes | 1497648 | 7765 | 189 |  |
| 06-url-routing.js | yes | yes | 1497648 | 6378 | 215 |  |
| 07-json-echo.js | yes | yes | 1497648 | 6951 | 190 |  |
| 08-json-transform.js | yes | yes | 1497648 | 10438 | 242 |  |
| 09-json-stringify.js | yes | yes | 1497648 | 8336 | 190 |  |
| 10-uppercase.js | yes | yes | 1497648 | 10160 | 191 |  |
| 11-reverse.js | yes | yes | 1497640 | 9135 | 195 |  |
| 12-slugify.js | yes | yes | 1514168 | 8559 | 188 |  |
| 13-regex-email.js | yes | yes | 1497648 | 8618 | 214 |  |
| 14-regex-extract.js | yes | yes | 1497648 | 8633 | 188 |  |
| 15-date-iso.js | yes | no | 1514200 | 8640 | 190 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 1514208 | 8435 | 188 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 1497640 | 8896 | 214 |  |
| 18-math-stats.js | yes | yes | 1564640 | 9668 | 186 |  |
| 19-header-echo.js | yes | yes | 1497648 | 7869 | 396 |  |
| 20-auth-header.js | yes | yes | 1497648 | 7259 | 186 |  |
| 21-response-headers.js | yes | yes | 1497648 | 8020 | 214 |  |
| 22-status-created.js | yes | yes | 1497648 | 6759 | 186 |  |
| 23-status-not-found.js | yes | yes | 1497648 | 7409 | 187 |  |
| 24-status-no-content.js | yes | yes | 1497656 | 6430 | 187 |  |
| 25-slack-command.js | yes | yes | 1497648 | 6288 | 186 |  |
| 26-stripe-shape.js | yes | yes | 1497664 | 5976 | 186 |  |
| 27-github-routing.js | yes | yes | 1497648 | 6038 | 186 |  |
| 28-state-machine.js | yes | yes | 1497648 | 6081 | 187 |  |
| 29-form-urlencoded.js | yes | yes | 1497648 | 6103 | 187 |  |
| 30-content-negotiation.js | yes | yes | 1497656 | 5905 | 184 |  |
| 31-web-apis.js | yes | yes | 1497640 | 6070 | 187 |  |
| 32-date-offset.js | yes | yes | 1514208 | 5893 | 186 |  |
