/**
 * Where this console is, in a module the edge runtime can load.
 *
 * `src/middleware.ts` needs the same answer as `runner.ts` to refuse another site's writes.
 * Middleware runs in the edge runtime, and `runner.ts` imports `crypto`, `fs` and the SDK, so it
 * cannot be imported there; copying the function would leave two answers to one question that could
 * drift, and the one thing both checks must agree on is which origin is this console's. So
 * `consoleOrigin` lives here, with no import at all, and `runner.ts` re-exports it for every route
 * that names it from there.
 */

/**
 * What a signed message's `domain` and `URI` must name: where this console is.
 *
 * `LATH_CONSOLE_ORIGIN` when it is set — one origin, which is the only answer that does not trust
 * the request. Unset, the request's own `Host` header (or, for a request built without one, the
 * host of its URL), which is right for a console on localhost and for the Playwright server, and
 * wrong for a deployment anyone can reach other than through an edge that pins the header: `Host`
 * is sent by the client, so the runner.ts env block says to set the variable there. `null` when
 * neither is available, which `verifyAuth` refuses: a console that cannot say where it is cannot
 * tell its own messages from a lookalike's.
 *
 * Read from `process.env` at each call, never captured: under `next start` the edge sandbox builds
 * its `process.env` from the server process's at run time (only `NEXT_PUBLIC_*` and `next.config`'s
 * `env` are inlined at build), so a deployment that sets the variable when it starts is read.
 */
export function consoleOrigin(req?: {
  headers: { get(name: string): string | null };
  url?: string;
}): { domain: string; uri: string | null } | null {
  const pinned = process.env.LATH_CONSOLE_ORIGIN?.trim();
  if (pinned) {
    try {
      const url = new URL(pinned);
      return { domain: url.host, uri: url.origin };
    } catch {
      return null;
    }
  }
  let host = req?.headers.get("host")?.trim() || null;
  if (!host && req?.url) {
    try {
      host = new URL(req.url).host || null;
    } catch {
      host = null;
    }
  }
  // With no pinned origin the scheme is unknown — a proxy may terminate TLS in front of a plain
  // listener — so `uri` is checked by its host alone, and `null` says so.
  return host ? { domain: host, uri: null } : null;
}
