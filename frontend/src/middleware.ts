/**
 * Refuses another site's writes to this console's API.
 *
 * Several unsigned POSTs cost the operator money or a shared budget: `/api/run` starts a model
 * session, a `prepare` spends one of the server's prepared transactions, `/api/rpc` spends the
 * provider's quota. A page on any other site can send them from its visitors' browsers: a `fetch`
 * with a `text/plain` body is a *simple* request, which a browser sends with no CORS preflight, and
 * the routes read the body with `req.json()` whatever its content type says. Each visitor is then
 * a fresh address to every per-caller bucket once `LATH_TRUST_PROXY=1` makes the address count —
 * the attacker's traffic arrives from everyone else's IP.
 *
 * So a state-changing method is refused when the browser says the request comes from another
 * site's page (`Sec-Fetch-Site: cross-site`), or when it carries an `Origin` that is not this
 * console's — which also refuses a sibling subdomain (`same-site`), since a `Sec-Fetch-Site` of
 * `same-site` is a different origin by definition. The console's origin is `consoleOrigin`, the
 * answer `verifyAuth` compares a signed message's domain with, so the two checks cannot
 * disagree about where the console is: `LATH_CONSOLE_ORIGIN` when set, else the request's `Host`.
 *
 * Unset, the request's `Host` is believed only when DNS cannot point it elsewhere: `localhost` or an
 * IP literal (`unrebindable`). A page on a hostname its owner re-resolves to this machine — DNS
 * rebinding — is same-origin to itself, so its `Origin` and its `Host` agree and the comparison
 * alone let its writes through to a console on localhost. That page's `Host` is its own hostname,
 * which is never one of those, so `npm run dev:devnet` (127.0.0.1), `--lan` (the machine's address)
 * and the Playwright server pass, and a console served on a hostname has to say which one.
 *
 * A request with neither header passes. That is a client outside a browser — `scripts/seed.ts`,
 * Playwright's request fixture, curl — which Node's `fetch` sends without either, and which no web
 * page can make a visitor's browser send: a browser marks every cross-origin write with `Origin`.
 * Those callers are bounded by the routes' own limits, as they always were. Reads (`GET`, `HEAD`,
 * `OPTIONS`) are not touched.
 *
 * Edge runtime: this imports only `./app/api/_lib/origin`, which imports nothing. `process.env`
 * is read per request, and under `next start` the edge sandbox's `process.env` is the server
 * process's at run time, so `LATH_CONSOLE_ORIGIN` set when the console starts is the one used.
 * No `next/server` import either: Next accepts a plain `Response`, and returning nothing lets the
 * request through, which keeps this file loadable by a node-only suite (`tests/console-cross-site.ts`).
 */
import { legacyRedirect } from "./lib/workspace";
import { consoleOrigin } from "./app/api/_lib/origin";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Incoming = { method: string; url?: string; headers: { get(name: string): string | null } };

/**
 * Whether a `Host` (port and all) is a name DNS cannot repoint: `localhost`, or an IPv4 or IPv6
 * literal. Every other name is one whose owner chooses what it resolves to, this machine included.
 */
export function unrebindable(authority: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${authority}`).hostname;
  } catch {
    return false;
  }
  return hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || /^\[[0-9a-f:.]+\]$/i.test(hostname);
}

/** Why this request is refused, or `null` when it may go on to its route. */
export function crossSiteRefusal(req: Incoming): string | null {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return null;
  const site = req.headers.get("sec-fetch-site")?.trim().toLowerCase() ?? null;
  if (site === "cross-site") return "this console's API accepts writes from its own pages only";
  const origin = req.headers.get("origin")?.trim() ?? null;
  if (origin === null) {
    // A browser that marks a request `same-site` also sends its `Origin`; one without is not a
    // request this console's own pages make, and is not let through on the absence.
    return site === "same-site" ? "this console's API accepts writes from its own pages only" : null;
  }
  const own = consoleOrigin(req);
  // A console that cannot say where it is cannot tell its own pages from another site's.
  if (!own) return "this console does not know its own origin; set LATH_CONSOLE_ORIGIN";
  // Unpinned, `own` is this request's `Host`, which a rebinding page names as freely as its `Origin`.
  if (own.uri === null && !unrebindable(own.domain)) {
    return `this console takes writes at ${own.domain.slice(0, 200)} only once LATH_CONSOLE_ORIGIN names it`;
  }
  let from: URL | null = null;
  try {
    // `Origin: null` — a sandboxed frame, a `data:` page, a cross-origin redirect — parses to
    // nothing and is refused with every other origin that is not this one.
    from = new URL(origin);
  } catch {
    from = null;
  }
  // Pinned, the whole origin — scheme and port — must match. Unpinned, the scheme is unknown (a
  // proxy may terminate TLS in front of a plain listener), so the host is compared, as `verifyAuth`
  // compares a message's URI.
  const ours = from !== null && (own.uri !== null ? from.origin === own.uri : from.host === own.domain);
  return ours ? null : `this console's API accepts writes from its own pages only, not from ${origin.slice(0, 200)}`;
}

/** The list URLs the workspace answers for. */
const LEGACY_PAGES = ["/agents", "/loops", "/zeroclaw", "/market"];

export function middleware(req: Request): Response | undefined {
  // The list URLs answer a real 307 here, before anything renders. A `redirect()` in their pages
  // cannot: the layout has already started streaming (the nav's Suspense boundary), so Next turns
  // it into a client-side redirect inside the page, and the wallet gate does not mount a page until a
  // wallet connects — `/agents` would stay on `/agents` behind the gate.
  const url = new URL(req.url);
  if (req.method === "GET" && LEGACY_PAGES.includes(url.pathname.replace(/\/+$/, ""))) {
    const to = legacyRedirect(url.pathname, url.searchParams);
    if (to) return Response.redirect(new URL(to, url), 307);
  }
  const refused = crossSiteRefusal(req);
  if (!refused) return undefined;
  return new Response(JSON.stringify({ error: refused }), {
    status: 403,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const config = { matcher: ["/api/:path*", "/agents", "/loops", "/zeroclaw", "/market"] };
