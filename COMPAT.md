# Phase 0 compatibility

Porffor alpha-9 (de4eb58); generated 2026-09-26T00:46:22.306Z; 3 probes per handler.

**32/32 compile, 30/32 match, median binary 0.98 MB**

Decision: **GO** (go threshold: at least 40% matching).

Failure categories: 0 compile, 0 runtime, 2 output mismatch.

| Handler | Compiles | Matches | Bytes | Compile ms | Run ms | Error |
|---|---:|---:|---:|---:|---:|---|
| 01-hello.js | yes | yes | 983384 | 4492 | 269 |  |
| 02-static-json.js | yes | yes | 983392 | 3109 | 159 |  |
| 03-echo-method.js | yes | yes | 983392 | 3103 | 159 |  |
| 04-query-param.js | yes | yes | 983392 | 3021 | 160 |  |
| 05-query-default.js | yes | yes | 983392 | 3183 | 187 |  |
| 06-url-routing.js | yes | yes | 983392 | 3075 | 160 |  |
| 07-json-echo.js | yes | yes | 983392 | 2941 | 187 |  |
| 08-json-transform.js | yes | yes | 983392 | 3102 | 160 |  |
| 09-json-stringify.js | yes | yes | 983392 | 3054 | 169 |  |
| 10-uppercase.js | yes | yes | 983392 | 2958 | 185 |  |
| 11-reverse.js | yes | yes | 983384 | 3185 | 159 |  |
| 12-slugify.js | yes | yes | 999896 | 3077 | 158 |  |
| 13-regex-email.js | yes | yes | 983392 | 3061 | 159 |  |
| 14-regex-extract.js | yes | yes | 983392 | 3116 | 160 |  |
| 15-date-iso.js | yes | no | 1016456 | 3173 | 162 | request 3 mismatch: expected {"status":200,"body":"2008-03-04T23:00:00.000Z","content-type":null}, got {"status":200,"body":"0003-05-08T00:00:00.000Z","content-type":null} |
| 16-date-parts.js | yes | no | 1016448 | 3273 | 159 | request 3 mismatch: expected {"status":200,"body":"{\"year\":2008,\"month\":3,\"day\":4}","content-type":"application/json;charset=utf-8"}, got {"status":200,"body":"{\"year\":3,\"month\":5,\"day\":8}","content-type":"application/json;charset=utf-8"} |
| 17-math-sum.js | yes | yes | 999896 | 3118 | 159 |  |
| 18-math-stats.js | yes | yes | 1083456 | 3209 | 186 |  |
| 19-header-echo.js | yes | yes | 983392 | 3107 | 159 |  |
| 20-auth-header.js | yes | yes | 983392 | 3222 | 185 |  |
| 21-response-headers.js | yes | yes | 983392 | 2985 | 186 |  |
| 22-status-created.js | yes | yes | 983392 | 3045 | 159 |  |
| 23-status-not-found.js | yes | yes | 983392 | 3077 | 163 |  |
| 24-status-no-content.js | yes | yes | 983400 | 2969 | 160 |  |
| 25-slack-command.js | yes | yes | 983392 | 3101 | 159 |  |
| 26-stripe-shape.js | yes | yes | 999920 | 3048 | 186 |  |
| 27-github-routing.js | yes | yes | 983392 | 3090 | 159 |  |
| 28-state-machine.js | yes | yes | 983392 | 3066 | 177 |  |
| 29-form-urlencoded.js | yes | yes | 983392 | 3058 | 160 |  |
| 30-content-negotiation.js | yes | yes | 983400 | 3141 | 187 |  |
| 31-web-apis.js | yes | yes | 983384 | 3123 | 161 |  |
| 32-date-offset.js | yes | yes | 1016464 | 3197 | 159 |  |
