function getRequestHeader(name) {
  const value = requestHeaders[String(name).toLowerCase()];
  return value === undefined ? null : value;
}

function requestText() { return requestBody; }
function requestJson() { return JSON.parse(requestBody); }

function makeRequest(input) {
  requestHeaders = input["headers"] || {};
  requestBody = input["body"] || "";
  return {
    method: input["method"] || "GET",
    url: input["url"] || "http://localhost/",
    body: requestBody
  };
}

function makeResponse(body, init) {
  const headers = init && init["headers"] ? init["headers"] : {};
  responseContentType = headers["content-type"] === undefined ? null : headers["content-type"];
  return {
    body: body === null || body === undefined ? "" : String(body),
    status: init && init["status"] ? init["status"] : 200
  };
}

function makeJsonResponse(value, init) {
  const options = init || {};
  const headers = options["headers"] || {};
  headers["content-type"] = "application/json;charset=utf-8";
  options["headers"] = headers;
  return makeResponse(JSON.stringify(value), options);
}

/*__HANDLER_SOURCE__*/

function printResponse(response) {
  const output = {
    status: response["status"],
    headers: { "content-type": responseContentType },
    body: response["body"]
  };
  console.log(JSON.stringify(output));
}

const { read } = __Porffor_dlopen("/*__LIBC_PATH__*/", {
  read: { parameters: ["i32", "buffer", "i32"], result: "i32" }
});
const inputBuffer = new ArrayBuffer(8192);
const inputBytes = new Uint8Array(inputBuffer);
const inputLength = read(0, inputBuffer, 8191);
let inputText = "";
for (let i = 0; i < inputLength; i++) inputText += String.fromCharCode(inputBytes[i]);
const input = JSON.parse(inputText);
let requestHeaders = {};
let requestBody = "";
let responseContentType = null;
const result = __fetch(makeRequest(input));
if (result && typeof result.then === "function") result.then(printResponse);
else printResponse(result);
