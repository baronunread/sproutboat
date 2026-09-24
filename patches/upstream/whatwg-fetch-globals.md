# Missing WHATWG surface in native fetch (Draft A)

**Title:** native-fetch: `URLSearchParams` and static `Response.json` missing

alpha-5 (`1f4ae4a`), `porf native`, `export default { fetch }`.

## 1. no `URLSearchParams` / `URL.prototype.searchParams`

`runtime/fetch-globals.js`'s `URL` has `href`/`origin`/`pathname`/`search`/`toString`
but no `searchParams` and no `URLSearchParams` class.

```js
export default {
  port: 3000,
  fetch(request) {
    return new Response(new URL(request.url).searchParams.get("q") ?? "none");
  },
};
```

```
$ ./handler & curl 'localhost:3000/?q=hi'
Uncaught ReferenceError: URLSearchParams is not defined
```

## 2. no static `Response.json`

Instance `Response.prototype.json()` exists; the static builder
`Response.json(data, init)` (WHATWG / workerd / Bun / Deno) does not.

```js
export default {
  port: 3000,
  fetch() {
    return Response.json({ ok: true });
  },
};
```

→ `Uncaught TypeError`

## notes

- Query params and JSON responses are core to any handler; without these the
  native-fetch surface can't match "write a Worker".
- We have local polyfills for both (matching the `Porffor.array` / `Porffor.type`
  idioms in the file). `URLSearchParams` is a read-mostly subset:
  `get`/`getAll`/`has`/`forEach`/`toString`; no `set`/`append`/`delete`/`sort`/
  iterator/`size`/live write-back to `url.search`.
- Happy to PR into `fetch-globals.js`, or leave it if you want these as builtins.
