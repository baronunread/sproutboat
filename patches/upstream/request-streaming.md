# Draft H: native-fetch request streaming for large direct transfers

Do not file this on Porffor's side from this workspace. Bring it to the
maintainer only after reviewing and rewriting it by hand per `AI_POLICY`.

The pinned alpha-5 native server (`compiler/uwebsockets.js`) creates a
`PendingRequest`, appends every `res->onData` chunk to `pending->body`, and only
calls `handle_request` once `last` is true. Raising the body cap allows a large
upload, but allocates the whole upload before application code or a binding can
see it. A Sproutboat transfer ticket can bypass JavaScript at the deployed
edge and broker, but a single-binary standalone sprout still has no equivalent
way to consume a request incrementally.

What would help: a native-fetch facility to register a path or request hook
before `PendingRequest::body` accumulation, consume `onData` chunks with
backpressure, and finish or abort without calling the JS handler. A streaming
`Request.body` interface would be more general, but a bounded native hook is
enough for direct file-to-storage transfers. The hook needs an explicit byte
limit, disconnect cleanup, and a way to stream a response or file range without
materializing it as a JS `Response` body. This is separate from the existing
WHATWG Streams discussion: the memory spike occurs in the native HTTP ingress
before a JavaScript stream could be constructed.

Standalone-side Sproutboat work would still be required for ticket validation,
storage writes, and cleanup. No Porffor issue or PR was opened for this note.

Implementation boundary in the pinned build: `compiler/index.js` compiles the
generated Sproutboat C bundle into `porffor.o`, then compiles the uWebSockets
shim as a separate C++ translation unit. The shim has to select the transfer
route before `alloc_request_url` and `collect_headers`, not merely before
`PendingRequest::body.append`, or a large request still crosses the JS heap.
An early hook would receive the method, path, relevant headers, each body
chunk, and the abort event. It must be able to stop ordinary handler dispatch,
reject oversized `Content-Length` before reading, cap chunked bodies while
reading, and pause or resume reads when the file sink cannot keep up. It also
needs a bounded file-response path for GET, HEAD, and byte ranges.

The Sproutboat bridge is distinct from the Porffor hook. Its embedded R2
helpers in `transport-embedded.js` are currently `static` C functions, so the
C++ shim cannot link against them directly. A standalone implementation would
export a narrow C ABI from the generated object for claiming a one-use ticket,
opening an exclusive temporary file, committing a SHA-256-addressed blob and
SQLite metadata, and aborting with cleanup. Ticket creation would have to be
implemented in the embedded R2 dispatch too. This bridge must preserve the
same binding scoping, expiry, method checks, maximum bytes, expected hash,
atomic metadata behavior, and immutable blob generations as the broker route.
It should keep the normal 1 MiB native-fetch request cap unchanged.

The broker and deployed edge direct-transfer path does not depend on this
native hook. Until the standalone bridge is implemented and load-tested, a
single-binary sprout should use multipart uploads with bounded part sizes;
raising `SB_REQUEST_BODY_MAX` alone does not make single-PUT uploads bounded.
