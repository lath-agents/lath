/**
 * The web tools' address guard (`frontend/src/app/api/_lib/web-tools.ts`): it is `safe-fetch.ts`
 * `addressProblem`, so every IPv6 spelling that carries a private
 * IPv4 address, and every special-purpose block the sandbox's sources refuse, is refused here too
 * — at the first URL, at a name's answers, at each redirect and at the pinned socket.
 *
 * No network: IP-literal URLs never resolve, names go through a stub resolver, and the transport is
 * a stub that answers with a redirect, so no case opens a socket.
 */
import { assert } from "chai";
import { Readable } from "stream";
import { addressProblem, type PinnedAddress } from "../frontend/src/app/api/_lib/safe-fetch";
import {
  get,
  htmlToText,
  isPrivateAddress,
  pageTitle,
  pinnedLookup,
  webTools,
  type Fetched,
} from "../frontend/src/app/api/_lib/web-tools";

/** The finding's cases: each one `addressProblem` refuses and the old list let through. */
const EMBEDDED = [
  "::7f00:1", // IPv4-compatible 127.0.0.1
  "64:ff9b::a9fe:a9fe", // NAT64 169.254.169.254, the metadata service
  "64:ff9b::a00:1", // NAT64 10.0.0.1
  "64:ff9b:1::a00:1", // local-use NAT64 10.0.0.1
  "2002:a9fe:a9fe::", // 6to4 169.254.169.254
  "fec0::1", // site-local
  "2001::1", // Teredo
  "::ffff:0:a00:1", // SIIT-translated 10.0.0.1
];
const V4_SPECIAL = ["198.18.0.1", "192.0.0.8", "192.0.2.1", "198.51.100.1", "203.0.113.1"];

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (e) {
    return e as Error;
  }
  assert.fail("was not refused");
}

/** A transport that must never be reached; a call to it is the guard having let the URL through. */
const noSocket = async (url: URL): Promise<Fetched> => {
  throw new Error(`a socket was opened to ${url.host}`);
};

describe("the web tools' address guard is safe-fetch's", () => {
  it("classifies every address exactly as addressProblem does", () => {
    for (const addr of [...EMBEDDED, ...V4_SPECIAL, "::ffff:169.254.169.254", "::ffff:127.0.0.1", "10.0.0.1"]) {
      assert.isNotNull(addressProblem(addr), `safe-fetch lets ${addr} through`);
      assert.isTrue(isPrivateAddress(addr), `web-tools lets ${addr} through`);
    }
    for (const addr of ["1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "64:ff9b::101:101"]) {
      assert.isFalse(isPrivateAddress(addr), `${addr} is public`);
    }
  });

  it("refuses an IP-literal URL in any embedded form, on any port, before a socket", async () => {
    for (const addr of EMBEDDED) {
      for (const url of [`http://[${addr}]/`, `http://[${addr}]:8080/`, `https://[${addr}]/latest/meta-data/`]) {
        const e = await refusal(() => get(url, "text/html", { request: noSocket }));
        assert.match(e.message, /not a public host/, url);
      }
    }
    for (const addr of V4_SPECIAL) {
      const e = await refusal(() => get(`http://${addr}/`, "text/html", { request: noSocket }));
      assert.match(e.message, /not a public host/, addr);
    }
  });

  it("refuses IPv4-mapped and decimal, octal and hex IPv4 spellings of a private address", async () => {
    for (const url of [
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:a9fe:a9fe]/",
      "http://2130706433/", // 127.0.0.1
      "http://0177.0.0.1/", // 127.0.0.1
      "http://0x7f.1/", // 127.0.0.1
      "http://2852039166/", // 169.254.169.254
      "http://0251.0376.0251.0376/", // 169.254.169.254
      "http://167772161:8080/", // 10.0.0.1
    ]) {
      const e = await refusal(() => get(url, "text/html", { request: noSocket }));
      assert.match(e.message, /not a public host/, url);
    }
  });

  it("refuses a name when any of its answers is an embedded private address", async () => {
    for (const addr of [...EMBEDDED, ...V4_SPECIAL]) {
      const lookup = async (): Promise<PinnedAddress[]> => [
        { address: "93.184.216.34", family: 4 },
        { address: addr, family: addr.includes(":") ? 6 : 4 },
      ];
      const e = await refusal(() => get("http://rebind.example/", "text/html", { lookup, request: noSocket }));
      assert.match(e.message, /not a public host/, addr);
    }
  });

  it("re-checks a redirect by the same rule and never follows it to an embedded address", async () => {
    for (const addr of [...EMBEDDED, ...V4_SPECIAL]) {
      const hops: string[] = [];
      const request = async (url: URL): Promise<Fetched> => {
        hops.push(url.host);
        if (hops.length > 1) throw new Error(`followed the redirect to ${url.host}`);
        const target = addr.includes(":") ? `[${addr}]` : addr;
        return {
          status: 302,
          statusText: "Found",
          location: `http://${target}:8080/`,
          type: "",
          declared: 0,
          body: Readable.from([]),
        };
      };
      const lookup = async (): Promise<PinnedAddress[]> => [{ address: "93.184.216.34", family: 4 }];
      const e = await refusal(() => get("https://public.example/", "text/html", { lookup, request }));
      assert.match(e.message, /not a public host/, addr);
      assert.deepEqual(hops, ["public.example"], addr);
    }
  });

  it("the pinned socket's lookup refuses an address the rule refuses, and answers a public one", () => {
    for (const addr of [...EMBEDDED, "198.18.0.1"]) {
      let err: Error | null = null;
      pinnedLookup({ address: addr, family: addr.includes(":") ? 6 : 4 })("x", {}, (e: Error | null) => {
        err = e;
      });
      assert.isNotNull(err, addr);
    }
    const answers: unknown[] = [];
    pinnedLookup({ address: "93.184.216.34", family: 4 })("x", { all: true }, (e: Error | null, a: unknown) => {
      assert.isNull(e);
      answers.push(a);
    });
    pinnedLookup({ address: "93.184.216.34", family: 4 })("x", {}, (e: Error | null, a: unknown, f: unknown) => {
      assert.isNull(e);
      answers.push([a, f]);
    });
    assert.deepEqual(answers, [[{ address: "93.184.216.34", family: 4 }], ["93.184.216.34", 4]]);
  });
});

/**
 * `web.fetch_page` turns whatever the fetched URL answered with into text on the console's only
 * event loop, so a pattern quadratic in it would turn 2 MiB of `<` into hours of stall for every
 * session, stream and loop timer. Each case is a page the fetch is allowed to return (2 MiB,
 * `MAX_BODY_BYTES`) built to hit one pattern, and each has to finish well inside a second.
 */
describe("the page-to-text strip is linear in the page", () => {
  const MIB2 = 2 * 1024 * 1024;
  const fill = (unit: string, prefix = "", suffix = "") =>
    prefix + unit.repeat(Math.ceil((MIB2 - prefix.length - suffix.length) / unit.length)) + suffix;

  /** The strip as it was, for pages it handled in linear time: the new one must read them the same. */
  const before = (html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&#x27;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();

  const ADVERSARIAL: Array<[string, string]> = [
    ["< repeated", fill("<")],
    ["<a repeated", fill("<a")],
    ["one < then text", fill("x", "<")],
    ["<script repeated, never closed", fill("<script")],
    ["<style repeated, never closed", fill("<STYLE ")],
    ["<noscript repeated, never closed", fill("<noscript>")],
    ["<title> repeated, never closed", fill("<title>")],
    ["<title repeated", fill("<title")],
    ["\\r runs", fill("\r", "a", "b")],
    ["U+00A0 runs", fill(" ", "a", "b")],
    ["U+3000 runs", fill("　", "a", "b")],
    ["space and newline alternating", fill(" \n")],
  ];

  for (const [what, page] of ADVERSARIAL) {
    it(`2 MiB of ${what} is text in under a second`, () => {
      const t0 = Date.now();
      htmlToText(page);
      pageTitle(page);
      assert.isBelow(Date.now() - t0, 1000, what);
    });
  }

  it("reads an ordinary page exactly as the old strip did", () => {
    const pages = [
      "<html><head><title>Fees</title><style>.a{color:red}</style></head><body>" +
        "<script>var x = '<p>';</script><h1>Priority fees</h1><p>Median is <b>5 000</b> &amp; rising.</p>" +
        "<ul><li>one</li><li>two</li></ul><noscript>enable js</noscript><div>a&nbsp;b &lt;c&gt;</div></body></html>",
      "<div>\n  <p>first</p>\n\n\t<p>second   line</p>\n</div><br/><table><tr><td>x</td></tr></table>",
      "plain text with no markup at all",
      "<SCRIPT type=module>import x from '/y'</SCRIPT>after <a href=\"/q?a=1&amp;b=2\">link</a>",
    ];
    for (const page of pages) assert.equal(htmlToText(page), before(page), page);
  });

  it("drops an element that is never closed through the end of the page", () => {
    assert.equal(htmlToText("<p>kept</p><script>never closed <p>gone</p>"), "kept");
    assert.equal(htmlToText("a<style>b</style>c<style>d"), "a c");
  });

  it("folds every kind of whitespace, and a run with a newline in it to one newline", () => {
    assert.equal(htmlToText("a\r\r 　b"), "a b");
    assert.equal(htmlToText("a \r\n  \n\n b"), "a\nb");
  });

  it("reads only the first half-megabyte of a page", () => {
    const page = "head " + "x".repeat(600 * 1024) + " tail";
    const text = htmlToText(page);
    assert.isTrue(text.startsWith("head "));
    assert.notInclude(text, "tail");
  });

  it("finds the first closed <title> near the top of a page, and nothing past the scan", () => {
    assert.equal(pageTitle('<html><head><title lang="en">Fee &amp; tip</title></head>'), "Fee &amp; tip");
    assert.equal(pageTitle("<TITLE>Upper</TITLE>"), "Upper");
    assert.isUndefined(pageTitle("<title>never closed"));
    assert.isUndefined(pageTitle("<p>no title</p>"));
    assert.isUndefined(pageTitle("x".repeat(70 * 1024) + "<title>too deep</title>"));
  });
});

/**
 * The socket's timeout is an idle timer that every byte resets, so a server dripping a byte at a
 * time could hold a tool call — and through `/api/run`'s heartbeat, the console's one run slot —
 * open for as long as it liked. `get` has one deadline from entry to the last byte, over the
 * lookup, every redirect hop and the body. Shortened here (`deadlineMs`) so the cases wait it out.
 */
describe("a guarded GET has one deadline, however the server paces its bytes", () => {
  const lookup = async (): Promise<PinnedAddress[]> => [{ address: "93.184.216.34", family: 4 }];
  const ok = (body: Readable, extra: Partial<Fetched> = {}): Fetched => ({
    status: 200,
    statusText: "OK",
    location: null,
    type: "text/html",
    declared: 0,
    body,
    ...extra,
  });
  /** A body that sends one byte every `everyMs` for ever — each byte would reset an idle timer. */
  const drip = (everyMs: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Readable({
      read() {
        timer = setTimeout(() => this.push("x"), everyMs);
      },
      destroy(err, cb) {
        clearTimeout(timer);
        cb(err);
      },
    });
  };

  async function refusedWithin(ms: number, run: () => Promise<unknown>): Promise<Error> {
    const t0 = Date.now();
    const e = await refusal(run);
    assert.isBelow(Date.now() - t0, ms, "refused, but not by the deadline");
    return e;
  }

  it("cuts a body that drips, and destroys it", async () => {
    const body = drip(20);
    const e = await refusedWithin(1000, () =>
      get("https://drip.example/", "text/html", { lookup, request: async () => ok(body), deadlineMs: 250 })
    );
    assert.match(e.message, /drip\.example did not finish answering in 250 ms/);
    assert.isTrue(body.destroyed, "the dripping body was left open");
  });

  it("cuts a server that never answers, and a name that never resolves", async () => {
    const hung = () => new Promise<never>(() => {});
    let signalled: AbortSignal | undefined;
    const e1 = await refusedWithin(1000, () =>
      get("https://silent.example/", "text/html", {
        lookup,
        request: (_u, _p, _a, signal) => {
          signalled = signal;
          return hung();
        },
        deadlineMs: 150,
      })
    );
    assert.match(e1.message, /did not finish answering/);
    // The transport is handed the deadline, which is what destroys the real request's socket.
    assert.isTrue(signalled?.aborted, "the transport's signal never fired");
    const e2 = await refusedWithin(1000, () =>
      get("https://unresolved.example/", "text/html", { lookup: hung, request: noSocket, deadlineMs: 150 })
    );
    assert.match(e2.message, /did not finish answering/);
  });

  it("spans every redirect hop: slow hops add up to the one deadline", async () => {
    let hops = 0;
    const request = async (url: URL): Promise<Fetched> => {
      hops++;
      await new Promise((r) => setTimeout(r, 80));
      return ok(Readable.from([]), { status: 302, statusText: "Found", location: `https://${url.host}/next` });
    };
    const e = await refusedWithin(1000, () =>
      get("https://hops.example/", "text/html", { lookup, request, deadlineMs: 200 })
    );
    assert.match(e.message, /did not finish answering/);
    assert.isAtMost(hops, 3, "hops went on past the deadline");
  });

  it("destroys a redirect's body rather than draining it", async () => {
    const first = drip(20);
    let hop = 0;
    const request = async (): Promise<Fetched> =>
      hop++ === 0
        ? ok(first, { status: 301, statusText: "Moved", location: "https://moved.example/" })
        : ok(Readable.from([Buffer.from("<p>there</p>")]));
    assert.equal(
      await get("https://redirect.example/", "text/html", { lookup, request, deadlineMs: 1000 }),
      "<p>there</p>"
    );
    assert.isTrue(first.destroyed, "the redirect's dripping body was left draining");
  });

  it("answers a prompt server in full, and web.fetch_page reads it through the strip", async () => {
    const page = "<html><head><title>Fees</title></head><body><p>Median <b>5 000</b></p></body></html>";
    const request = async (): Promise<Fetched> => ok(Readable.from([Buffer.from(page)]));
    const tool = webTools({ lookup, request, deadlineMs: 500 }).find((t) => t.name === "web.fetch_page")!;
    const ctx = { sessionId: "s", agentId: new Uint8Array(32), spentMicroUsdc: 0n };
    assert.deepEqual(await tool.execute({ url: "https://fees.example/" }, ctx), {
      url: "https://fees.example/",
      title: "Fees",
      chars: "Fees Median 5 000".length,
      truncated: false,
      text: "Fees Median 5 000",
    });
    const slow = webTools({ lookup, request: async () => ok(drip(20)), deadlineMs: 150 }).find(
      (t) => t.name === "web.fetch_page"
    )!;
    const e = await refusedWithin(1000, () => slow.execute({ url: "https://drip.example/" }, ctx));
    assert.match(e.message, /did not finish answering in 150 ms/);
  });
});
