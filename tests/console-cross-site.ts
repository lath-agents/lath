import { assert } from "chai";
import { config, crossSiteRefusal, middleware } from "../frontend/src/middleware";
import { consoleOrigin as edgeOrigin } from "../frontend/src/app/api/_lib/origin";

/**
 * The middleware that refuses another site's writes to `/api/*`.
 *
 * A `text/plain` POST is a simple request: a page on any site can make its visitors' browsers send
 * one with no preflight, and every route reads the body as JSON whatever the type says. Behind a
 * proxy (`LATH_TRUST_PROXY=1`) each visitor is a fresh address to every per-caller bucket, so the
 * cost-bearing unsigned POSTs — a session, a prepare, the RPC proxy — become anyone's to spend.
 *
 * What it pins: a write marked `cross-site`, or carrying an `Origin` other than the console's, is
 * 403 with a JSON `{error}`; a sibling subdomain (`same-site`) is refused unless its `Origin` is the
 * console's own; the console's own pages pass, pinned (`LATH_CONSOLE_ORIGIN`) or by `Host`; a
 * request with no `Origin` — a script, Playwright's request fixture — passes; reads are untouched;
 * and the origin it compares with is `verifyAuth`'s (`runner.ts` re-exports the same function).
 *
 * Node-only: the middleware is called directly with a `Request`.
 */

const PINNED = "https://console.example";

function req(method: string, headers: Record<string, string> = {}, url = "http://127.0.0.1:3000/api/run"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "text/plain", ...headers },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
}

describe("refusing another site's writes (A-K)", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.LATH_CONSOLE_ORIGIN;
    delete process.env.LATH_CONSOLE_ORIGIN;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LATH_CONSOLE_ORIGIN;
    else process.env.LATH_CONSOLE_ORIGIN = saved;
  });

  it("runs on every API route and, of the pages, only on the four list URLs the workspace replaced", () => {
    assert.deepEqual(config, { matcher: ["/api/:path*", "/agents", "/loops", "/zeroclaw", "/market"] });
  });

  it("answers the old list URLs with a 307 into the workspace, before anything renders", () => {
    const go = (path: string) => middleware(new Request(`http://localhost:3000${path}`));
    const cases: [string, string][] = [
      ["/agents", "http://localhost:3000/"],
      ["/agents?agent=ABC", "http://localhost:3000/?item=abc"],
      ["/loops", "http://localhost:3000/"],
      ["/loops?loop=loop-x", "http://localhost:3000/?run=loop-x"],
      ["/zeroclaw", "http://localhost:3000/"],
      // The Market tab's URL (the marketplace is on the roadmap): an old link lands.
      ["/market", "http://localhost:3000/"],
    ];
    for (const [path, to] of cases) {
      const res = go(path);
      assert.isDefined(res, path);
      assert.equal(res!.status, 307, path);
      assert.equal(res!.headers.get("location"), to, path);
    }
    // An API GET and a page the workspace did not replace pass through untouched.
    assert.isUndefined(go("/api/loops"));
    assert.isUndefined(go("/zeroclaw/loop-x"));
  });

  it("refuses a write another site's page sends, with a 403 and a JSON error", async () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = middleware(req(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example" }));
      assert.isDefined(res, method);
      assert.equal(res!.status, 403, method);
      assert.equal(res!.headers.get("content-type"), "application/json");
      const body = (await res!.json()) as { error: string };
      assert.isString(body.error);
      assert.include(body.error, "own pages");
    }
  });

  it("refuses cross-site by the browser's mark alone, and a foreign Origin without it", () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    assert.isString(crossSiteRefusal(req("POST", { "sec-fetch-site": "cross-site" })));
    // An older browser sends no `Sec-Fetch-Site`, but still sends `Origin` on a cross-origin write.
    assert.isString(crossSiteRefusal(req("POST", { origin: "https://evil.example" })));
    assert.isString(crossSiteRefusal(req("POST", { origin: "null" })));
  });

  it("refuses a sibling subdomain, which the browser marks same-site", () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    assert.isString(crossSiteRefusal(req("POST", { "sec-fetch-site": "same-site", origin: "https://blog.example" })));
    assert.isString(crossSiteRefusal(req("POST", { "sec-fetch-site": "same-site" })));
    // Same host, another scheme or port, is another origin.
    assert.isString(crossSiteRefusal(req("POST", { origin: "http://console.example" })));
    assert.isString(crossSiteRefusal(req("POST", { origin: "https://console.example:8443" })));
  });

  it("passes the console's own pages, pinned", () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    assert.isNull(crossSiteRefusal(req("POST", { "sec-fetch-site": "same-origin", origin: PINNED })));
    // A same-site request whose Origin is the console's own is the console's own page.
    assert.isNull(crossSiteRefusal(req("POST", { "sec-fetch-site": "same-site", origin: PINNED })));
    assert.isUndefined(middleware(req("POST", { "sec-fetch-site": "same-origin", origin: PINNED })));
  });

  it("passes the console's own pages by Host when no origin is pinned, as dev and Playwright run", () => {
    const own = { "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:3111", host: "127.0.0.1:3111" };
    assert.isNull(crossSiteRefusal(req("POST", own, "http://127.0.0.1:3111/api/agents")));
    assert.isString(
      crossSiteRefusal(req("POST", { ...own, origin: "http://evil.example:3111" }, "http://127.0.0.1:3111/api/agents"))
    );
  });

  it("refuses a rebinding page's writes when no origin is pinned, and passes localhost and address literals", () => {
    // A page at a hostname its owner re-resolves to 127.0.0.1 is same-origin to itself: its Origin
    // and its Host agree, so comparing the two let it write to a console on localhost.
    const at = (host: string, path = "/api/run") =>
      req("POST", { "sec-fetch-site": "same-origin", origin: `http://${host}`, host }, `http://${host}${path}`);
    for (const host of ["rebind.evil.example:3000", "localhost.evil.example:3000", "127.0.0.1.nip.io:3000"]) {
      assert.include(crossSiteRefusal(at(host))!, "LATH_CONSOLE_ORIGIN", host);
    }
    // `npm run dev:devnet` (127.0.0.1), a browser at localhost, `--lan` (the machine's address), IPv6.
    for (const host of ["127.0.0.1:3000", "localhost:3000", "192.168.1.20:3000", "[::1]:3000"]) {
      assert.isNull(crossSiteRefusal(at(host)), host);
    }
    // Pinned, the hostname is the console's own and passes.
    process.env.LATH_CONSOLE_ORIGIN = "http://console.lan:3000";
    assert.isNull(crossSiteRefusal(at("console.lan:3000")));
  });

  it("passes a request with no Origin, as scripts and Playwright's request fixture send", () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    assert.isNull(crossSiteRefusal(req("POST")));
    assert.isNull(crossSiteRefusal(req("DELETE")));
    // Node's own fetch marks a request `sec-fetch-mode: cors` and nothing else.
    assert.isNull(crossSiteRefusal(req("POST", { "sec-fetch-mode": "cors" })));
  });

  it("leaves reads alone, wherever they come from", () => {
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.isNull(
        crossSiteRefusal(req(method, { "sec-fetch-site": "cross-site", origin: "https://evil.example" })),
        method
      );
    }
  });

  it("refuses rather than guesses when the pinned origin does not parse", () => {
    process.env.LATH_CONSOLE_ORIGIN = "not a url";
    assert.include(crossSiteRefusal(req("POST", { origin: PINNED }))!, "LATH_CONSOLE_ORIGIN");
  });

  it("compares with the origin verifyAuth uses", () => {
    // `runner.ts` re-exports the function the middleware imports, so the two cannot drift.
    process.env.LATH_RPC_URL ??= "https://rpc.invalid";
    const { consoleOrigin } = require("../frontend/src/app/api/_lib/runner");
    assert.strictEqual(consoleOrigin, edgeOrigin);
    process.env.LATH_CONSOLE_ORIGIN = PINNED;
    assert.deepEqual(edgeOrigin(), { domain: "console.example", uri: PINNED });
  });
});
