# abi-v1

The edge router and worker exchange one binary frame per request and response.
Each frame is a four-byte big-endian payload length followed by UTF-8 JSON.
The payload carries the ABI version, kind, headers, and body; request frames
also carry an absolute HTTP(S) URL and uppercase method, while responses carry
a status in the 100–599 range.

Frames are bounded to 1 MiB, request and response bodies to 256 KiB, and
headers to 64 values. Malformed or oversized frames are rejected before they
reach the worker.
