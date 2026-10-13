/**
 * A route request as the console suites send one: a real `Request` whose body arrives as bytes,
 * with no `Host`, no forwarding headers and no cookie — so the console's origin is the one
 * `./trace-dir` pins, and every header a route asks about is absent.
 *
 * A `{ json: async () => body }` stand-in is not enough: the write routes do not call
 * `req.json()`; each reads its body through the RPC proxy's `readJsonCapped`,
 * which counts the bytes off `req.body` before anything parses them, so the request has to carry a
 * stream the way one from a browser does — and a case reaches a route's cap the way a real body
 * would. A route that still calls `req.json()` (`/api/loops`) reads the same request.
 */
export function jsonRequest(body: unknown, init: { method?: string } = {}): any {
  const text = JSON.stringify(body);
  return new Request("http://localhost:3000/", {
    method: init.method ?? "POST",
    ...(text === undefined ? {} : { body: text }),
  });
}

/** A `POST` whose body is `bytes` exactly, for a case about size rather than content. */
export function rawRequest(bytes: string | Uint8Array, init: { method?: string } = {}): any {
  return new Request("http://localhost:3000/", { method: init.method ?? "POST", body: bytes });
}
