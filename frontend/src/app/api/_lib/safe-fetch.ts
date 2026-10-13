/**
 * The SSRF guard behind a sandbox's sources: the operator's server fetching a URL because an owner
 * typed it on the loop form.
 *
 * The rules, and the failure each one closes:
 *
 * - `https` on port 443 only. A port is how a public name reaches a service that was never meant
 *   to answer the web (a database, an admin page on :8080), and plain `http` is a fetch anyone on
 *   the path can rewrite before its bytes are pinned by hash.
 * - The name is resolved once and **every** answer is checked, not just the first: a name that
 *   resolves to a public address and a private one is a name whose next answer is the private one.
 * - The socket goes to the checked address. Handing the *name* to a client that resolves it again
 *   is a check on one answer and a connection to another (DNS rebinding), so the transport gets the
 *   address and a `lookup` that returns it; the `Host` header and the TLS `servername` stay the
 *   name, so certificates and virtual hosts are unchanged.
 * - Redirects are followed by hand, at most three, each target re-checked by the same rule: a
 *   public URL that answers `302 Location: http://169.254.169.254/` must not be followed there.
 * - Bytes are counted while the body streams and the read stops at the cap. `Content-Length` is
 *   the server's claim and is never what the cap is checked against.
 * - A timeout per request and, through `deadline`, per source, so a server that trickles one byte
 *   a second cannot hold a loop's start open.
 *
 * `fetch` and `lookup` are injected: the suite (`tests/sandbox-sources.ts`) runs every refusal on a
 * stubbed network and never opens a socket.
 */
import { lookup as dnsLookup } from "dns/promises";
import * as http from "http";
import * as https from "https";
import { isIP } from "net";

/** An address the guard checked, and the only one the transport may connect to. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address `host` resolves to. The default is the system resolver with `all: true`. */
export type LookupFn = (host: string) => Promise<PinnedAddress[]>;

export interface TransportRequest {
  url: URL;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Uint8Array;
  /**
   * The checked address to connect to. Absent only for a URL the operator configured (the RPC
   * urls), which is the operator's own and may well be a local node.
   */
  pin?: PinnedAddress;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  /** Lower-case names; a repeated header joined with ", ". */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  /** Drops the rest of the body: an unread response holds its socket. */
  cancel(): void;
}

/** One request, no redirects followed, no body read. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** A fetch the guard refused, or one that failed in a way it names. The message is the sentence shown. */
export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

export const MAX_REDIRECTS = 3;
const UA = "Lath sandbox sources";

// ─── Addresses ───────────────────────────────────────────────────────────────

function parseV4(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^(0|[1-9][0-9]{0,2})$/.test(p) ? Number(p) : NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

/** 16 bytes, or `null`. Handles `::` compression, a trailing dotted quad and a `%zone`. */
function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = parseV4(s.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    s = s.slice(0, lastColon + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const bytes: number[] = [];
  for (const g of all) {
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function v4Problem(b: number[]): string | null {
  const [a, c, d] = b;
  if (a === 0) return "an unspecified address (0.0.0.0/8)";
  if (a === 127) return "a loopback address (127/8)";
  if (a === 10) return "a private address (10/8)";
  if (a === 172 && c >= 16 && c <= 31) return "a private address (172.16/12)";
  if (a === 192 && c === 168) return "a private address (192.168/16)";
  if (a === 169 && c === 254) return "a link-local address (169.254/16)";
  if (a === 100 && c >= 64 && c <= 127) return "a shared address (100.64/10)";
  // The special-purpose blocks of RFC 6890 that no public source is served from. Benchmarking
  // space is routed inside labs and some clouds' internal networks, the IETF protocol block holds
  // DS-Lite and NAT64 discovery addresses, and the three documentation nets are never on the
  // internet — so an answer in any of them is a name pointed somewhere it should not be.
  if (a === 198 && (c === 18 || c === 19)) return "a benchmarking address (198.18/15)";
  if (a === 192 && c === 0 && d === 0) return "an IETF protocol address (192.0.0/24)";
  if (a === 192 && c === 0 && d === 2) return "a documentation address (192.0.2/24)";
  if (a === 198 && c === 51 && d === 100) return "a documentation address (198.51.100/24)";
  if (a === 203 && c === 0 && d === 113) return "a documentation address (203.0.113/24)";
  // Not in the sheet's list, and refused for the same reason: nothing a public source lives on.
  if (a >= 224) return "a multicast or reserved address (224/3)";
  return null;
}

/**
 * Why this server must not connect to `addr`, or `null` when it may. An IPv6 address that carries
 * an IPv4 one (mapped `::ffff:a.b.c.d`, SIIT `::ffff:0:a.b.c.d`, compatible `::a.b.c.d`, NAT64
 * `64:ff9b::/96` and the local-use `64:ff9b:1::/48`, 6to4 `2002:aabb:ccdd::/48`) is judged by the
 * address it carries, in either spelling, because a translator or relay on the path delivers the
 * packet there. Teredo (`2001:0::/32`) is refused outright: its IPv4 server and client are
 * obfuscated in the address and a relay decides where it lands, so there is nothing to judge.
 */
export function addressProblem(addr: string): string | null {
  const family = isIP(addr);
  if (family === 4) {
    const b = parseV4(addr);
    return b ? v4Problem(b) : "not an address";
  }
  if (family !== 6) return "not an address";
  const b = parseV6(addr);
  if (!b) return "not an address";
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "an unspecified address (::)";
  if (zero(0, 15) && b[15] === 1) return "a loopback address (::1)";
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    const p = v4Problem(b.slice(12));
    return p ? `${p}, mapped into IPv6` : null;
  }
  if (zero(0, 12)) {
    const p = v4Problem(b.slice(12));
    return p ? `${p}, embedded in IPv6` : null;
  }
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) {
    const p = v4Problem(b.slice(12));
    return p ? `${p}, translated into IPv6 (::ffff:0:0/96)` : null;
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) {
    const p = v4Problem(b.slice(12));
    return p ? `${p}, behind NAT64` : null;
  }
  // RFC 8215's local-use NAT64 prefix: a site's own translator. A /96 under it, the common
  // deployment, carries the IPv4 in the last four bytes, which is where such a translator sends it.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0x00 && b[5] === 0x01) {
    const p = v4Problem(b.slice(12));
    return p ? `${p}, behind local-use NAT64 (64:ff9b:1::/48)` : null;
  }
  if (b[0] === 0x20 && b[1] === 0x02) {
    const p = v4Problem(b.slice(2, 6));
    return p ? `${p}, inside 6to4 (2002::/16)` : null;
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return "a Teredo address (2001::/32)";
  if ((b[0] & 0xfe) === 0xfc) return "a unique-local address (fc00::/7)";
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "a link-local address (fe80::/10)";
  // Deprecated by RFC 3879 but still routed by stacks that never dropped it: the old private range.
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return "a site-local address (fec0::/10)";
  if (b[0] === 0xff) return "a multicast address (ff00::/8)";
  return null;
}

// ─── URLs ────────────────────────────────────────────────────────────────────

/**
 * `raw` parsed and held to the rule, with the one address the request may go to. Throws
 * `FetchRefused` naming the rule it broke.
 */
export async function checkUrl(raw: string, lookup: LookupFn): Promise<{ url: URL; pin: PinnedAddress }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused(`${JSON.stringify(raw)} is not a URL`);
  }
  if (url.protocol !== "https:") throw new FetchRefused(`only https:// URLs are fetched, not ${url.protocol}//`);
  if (url.port !== "" && url.port !== "443") throw new FetchRefused(`only port 443 is fetched, not ${url.port}`);
  if (url.username || url.password) throw new FetchRefused("a URL with credentials in it is not fetched");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal")
  ) {
    throw new FetchRefused(`${host} is not a public host`);
  }
  let answers: PinnedAddress[];
  if (isIP(host)) {
    answers = [{ address: host, family: isIP(host) as 4 | 6 }];
  } else {
    try {
      answers = await lookup(host);
    } catch (e) {
      throw new FetchRefused(`${host} does not resolve (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (answers.length === 0) throw new FetchRefused(`${host} does not resolve`);
  for (const a of answers) {
    const problem = addressProblem(a.address);
    if (problem) throw new FetchRefused(`${host} resolves to ${a.address}, ${problem}, which is never fetched`);
  }
  return { url, pin: answers[0] };
}

// ─── The fetch ───────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  lookup: LookupFn;
  fetch: Transport;
  /** The most body bytes read; one more and the fetch is refused. */
  maxBytes: number;
  /** This request's own limit, redirects included. */
  timeoutMs: number;
  /** An absolute time on `now`'s clock the whole source must finish by. */
  deadline?: number;
  now?: () => number;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** What the refusal calls the thing fetched, e.g. `the tarball`. Defaults to the host. */
  what?: string;
}

export interface SafeFetched {
  /** The URL that answered, after redirects. */
  finalUrl: URL;
  status: number;
  headers: Record<string, string>;
  /** The body of a 2xx answer, at most `maxBytes`; empty for any other status. */
  bytes: Uint8Array;
}

/** A timer that aborts with a `FetchRefused`, and a promise that rejects when it does. */
function deadlineFor(ms: number, sentence: string): { signal: AbortSignal; aborted: Promise<never>; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FetchRefused(sentence)), Math.max(0, ms));
  if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref();
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  // Rejections nobody awaited yet are not crashes: every await below races against this.
  aborted.catch(() => undefined);
  return { signal: controller.signal, aborted, clear: () => clearTimeout(timer) };
}

async function readCapped(
  res: TransportResponse,
  maxBytes: number,
  aborted: Promise<never>,
  what: string
): Promise<Uint8Array> {
  const it = res.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r.done) {
        done = true;
        break;
      }
      total += r.value.byteLength;
      // Counted here, as the bytes arrive: a server that declared 100 bytes and sends a gigabyte
      // is stopped one chunk past the cap, not after the gigabyte.
      if (total > maxBytes) throw new FetchRefused(`${what} is over the ${maxBytes}-byte cap`);
      chunks.push(r.value);
    }
  } finally {
    if (!done) {
      res.cancel();
      // A destroyed stream may reject its own return(); that is the cancel working, not a failure.
      Promise.resolve(it.return?.()).catch(() => undefined);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * A guarded request to a URL someone other than the operator chose. Redirects are followed (each
 * re-checked); any other status comes back with an empty body for the caller to name.
 */
export async function safeFetch(raw: string, opts: SafeFetchOptions): Promise<SafeFetched> {
  const now = opts.now ?? Date.now;
  let limit = opts.timeoutMs;
  let sentence = `the request to ${raw} did not finish in ${opts.timeoutMs} ms`;
  if (opts.deadline !== undefined) {
    const left = opts.deadline - now();
    if (left <= 0) throw new FetchRefused(`the source ran past its time limit before ${raw} was fetched`);
    if (left < limit) {
      limit = left;
      sentence = `the source ran past its time limit while fetching ${raw}`;
    }
  }
  const timer = deadlineFor(limit, sentence);
  try {
    let current = await Promise.race([checkUrl(raw, opts.lookup), timer.aborted]);
    for (let hop = 0; ; hop++) {
      const res = await Promise.race([
        opts.fetch({
          url: current.url,
          method: opts.method ?? "GET",
          headers: { "user-agent": UA, ...(opts.headers ?? {}) },
          body: opts.body,
          pin: current.pin,
          signal: timer.signal,
        }),
        timer.aborted,
      ]);
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        res.cancel();
        const location = res.headers["location"];
        if (!location) throw new FetchRefused(`${current.url.host} answered ${res.status} with no Location`);
        if (hop >= MAX_REDIRECTS) {
          throw new FetchRefused(`${raw} redirected more than ${MAX_REDIRECTS} times`);
        }
        let next: string;
        try {
          next = new URL(location, current.url).toString();
        } catch {
          throw new FetchRefused(`${current.url.host} redirected to ${JSON.stringify(location)}, which is not a URL`);
        }
        current = await Promise.race([checkUrl(next, opts.lookup), timer.aborted]);
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        res.cancel();
        return { finalUrl: current.url, status: res.status, headers: res.headers, bytes: new Uint8Array() };
      }
      const bytes = await readCapped(
        res,
        opts.maxBytes,
        timer.aborted,
        opts.what ?? `the answer from ${current.url.host}`
      );
      return { finalUrl: current.url, status: res.status, headers: res.headers, bytes };
    }
  } finally {
    timer.clear();
  }
}

/**
 * A request to a URL the operator configured (an RPC url): no address rule, since the operator's
 * own node may well be local, but the same cap and timeout, because the answer is still sized by
 * whatever account the owner named.
 */
export async function trustedFetch(
  raw: string,
  opts: Omit<SafeFetchOptions, "lookup"> & { method: "GET" | "POST" }
): Promise<SafeFetched> {
  const now = opts.now ?? Date.now;
  let limit = opts.timeoutMs;
  if (opts.deadline !== undefined) limit = Math.min(limit, opts.deadline - now());
  if (limit <= 0) throw new FetchRefused("the source ran past its time limit before the RPC answered");
  const timer = deadlineFor(limit, `the RPC did not answer in ${limit} ms`);
  try {
    const url = new URL(raw);
    const res = await Promise.race([
      opts.fetch({
        url,
        method: opts.method,
        headers: { "user-agent": UA, ...(opts.headers ?? {}) },
        body: opts.body,
        signal: timer.signal,
      }),
      timer.aborted,
    ]);
    if (res.status < 200 || res.status >= 300) {
      res.cancel();
      return { finalUrl: url, status: res.status, headers: res.headers, bytes: new Uint8Array() };
    }
    const bytes = await readCapped(res, opts.maxBytes, timer.aborted, opts.what ?? "the RPC's answer");
    return { finalUrl: url, status: res.status, headers: res.headers, bytes };
  } finally {
    timer.clear();
  }
}

// ─── The defaults: the system resolver and node:http(s) ─────────────────────

/** The system resolver, every answer. */
export const systemLookup: LookupFn = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

/**
 * `node:http(s)` rather than `fetch` for one reason: it takes a `lookup`, so with a pin the socket
 * opens to the address that passed the check and nothing resolves the name a second time. No
 * pooled agent either: a kept-alive socket is a connection to whatever the pool opened it to.
 */
export const nodeTransport: Transport = (req) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const mod = req.url.protocol === "https:" ? https : http;
    const pin = req.pin;
    const options: https.RequestOptions = {
      protocol: req.url.protocol,
      hostname: req.url.hostname.replace(/^\[|\]$/g, ""),
      port: req.url.port || (req.url.protocol === "https:" ? 443 : 80),
      path: `${req.url.pathname}${req.url.search}`,
      method: req.method,
      // No `accept-encoding`: a compressed transfer would make the byte cap count the wrong bytes.
      headers: { ...req.headers, host: req.url.host },
      agent: false,
      signal: req.signal,
    };
    if (pin) {
      // `any`: node's LookupFunction is two callback shapes in one type.
      options.lookup = ((_host: string, opts: any, cb: any) => {
        // Both callback shapes: `net` asks with `all` when it is happy-eyeballing.
        if (opts && opts.all) cb(null, [{ address: pin.address, family: pin.family }]);
        else cb(null, pin.address, pin.family);
      }) as https.RequestOptions["lookup"];
    }
    const r = mod.request(options, (res) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      resolve({
        status: res.statusCode ?? 0,
        headers,
        body: res as AsyncIterable<Uint8Array>,
        cancel: () => res.destroy(),
      });
    });
    r.on("error", reject);
    if (req.body) r.write(Buffer.from(req.body));
    r.end();
  });
