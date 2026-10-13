/**
 * The tools that reach past the chain: the open web and a price feed.
 *
 * The creator wizard offers `web.search`, `web.fetch_page` and `market.prices`; without these, a
 * deployed policy that named them would get only the chain reads, and a model asked for news would
 * have to say it could not. These are keyless on purpose — DuckDuckGo's HTML endpoint and CoinGecko's public price route — so a
 * deployment with nothing but an OpenRouter key still has them. Every result is trimmed before
 * it goes back to the model: a tool result is a step in an epoch, and a whole page is not.
 */
import type { ToolDefinition } from "@lath/runtime";
import * as http from "http";
import * as https from "https";
import { isIP } from "net";
import type { Readable } from "stream";
import { addressProblem, systemLookup, type LookupFn, type PinnedAddress } from "./safe-fetch";

/** A socket's *idle* limit: how long a server may go without sending a byte. Not a deadline — each byte resets it. */
const FETCH_TIMEOUT_MS = 12_000;
/**
 * The whole of one guarded GET — the lookup, every redirect hop and the body — however the server
 * paces its bytes. The idle limit above is reset by every byte, so a server dripping one byte every
 * eleven seconds never trips it, and 2 MiB at that pace is most of a year. A tool call that never
 * returns holds its session open, and a session that has not exited holds the console's one run slot
 * (`/api/run`'s heartbeat): every other session and every loop step would wait on it.
 */
export const FETCH_DEADLINE_MS = 20_000;
const SEARCH_RESULTS = 5;
const PAGE_CHARS = 4_000;
/** Bytes read from any response before the fetch is cut. A page is text; a disk image is not. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA = "Mozilla/5.0 (compatible; Lath agent runtime)";

/**
 * Whether an address is one this server must not be talked into fetching. The model chooses
 * `web.fetch_page` URLs, and an anonymous caller chooses the prompt.
 *
 * The rule is `safe-fetch.ts` `addressProblem`, not a copy of it. A second list here would drift from
 * that one: a list that knows `::ffff:a.b.c.d` but not the other IPv6 spellings that carry an IPv4
 * address (compatible `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`), nor Teredo, site-local
 * `fec0::/10` or the RFC 6890 special-purpose IPv4 blocks, makes `http://[64:ff9b::a9fe:a9fe]/` a fetch
 * of the metadata service on a NAT64 or 6to4 network. One function means a block added for the
 * sandbox's sources is a block here too.
 */
export function isPrivateAddress(addr: string): boolean {
  return addressProblem(addr) !== null;
}

/**
 * Rejects anything but a public http(s) host, and says which address it vetted.
 *
 * The address is the point. Resolving the name here and then handing the *name* to a fetch that
 * resolves it again is a check on one answer and a connection to another: a DNS server the
 * attacker controls answers the first lookup with a public address and the second with
 * 169.254.169.254, and the guard has proved nothing (a rebinding attack, and the model picks the
 * URL). So the caller connects to exactly the address that passed, and nothing re-resolves.
 *
 * Unlike `safe-fetch.ts` `checkUrl`, plain http and any port stay allowed: a model reading the
 * news reaches pages that are not https, and the address rule, not the port, is what keeps the
 * socket off this server's own network.
 */
async function assertPublicUrl(raw: string, lookup: LookupFn): Promise<{ url: URL; pin: PinnedAddress }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are fetched");
  if (url.username || url.password) throw new Error("URLs with credentials are not fetched");
  // `URL` has already lower-cased the name and folded decimal, octal and hex IPv4 spellings
  // (`http://2130706433/`, `http://0177.0.0.1/`) into the dotted quad, so what is judged below is
  // the address the socket would open to, not the spelling the model wrote.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`${host} is not a public host`);
  }
  const family = isIP(host);
  const answers: PinnedAddress[] = family ? [{ address: host, family: family as 4 | 6 }] : await lookup(host);
  // Every answer has to be public, not just the one that will be used: a name that resolves to a
  // public address and a private one is a name whose next answer is the private one.
  if (answers.length === 0) throw new Error(`${host} is not a public host: it does not resolve`);
  for (const a of answers) {
    const problem = addressProblem(a.address);
    if (problem) throw new Error(`${host} is not a public host: ${a.address} is ${problem}`);
  }
  return { url, pin: answers[0] };
}

/** What the guarded GET needs off a response, whichever transport produced it. */
export interface Fetched {
  status: number;
  statusText: string;
  location: string | null;
  type: string;
  declared: number;
  body: Readable;
}

/**
 * The `lookup` a pinned request connects through: it answers with the vetted address and nothing
 * else, and judges that address again, by the same rule, at the moment the socket asks. The check
 * in `assertPublicUrl` is what refuses a URL; this one is what makes the pin itself unable to
 * carry an address that rule would refuse, whatever path built the request.
 */
export function pinnedLookup(pin: PinnedAddress) {
  return (_host: string, options: any, cb: any) => {
    const problem = addressProblem(pin.address);
    if (problem) {
      cb(new Error(`${pin.address} is ${problem}, which is never fetched`));
      return;
    }
    // Both callback shapes: `net` asks with `all` when it is happy-eyeballing.
    if (options && options.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  };
}

/**
 * One request, pinned to the address `assertPublicUrl` vetted.
 *
 * `node:http(s)` rather than `fetch` for one reason: it takes a `lookup`, so the socket is opened
 * to the address that passed the check instead of to whatever DNS answers next. The `Host` header
 * and TLS `servername` stay the *name*, so virtual hosts and certificate validation are unchanged
 * — this pins where the connection goes, not who it claims to be. No pooled agent: a kept-alive
 * socket is a connection to whatever the pool opened it to, not to this request's pin.
 *
 * `signal` is `get`'s deadline: when it fires the request is destroyed, and with it the socket and
 * any response already streaming, so a server that is still dripping is cut off rather than left
 * holding a socket after the tool call has given up on it.
 */
function fetchPinned(url: URL, pin: PinnedAddress, accept: string, signal?: AbortSignal): Promise<Fetched> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise<Fetched>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        // No `accept-encoding`: `fetch` decompresses for you and `node:http` does not, so the
        // request that does not ask for gzip is the one whose body is text on arrival.
        headers: { "user-agent": UA, accept, host: url.host },
        timeout: FETCH_TIMEOUT_MS,
        agent: false,
        lookup: pinnedLookup(pin) as https.RequestOptions["lookup"],
        ...(signal ? { signal } : {}),
      },
      (res) => {
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          location: (res.headers.location as string | undefined) ?? null,
          type: (res.headers["content-type"] as string | undefined) ?? "",
          declared: Number(res.headers["content-length"] ?? 0),
          body: res,
        });
      }
    );
    // A server that accepts the socket and then says nothing is cut here. This is an *idle* limit:
    // every byte resets it, so it does not bound a server that drips — `get`'s deadline does.
    req.setTimeout(FETCH_TIMEOUT_MS, () =>
      req.destroy(new Error(`${url.host} went ${FETCH_TIMEOUT_MS} ms without sending anything`))
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * Reads at most `MAX_BODY_BYTES`, then stops; the tool trims further before the model sees it.
 *
 * `signal` is `get`'s deadline. The `for await` below waits on the server for each chunk, so a
 * server that keeps the socket busy with one byte at a time is a loop with no end of its own; the
 * deadline destroys the body with its reason, which is what ends the loop with an error.
 */
async function readBounded(res: Fetched, signal?: AbortSignal): Promise<string> {
  if (res.declared > MAX_BODY_BYTES) {
    res.body.destroy();
    throw new Error(`response is ${res.declared} bytes; the limit is ${MAX_BODY_BYTES}`);
  }
  const stop = () => res.body.destroy(deadlineError(signal!));
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > MAX_BODY_BYTES) {
        chunks.push(buf.subarray(0, buf.byteLength - (total - MAX_BODY_BYTES)));
        res.body.destroy();
        break;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}

/** The deadline's reason as an `Error`, whatever the signal was aborted with. */
function deadlineError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "deadline passed"));
}

/** `p`, unless the deadline fires first; then the deadline's reason. Nothing is left listening either way. */
function beforeDeadline<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(deadlineError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(deadlineError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

/**
 * The resolver, the one-request transport and the deadline `get` uses. Injected only by the suite
 * (`tests/web-tools-ssrf.ts`), which runs a name that resolves privately, a redirect to a private
 * address and a server that drips, without a DNS server or a socket, and with a deadline short
 * enough to wait out.
 */
export interface WebGetDeps {
  lookup: LookupFn;
  request: (url: URL, pin: PinnedAddress, accept: string, signal?: AbortSignal) => Promise<Fetched>;
  deadlineMs: number;
}

/**
 * A guarded GET: public hosts only, connected to the address that was checked, each redirect
 * re-checked the same way, text-like bodies only, bounded in bytes and time. The web tools are
 * the one place the runtime opens a socket the model picked the destination for.
 *
 * "Bounded in time" means one deadline from entry to the last byte (`FETCH_DEADLINE_MS`), over the
 * lookup, every hop and the body, not the per-socket idle limit, which a server sending a byte at a
 * time resets for ever. `AgentRuntime.callTool` awaits a tool with no limit of its own
 * and `/api/run` holds the run slot until its session exits, so this deadline is what lets a session
 * that fetched a slow page end at all.
 */
export async function get(url: string, accept = "text/html", deps: Partial<WebGetDeps> = {}): Promise<string> {
  const lookup = deps.lookup ?? systemLookup;
  const request = deps.request ?? fetchPinned;
  const deadlineMs = deps.deadlineMs ?? FETCH_DEADLINE_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* the URL check below says what is wrong with it */
    }
    deadline.abort(new Error(`${host} did not finish answering in ${deadlineMs} ms`));
  }, deadlineMs);
  const signal = deadline.signal;
  try {
    let current = await beforeDeadline(assertPublicUrl(url, lookup), signal);
    for (let hop = 0; ; hop++) {
      const res = await beforeDeadline(request(current.url, current.pin, accept, signal), signal);
      // A body nobody will read is destroyed rather than drained: draining a redirect's body from a
      // server that drips would hold that socket open long after this GET had moved on or returned,
      // and with no pooled agent there is no connection worth keeping.
      if (res.status >= 300 && res.status < 400) {
        res.body.destroy();
        if (!res.location || hop >= MAX_REDIRECTS) throw new Error(`too many redirects from ${current.url.host}`);
        current = await beforeDeadline(assertPublicUrl(new URL(res.location, current.url).toString(), lookup), signal);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.body.destroy();
        throw new Error(`${res.status} ${res.statusText || "request failed"} from ${current.url.host}`);
      }
      if (res.type && !/^(text\/|application\/(json|xml|xhtml\+xml|javascript))/i.test(res.type)) {
        res.body.destroy();
        throw new Error(`${current.url.host} returned ${res.type.split(";")[0]}, not text`);
      }
      return await readBounded(res, signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Characters of a page `htmlToText` reads. The model is shown `PAGE_CHARS` of the text, so a page's
 * first half-megabyte is more than it will ever see; the 2 MiB the fetch may read is a bound on the
 * socket, not on how much markup this process works through.
 */
const TEXT_SOURCE_CHARS = 512 * 1024;
/** Characters searched for a `<title>`: it is in the `<head>`, and a page whose head is longer has none worth reading. */
const TITLE_SCAN_CHARS = 64 * 1024;

/**
 * Every `<tag …>…</tag>` of one element cut out, each leaving a space, by forward searches only.
 *
 * It was `/<script[\s\S]*?<\/script>/gi`, and a lazy match is a scan to the end of the string from
 * every opener that has no closer: a fetched page of `<script` repeated is quadratic, run on the
 * console's one event loop, and the model (or whatever text steers it) picks the page. Here each
 * opener's closer is searched from that opener and the next opener from past that closer, so no
 * character is scanned twice. An element that is never closed takes the rest of the page with it,
 * as a browser would read a `<script>` with no end. Regexes with `lastIndex` rather than `indexOf` on
 * a lower-cased copy, because lower-casing can change a string's length (`İ` becomes two units) and
 * an index into the copy would then cut the original in the wrong place.
 */
function stripElements(html: string, tag: string): string {
  const open = new RegExp(`<${tag}`, "gi");
  const close = new RegExp(`</${tag}>`, "gi");
  const kept: string[] = [];
  let at = 0;
  for (;;) {
    open.lastIndex = at;
    const start = open.exec(html);
    if (!start) {
      kept.push(html.slice(at));
      break;
    }
    kept.push(html.slice(at, start.index), " ");
    close.lastIndex = start.index + start[0].length;
    const end = close.exec(html);
    if (!end) break;
    at = end.index + end[0].length;
  }
  return kept.join("");
}

/**
 * Tags out, whitespace folded: what a model needs from a page, and nothing it does not.
 *
 * Every pattern here is linear in the page, which is the point of each one: the page is whatever a URL
 * the model chose answered with, and this runs synchronously on the console's only event loop, so a
 * super-linear pattern is a stall of every session, stream and loop timer. A catch-all `<[^>]+>` scans
 * to the end of the page from each `<` with no `>` after it — 2 MiB of `<` measures at hours — and
 * `\s*\n\s*` backtracks through every run of non-newline whitespace (`\r`, U+00A0, U+3000) that a
 * `[ \t]+` before it does not fold. A tag here ends at the next `<` as well as at `>`, so each `<` is
 * scanned at most to the next one; and every run of whitespace is folded to one space first, so the
 * newline rule only ever meets single spaces.
 */
export function htmlToText(page: string): string {
  let html = page.length > TEXT_SOURCE_CHARS ? page.slice(0, TEXT_SOURCE_CHARS) : page;
  for (const tag of ["script", "style", "noscript"]) html = stripElements(html, tag);
  return decodeEntities(html.replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n").replace(/<[^<>]+>/g, " "))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

/**
 * The text of a page's first `<title>…</title>`, or `undefined`. Searched in the first
 * `TITLE_SCAN_CHARS` only, with an opener that ends at the next `<` and a closer searched forward
 * from it: `/<title[^>]*>([\s\S]*?)<\/title>/i` over the whole page was quadratic in a page of
 * `<title` repeated, for the reason `htmlToText` gives.
 */
export function pageTitle(page: string): string | undefined {
  const head = page.length > TITLE_SCAN_CHARS ? page.slice(0, TITLE_SCAN_CHARS) : page;
  const open = /<title[^<>]*>/i.exec(head);
  if (!open) return undefined;
  const from = open.index + open[0].length;
  const close = /<\/title>/gi;
  close.lastIndex = from;
  const end = close.exec(head);
  return end ? head.slice(from, end.index) : undefined;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * DuckDuckGo's HTML results page: each hit is an `a.result__a` wrapping a `uddg=` redirect, and
 * its snippet follows in an `a.result__snippet`. Links and snippets are collected in document
 * order and paired by index, which is how the page lays them out.
 */
function parseDuckDuckGo(html: string, limit = SEARCH_RESULTS): SearchHit[] {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
    htmlToText(m[1])
  );
  const hits: SearchHit[] = [];
  links.forEach((m, i) => {
    if (hits.length >= limit) return;
    const href = decodeEntities(m[1]);
    const target = /[?&]uddg=([^&]+)/.exec(href);
    const url = target ? decodeURIComponent(target[1]) : href.startsWith("//") ? `https:${href}` : href;
    // DuckDuckGo's own ad and "more results" links share the class; skip anything not a page.
    if (!/^https?:\/\//.test(url) || /duckduckgo\.com/.test(url)) return;
    hits.push({ title: htmlToText(m[2]), url, snippet: snippets[i] ?? "" });
  });
  return hits;
}

/**
 * The three tools. `deps` is `get`'s, passed through so the suite can drive a tool end to end — a
 * fetched page through the strip, a dripping server into the deadline — with no socket; the console
 * passes nothing.
 */
export function webTools(deps: Partial<WebGetDeps> = {}): ToolDefinition[] {
  return [
    {
      name: "web.search",
      description: `Search the open web (DuckDuckGo). Returns up to ${SEARCH_RESULTS} results with title, url and snippet.`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for." } },
        required: ["query"],
      },
      async execute(args: { query?: unknown }) {
        // A string or nothing: `callTool` refuses anything else before it gets here, and this
        // is the backstop for a caller that does not go through it.
        if (args?.query !== undefined && args?.query !== null && typeof args.query !== "string") {
          throw new Error("web.search takes a query string");
        }
        const query = String(args?.query ?? "").trim();
        if (!query) throw new Error("web.search needs a query");
        const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, "text/html", deps);
        const results = parseDuckDuckGo(html);
        return { query, results, source: "html.duckduckgo.com" };
      },
    },
    {
      name: "web.fetch_page",
      description: `Fetch a URL and return its text, trimmed to ${PAGE_CHARS} characters.`,
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "An http(s) URL." } },
        required: ["url"],
      },
      async execute(args: { url?: unknown }) {
        if (args?.url !== undefined && args?.url !== null && typeof args.url !== "string") {
          throw new Error("web.fetch_page takes an http(s) URL");
        }
        const url = String(args?.url ?? "").trim();
        if (!/^https?:\/\//.test(url)) throw new Error("web.fetch_page takes an http(s) URL");
        const html = await get(url, "text/html", deps);
        const text = htmlToText(html);
        const title = pageTitle(html);
        return {
          url,
          title: title ? htmlToText(title) : undefined,
          chars: text.length,
          truncated: text.length > PAGE_CHARS,
          text: text.slice(0, PAGE_CHARS),
        };
      },
    },
    {
      name: "market.prices",
      description:
        "Spot prices in USD from CoinGecko, with 24h change. `ids` are CoinGecko ids such as solana, bitcoin, ethereum, usd-coin.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "CoinGecko ids; defaults to [solana]." },
        },
      },
      async execute(args: { ids?: unknown }) {
        // An array or nothing. `{"length": 3e9}` passes an `ids?.length` test and would reach `.map`;
        // `callTool` refuses it first, and this keeps the tool safe without it. Ten ids are
        // taken before anything is done to them, so a long array costs nothing.
        const given = args?.ids;
        if (given !== undefined && given !== null && !Array.isArray(given)) {
          throw new Error("market.prices takes ids as an array of CoinGecko ids");
        }
        const listed: unknown[] = Array.isArray(given) ? given.slice(0, 10) : [];
        const ids = (listed.length ? listed : ["solana"]).map((s) => String(s).toLowerCase());
        const body = await get(
          `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
            ids.join(",")
          )}&vs_currencies=usd&include_24hr_change=true`,
          "application/json",
          deps
        );
        const parsed = JSON.parse(body) as Record<string, { usd?: number; usd_24h_change?: number }>;
        return {
          source: "api.coingecko.com",
          fetchedAt: new Date().toISOString(),
          prices: ids.map((id) => ({
            id,
            usd: parsed[id]?.usd ?? null,
            change24h: parsed[id]?.usd_24h_change ?? null,
          })),
        };
      },
    },
  ];
}

export const WEB_TOOL_NAMES = ["web.search", "web.fetch_page", "market.prices"];
