import { assert } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isBatchRefusal } from "@lath/sdk";
import {
  CALL_WEIGHT,
  MAX_ANSWER_BYTES,
  MAX_BATCH,
  MAX_BODY_BYTES,
  PHOTON_METHODS,
  SOLANA_METHODS,
  proxyRpc,
  scrub,
  tokenBuckets,
  upstreamSecrets,
  weightOf,
  type ProxyTarget,
} from "../frontend/src/app/api/rpc/proxy";
import { browserRpc, SERVER_RENDER_ORIGIN } from "../frontend/src/lib/rpc-endpoint";

/**
 * The browser's RPC goes through this origin, not to the operator's keyed url. Exported as
 * `NEXT_PUBLIC_RPC_URL`, the Helius url, `?api-key=…` and all, would be inlined by Next into every
 * client chunk, and it is the url the server writes every chain with.
 *
 * What it pins: with no published url the browser is handed only same-origin proxy urls, whose path
 * names the cluster the way the wallet adapter reads it; `dev:devnet` puts the url in no
 * `NEXT_PUBLIC_*` variable; and the proxy forwards the app's own calls — re-serialised, with no
 * browser header going up and no upstream header, error body or credential coming back — while it
 * refuses every other method, a batch past the bound or on the Photon route, an oversized body,
 * anything but POST, another site's page, another cluster's path, and a hung upstream.
 *
 * Node-only: the upstream is a fake `fetch`.
 */

const KEY = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const UPSTREAM = `https://devnet.helius-rpc.com/?api-key=${KEY}`;

type Seen = { url: string; init: RequestInit };

/** A fake upstream that records what it was sent and answers with `reply`. */
function upstream(reply: (body: string) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return reply(String(init.body));
  }) as unknown as typeof fetch;
  return { seen, fetchFn };
}

function post(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request("http://localhost:3000/api/rpc/devnet", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

const RPC: ProxyTarget = { role: "rpc", upstream: UPSTREAM, cluster: "devnet", servedCluster: "devnet" };
const PHOTON: ProxyTarget = { ...RPC, role: "photon" };

const call = (method: string, id: number | string = 1, params: unknown = []) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

async function errorOf(res: Response): Promise<{ code: number; message: string }> {
  const body = (await res.json()) as any;
  return body.error;
}

describe("the browser's RPC proxy", () => {
  describe("what the browser is handed", () => {
    it("with no published url, only this origin's proxy, its path naming the cluster", () => {
      const at = browserRpc({}, "devnet", "http://localhost:3000");
      assert.isTrue(at.proxied);
      assert.equal(at.rpcUrl, "http://localhost:3000/api/rpc/devnet");
      assert.equal(at.indexerUrl, "http://localhost:3000/api/rpc/devnet/photon");
      assert.equal(at.proverUrl, "http://localhost:3000/api/rpc/devnet/photon");
      assert.equal(at.proxyPath, "/api/rpc/devnet");
      // `dev:devnet` exports the three as empty strings, which must read as unset.
      assert.deepEqual(browserRpc({ rpc: " ", photon: "", prover: "" }, "devnet", "http://localhost:3000"), at);
    });

    it("builds an absolute url during a server render, which web3.js requires", () => {
      const at = browserRpc({}, "devnet", null);
      assert.equal(at.rpcUrl, `${SERVER_RENDER_ORIGIN}/api/rpc/devnet`);
      assert.match(at.rpcUrl, /^https?:\/\//);
    });

    it("uses a url the deployment published, and the split-stack overrides, as given", () => {
      const at = browserRpc({ rpc: "http://127.0.0.1:8899", photon: "http://127.0.0.1:8784" }, "devnet", "http://x");
      assert.isFalse(at.proxied);
      assert.equal(at.rpcUrl, "http://127.0.0.1:8899");
      assert.equal(at.indexerUrl, "http://127.0.0.1:8784");
      assert.equal(at.proverUrl, "http://127.0.0.1:8899");
    });

    it("names the cluster the wallet adapter signs for, even on localhost", () => {
      // The adapter picks the transaction's chain from the endpoint's text; `localhost` alone reads
      // as localnet, and a devnet write signed for localnet is refused by the wallet.
      const util = require(path.join(__dirname, "../frontend/node_modules/@solana/wallet-standard-util"));
      assert.equal(util.getChainForEndpoint(browserRpc({}, "devnet", "http://localhost:3000").rpcUrl), "solana:devnet");
      assert.equal(
        util.getChainForEndpoint(browserRpc({}, "mainnet-beta", "https://lath.example").rpcUrl),
        "solana:mainnet"
      );
    });
  });

  describe("dev:devnet", () => {
    it("puts the keyed url in LATH_RPC_URL and in no NEXT_PUBLIC_* variable", function () {
      this.timeout(60_000);
      // `npx` is replaced by one that writes the environment it was started with, so the run stops at
      // the `exec npx next dev` the script ends on, with exactly what Next would have inherited.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lath-devnet-env-"));
      const dump = path.join(dir, "env.json");
      fs.writeFileSync(
        path.join(dir, "npx"),
        `#!/bin/sh\nexec node -e 'require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))'\n`,
        { mode: 0o755 }
      );
      try {
        const stdout = execFileSync(path.join(__dirname, "../scripts/dev-devnet.sh"), [], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            LATH_DEVNET_RPC: UPSTREAM,
            // A shell may still carry it; it must be read and then blanked.
            NEXT_PUBLIC_RPC_URL: UPSTREAM,
            LATH_RUNTIME_KEYPAIR: path.join(dir, "no-keypair.json"),
            LATH_ZEROCLAW_BIN: path.join(dir, "no-zeroclaw"),
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        assert.notInclude(stdout, KEY, "the script printed the key");
        const env: Record<string, string> = JSON.parse(fs.readFileSync(dump, "utf8"));
        assert.equal(env.LATH_RPC_URL, UPSTREAM);
        assert.equal(env.NEXT_PUBLIC_RPC_URL, "");
        const leaked = Object.entries(env).filter(([k, v]) => k.startsWith("NEXT_PUBLIC_") && v.includes(KEY));
        assert.deepEqual(leaked, [], "a NEXT_PUBLIC_* variable carries the key");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("forwarding", () => {
    it("forwards an allowed call re-serialised, with no browser header up and no upstream header back", async () => {
      const { seen, fetchFn } = upstream(
        () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { value: 5, note: `from ${UPSTREAM}` } }), {
            status: 200,
            headers: { "content-type": "application/json", "x-upstream-key": KEY, "set-cookie": `k=${KEY}` },
          })
      );
      const res = await proxyRpc(
        post(call("getBalance", 7, ["11111111111111111111111111111111"]), { cookie: "session=abc", "x-extra": "1" }),
        RPC,
        { fetch: fetchFn }
      );
      assert.equal(res.status, 200);
      assert.lengthOf(seen, 1);
      assert.equal(seen[0].url, UPSTREAM);
      assert.deepEqual(Object.keys(seen[0].init.headers as Record<string, string>).sort(), ["accept", "content-type"]);
      assert.deepEqual(
        JSON.parse(String(seen[0].init.body)),
        call("getBalance", 7, ["11111111111111111111111111111111"])
      );
      assert.isNull(res.headers.get("x-upstream-key"));
      assert.isNull(res.headers.get("set-cookie"));
      const text = await res.text();
      assert.notInclude(text, KEY);
      assert.equal(JSON.parse(text).result.value, 5);
    });

    it("forwards only the method it checked when the body names two", async () => {
      // JSON.parse keeps the last duplicate and another parser may keep the first; re-serialising
      // means the upstream is sent exactly the call that passed the allowlist.
      const { seen, fetchFn } = upstream(() => new Response('{"jsonrpc":"2.0","id":1,"result":0}'));
      const raw = '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop","method":"getBalance","params":[]}';
      const res = await proxyRpc(post(null, {}, raw), RPC, { fetch: fetchFn });
      assert.equal(res.status, 200);
      const sent = String(seen[0].init.body);
      assert.equal(sent.match(/"method"/g)?.length, 1);
      assert.equal(JSON.parse(sent).method, "getBalance");
    });

    it("serves the Photon names in both spellings stateless.js uses", async () => {
      const { seen, fetchFn } = upstream(() => new Response('{"jsonrpc":"2.0","id":1,"result":null}'));
      for (const m of ["getCompressedAccount", "getCompressedAccountV2", "getValidityProof", "getValidityProofV2"]) {
        assert.equal((await proxyRpc(post(call(m)), PHOTON, { fetch: fetchFn })).status, 200, m);
      }
      assert.lengthOf(seen, 4);
    });

    it("forwards a batch within the bound, and refuses one past it the way isBatchRefusal reads", async () => {
      const { seen, fetchFn } = upstream((body) => new Response(JSON.stringify(JSON.parse(body).map(() => null))));
      const ok = await proxyRpc(post(Array.from({ length: MAX_BATCH }, (_, i) => call("getTransaction", i))), RPC, {
        fetch: fetchFn,
      });
      assert.equal(ok.status, 200);
      assert.lengthOf(seen, 1);

      const over = await proxyRpc(
        post(Array.from({ length: MAX_BATCH + 1 }, (_, i) => call("getTransaction", i))),
        RPC,
        { fetch: fetchFn }
      );
      assert.equal(over.status, 413);
      // web3.js throws `${status} ${statusText}: ${body}` for a non-2xx answer.
      assert.isTrue(isBatchRefusal(new Error(`413 Payload Too Large: ${await over.text()}`)));
      assert.lengthOf(seen, 1, "an over-long batch reached the upstream");
    });
  });

  describe("refusals, none of which reach the upstream", () => {
    let seen: Seen[];
    let fetchFn: typeof fetch;
    beforeEach(() => {
      ({ seen, fetchFn } = upstream(() => new Response("{}")));
    });
    afterEach(() => assert.lengthOf(seen, 0, "a refused request reached the upstream"));

    it("a method the app does not send, with a code the SDK does not retry as transient", async () => {
      for (const m of ["requestAirdrop", "getSlot", "simulateTransaction", "getLargestAccounts"]) {
        assert.isFalse(SOLANA_METHODS.has(m));
        const res = await proxyRpc(post(call(m, 3)), RPC, { fetch: fetchFn });
        assert.equal(res.status, 403, m);
        const body = (await res.json()) as any;
        assert.equal(body.id, 3);
        assert.notEqual(body.error.code, -32601);
        assert.notMatch(body.error.message, /method not found/i);
        assert.include(body.error.message, m);
      }
    });

    it("a Solana method on the Photon route, and a Photon method on the Solana one", async () => {
      assert.isFalse(PHOTON_METHODS.has("sendTransaction"));
      assert.equal((await proxyRpc(post(call("sendTransaction")), PHOTON, { fetch: fetchFn })).status, 403);
      assert.equal((await proxyRpc(post(call("getCompressedAccount")), RPC, { fetch: fetchFn })).status, 403);
    });

    it("a batch holding one refused call, an empty batch, and any batch on the Photon route", async () => {
      assert.equal(
        (await proxyRpc(post([call("getBalance"), call("requestAirdrop", 2)]), RPC, { fetch: fetchFn })).status,
        403
      );
      assert.equal((await proxyRpc(post([]), RPC, { fetch: fetchFn })).status, 400);
      assert.equal((await proxyRpc(post([call("getCompressedAccount")]), PHOTON, { fetch: fetchFn })).status, 400);
    });

    it("a body past the cap, whether declared or only streamed", async () => {
      const big = JSON.stringify(call("getBalance", 1, ["x".repeat(MAX_BODY_BYTES)]));
      const declared = await proxyRpc(post(null, {}, big), RPC, { fetch: fetchFn });
      assert.equal(declared.status, 413);
      const streamed = new Request("http://localhost:3000/api/rpc/devnet", {
        method: "POST",
        body: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(big));
            c.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
      assert.isNull(streamed.headers.get("content-length"));
      assert.equal((await proxyRpc(streamed, RPC, { fetch: fetchFn })).status, 413);
    });

    it("anything but POST, another site's page, another cluster's path, a body that is not a call", async () => {
      const get = await proxyRpc(new Request("http://localhost:3000/api/rpc/devnet"), RPC, { fetch: fetchFn });
      assert.equal(get.status, 405);
      assert.equal(get.headers.get("allow"), "POST");
      assert.equal(
        (await proxyRpc(post(call("getBalance"), { "sec-fetch-site": "cross-site" }), RPC, { fetch: fetchFn })).status,
        403
      );
      assert.equal(
        (await proxyRpc(post(call("getBalance")), { ...RPC, cluster: "mainnet-beta" }, { fetch: fetchFn })).status,
        404
      );
      assert.equal((await proxyRpc(post(null, {}, "{not json"), RPC, { fetch: fetchFn })).status, 400);
      assert.equal((await proxyRpc(post({ method: "getBalance" }), RPC, { fetch: fetchFn })).status, 400);
      assert.equal((await proxyRpc(post(call("getBalance", 1, "x")), RPC, { fetch: fetchFn })).status, 400);
    });

    it("a server with no RPC configured says which variable, and names no url", async () => {
      const res = await proxyRpc(post(call("getBalance")), { ...RPC, upstream: "" }, { fetch: fetchFn });
      assert.equal(res.status, 503);
      assert.include((await errorOf(res)).message, "LATH_RPC_URL");
    });
  });

  describe("what comes back from a failing upstream", () => {
    it("keeps the status and the JSON-RPC code, scrubs the message and drops the rest", async () => {
      const { fetchFn } = upstream(
        () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32429, message: `rate limited for ${UPSTREAM}` } }),
            { status: 429, headers: { "x-ratelimit-key": KEY } }
          )
      );
      const res = await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn });
      assert.equal(res.status, 429);
      assert.isNull(res.headers.get("x-ratelimit-key"));
      const text = await res.text();
      assert.notInclude(text, KEY);
      assert.equal(JSON.parse(text).error.code, -32429);
    });

    it("replaces a non-JSON error page with a line of its own", async () => {
      const { fetchFn } = upstream(() => new Response(`<html>502 at ${UPSTREAM}</html>`, { status: 502 }));
      const res = await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn });
      assert.equal(res.status, 502);
      const text = await res.text();
      assert.notInclude(text, "<html>");
      assert.notInclude(text, KEY);
    });

    it("keeps a spent plan's plain 429 words, so the browser can say why rather than retry", async () => {
      const { fetchFn } = upstream(() => new Response("max usage reached", { status: 429 }));
      const res = await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn });
      assert.equal(res.status, 429);
      assert.include(JSON.parse(await res.text()).error.message, "max usage reached");
      // Not on another status, and not text that is not plain words.
      const page = upstream(() => new Response(`max usage reached at ${UPSTREAM}`, { status: 429 }));
      const other = await proxyRpc(post(call("getBalance")), RPC, { fetch: page.fetchFn });
      assert.notInclude(await other.text(), "max usage");
    });

    it("answers 504 when the upstream does not answer in time, and 502 when it cannot be reached", async () => {
      const hung = (async (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
        })) as unknown as typeof fetch;
      const slow = await proxyRpc(post(call("getBalance")), RPC, { fetch: hung, timeoutMs: 50 });
      assert.equal(slow.status, 504);

      const down = (async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: new Error(`connect ECONNREFUSED ${UPSTREAM}`) });
      }) as unknown as typeof fetch;
      const res = await proxyRpc(post(call("getBalance")), RPC, { fetch: down });
      assert.equal(res.status, 502);
      assert.notInclude(await res.text(), KEY);
    });
  });

  describe("an upstream answer past the cap", () => {
    const CAP = 64 * 1024;

    it("is refused 502 on its declared length, before a byte is read", async () => {
      let pulled = 0;
      const { fetchFn } = upstream(
        () =>
          new Response(
            new ReadableStream({
              pull(c) {
                pulled++;
                c.enqueue(new Uint8Array(1024));
              },
            }),
            { headers: { "content-length": String(CAP + 1) } }
          )
      );
      const res = await proxyRpc(post(call("getAccountInfo")), RPC, { fetch: fetchFn, maxAnswerBytes: CAP });
      assert.equal(res.status, 502);
      assert.include((await errorOf(res)).message, `larger than ${CAP} bytes`);
      // A stream starts one pull ahead of any reader; nothing past that was asked for.
      assert.isAtMost(pulled, 1);
    });

    it("is refused 502 when it only streams past the cap, and the rest is never pulled", async () => {
      // An upstream that would answer forever: the proxy must stop at the cap, not at the end.
      let sent = 0;
      let cancelled = false;
      const { fetchFn } = upstream(
        () =>
          new Response(
            new ReadableStream({
              pull(c) {
                sent += 16 * 1024;
                c.enqueue(new Uint8Array(16 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            })
          )
      );
      const res = await proxyRpc(post(call("getAccountInfo")), RPC, { fetch: fetchFn, maxAnswerBytes: CAP });
      assert.equal(res.status, 502);
      assert.isTrue(cancelled, "the upstream stream was not cancelled");
      assert.isBelow(sent, CAP + 4 * 16 * 1024, "the proxy kept reading past the cap");
    });

    it("passes an answer at the cap, and the default is above the app's largest read", async () => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(CAP - 40) });
      assert.isAtMost(body.length, CAP);
      const { fetchFn } = upstream(() => new Response(body));
      const res = await proxyRpc(post(call("getAccountInfo")), RPC, { fetch: fetchFn, maxAnswerBytes: CAP });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), body);
      // 440 719 bytes is a measured devnet agent list (622 headers in one page).
      assert.isAtLeast(MAX_ANSWER_BYTES, 8 * 440_719);
    });
  });

  describe("program scans", () => {
    const BILLING = "CkZfjbgWBDu4q9YVuxDVnSxnKLukaGkwZuQG7LenKDSA";
    const SCANNING: ProxyTarget = { ...RPC, programIds: new Set([BILLING]) };
    const filters = [{ dataSize: 120 }, { memcmp: { offset: 8, bytes: "11111111111111111111111111111111" } }];

    it("forwards a filtered scan of a listed program, as listAllowancesByUser sends it", async () => {
      const { seen, fetchFn } = upstream(() => new Response('{"jsonrpc":"2.0","id":1,"result":[]}'));
      const res = await proxyRpc(
        post(call("getProgramAccounts", 1, [BILLING, { encoding: "base64", filters }])),
        SCANNING,
        { fetch: fetchFn }
      );
      assert.equal(res.status, 200);
      assert.lengthOf(seen, 1);
    });

    it("refuses another program, and a scan with no filter, before the upstream", async () => {
      const { seen, fetchFn } = upstream(() => new Response("{}"));
      for (const params of [
        ["BPFLoaderUpgradeab1e11111111111111111111111", { filters }],
        [BILLING],
        [BILLING, { encoding: "base64" }],
        [BILLING, { filters: [] }],
        [],
      ]) {
        const res = await proxyRpc(post(call("getProgramAccounts", 1, params)), SCANNING, { fetch: fetchFn });
        assert.equal(res.status, 403, JSON.stringify(params));
        assert.notEqual((await errorOf(res)).code, -32601);
      }
      assert.lengthOf(seen, 0);
    });

    it("lists the billing program, the one the browser scans", () => {
      process.env.LATH_RPC_URL ??= "https://rpc.invalid";
      const { SCANNED_PROGRAMS } = require("../frontend/src/app/api/rpc/limits");
      const { LATH_BILLING_IDL } = require("@lath/sdk");
      // Every other program's id is refused: the billing program is the only one scanned.
      assert.sameMembers([...SCANNED_PROGRAMS], [LATH_BILLING_IDL.address]);
    });
  });

  describe("the caller's bucket", () => {
    const ok = () => upstream(() => new Response('{"jsonrpc":"2.0","id":1,"result":0}'));

    it("weighs scans and proofs above a plain read, and a batch as the sum of its calls", () => {
      assert.equal(weightOf([{ method: "getBalance" }]), 1);
      assert.equal(weightOf([{ method: "getProgramAccounts" }]), CALL_WEIGHT.getProgramAccounts);
      assert.equal(weightOf([{ method: "getValidityProofV2" }]), CALL_WEIGHT.getValidityProofV2);
      assert.isAbove(CALL_WEIGHT.getProgramAccounts, 1);
      assert.equal(weightOf(Array.from({ length: 5 }, () => ({ method: "getTransaction" }))), 5);
    });

    it("answers 429 with Retry-After once a caller's units are spent, and refills with time", async () => {
      const { seen, fetchFn } = ok();
      const buckets = tokenBuckets(60, 10);
      const at = 1_000_000;
      for (let i = 0; i < 10; i++) {
        const res = await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn, caller: "a", buckets, now: at });
        assert.equal(res.status, 200, `call ${i + 1}`);
      }
      const spent = await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn, caller: "a", buckets, now: at });
      assert.equal(spent.status, 429);
      assert.equal(spent.headers.get("retry-after"), "1");
      const err = await errorOf(spent);
      assert.include(err.message, "rate limit");
      // Not the provider's spent plan, which the browser reads as a different thing.
      assert.notInclude(err.message, "max usage reached");
      assert.lengthOf(seen, 10);
      // Another caller has its own bucket; a second later this one has a unit again.
      assert.equal(
        (await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn, caller: "b", buckets, now: at })).status,
        200
      );
      assert.equal(
        (await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn, caller: "a", buckets, now: at + 1_000 }))
          .status,
        200
      );
    });

    it("charges a scan its weight, and charges nothing for a request it refuses", async () => {
      const { fetchFn } = ok();
      const buckets = tokenBuckets(60, 12);
      const at = 5_000_000;
      const scan = call("getProgramAccounts", 1, ["P", { filters: [{ dataSize: 1 }] }]);
      const target = { ...RPC, programIds: new Set(["P"]) };
      // Refusals first: a method not served, and a scan of another program. Neither spends a unit.
      for (let i = 0; i < 50; i++) {
        await proxyRpc(post(call("requestAirdrop")), target, { fetch: fetchFn, caller: "a", buckets, now: at });
        await proxyRpc(post(call("getProgramAccounts", 1, ["Q", { filters: [] }])), target, {
          fetch: fetchFn,
          caller: "a",
          buckets,
          now: at,
        });
      }
      assert.equal((await proxyRpc(post(scan), target, { fetch: fetchFn, caller: "a", buckets, now: at })).status, 200);
      // Two units left of twelve: a second scan of ten is refused, two plain reads are not.
      assert.equal((await proxyRpc(post(scan), target, { fetch: fetchFn, caller: "a", buckets, now: at })).status, 429);
      for (let i = 0; i < 2; i++)
        assert.equal(
          (await proxyRpc(post(call("getBalance")), target, { fetch: fetchFn, caller: "a", buckets, now: at })).status,
          200
        );
    });

    it("charges a batch larger than the whole burst the burst, so it is slow rather than impossible", async () => {
      const { fetchFn } = upstream((body) => new Response(JSON.stringify(JSON.parse(body).map(() => null))));
      const buckets = tokenBuckets(60, 50);
      const batch = Array.from({ length: MAX_BATCH }, (_, i) => call("getTransaction", i));
      assert.equal((await proxyRpc(post(batch), RPC, { fetch: fetchFn, caller: "a", buckets, now: 0 })).status, 200);
      assert.equal((await proxyRpc(post(batch), RPC, { fetch: fetchFn, caller: "a", buckets, now: 0 })).status, 429);
      assert.equal(
        (await proxyRpc(post(batch), RPC, { fetch: fetchFn, caller: "a", buckets, now: 50_000 })).status,
        200
      );
    });

    it("charges an unproxied caller in one shared bucket of many callers' worth, and a vouched-for one in its own", async () => {
      // `proxyRpc` itself still charges nobody it is given no caller for; the routes always give one.
      const { seen, fetchFn } = ok();
      const buckets = tokenBuckets(60, 1);
      for (let i = 0; i < 5; i++) await proxyRpc(post(call("getBalance")), RPC, { fetch: fetchFn, buckets, now: 0 });
      assert.lengthOf(seen, 5);
      process.env.LATH_RPC_URL ??= "https://rpc.invalid";
      const { proxyLimits } = require("../frontend/src/app/api/rpc/limits");
      const { LOCAL_CALLERS } = require("../frontend/src/app/api/_lib/runner");
      const was = process.env.LATH_TRUST_PROXY;
      try {
        // Untrusted, the forwarded address is not believed: every request is `local`, and `local`
        // is charged — uncharged, the provider's quota would be open to any script.
        delete process.env.LATH_TRUST_PROXY;
        const local = proxyLimits(post(call("getBalance"), { "x-forwarded-for": "203.0.113.9" }));
        assert.equal(local.caller, "local");
        assert.isFunction(local.buckets.take);
        assert.strictEqual(proxyLimits(post(call("getBalance"))).buckets, local.buckets);
        // It holds `LOCAL_CALLERS` addresses' worth, so one visitor's burst is not everybody's refusal.
        const perAddress = Number(process.env.LATH_RPC_UNITS_PER_MINUTE ?? 1200);
        const probe = `probe-${Date.now()}`;
        assert.isNull(local.buckets.take(probe, perAddress * LOCAL_CALLERS, 0));
        assert.isNotNull(local.buckets.take(probe, 1, 0));
        process.env.LATH_TRUST_PROXY = "1";
        const limits = proxyLimits(post(call("getBalance"), { "x-forwarded-for": "203.0.113.9" }));
        assert.equal(limits.caller, "203.0.113.9");
        assert.isFunction(limits.buckets.take);
        assert.notStrictEqual(limits.buckets, local.buckets, "an address's bucket is one address's worth");
        // One set of buckets for both routes, whichever module graph asks.
        assert.strictEqual(proxyLimits(post(call("getBalance"), { "x-real-ip": "1.2.3.4" })).buckets, limits.buckets);
      } finally {
        if (was === undefined) delete process.env.LATH_TRUST_PROXY;
        else process.env.LATH_TRUST_PROXY = was;
      }
    });

    it("drops a bucket that has refilled, so quiet callers do not accumulate", () => {
      const store = new Map<string, { tokens: number; at: number }>();
      const buckets = tokenBuckets(60, 10, store);
      for (let i = 0; i < 100; i++) buckets.take(`caller-${i}`, 1, 0);
      assert.equal(store.size, 100);
      buckets.take("late", 1, 61_000);
      assert.equal(store.size, 1);
    });
  });

  it("finds the credentials in the url shapes providers use", () => {
    assert.include(upstreamSecrets(UPSTREAM), KEY);
    assert.include(upstreamSecrets("https://user:s3cretpassword@rpc.example"), "s3cretpassword");
    assert.include(upstreamSecrets("https://x.quiknode.pro/abcdef0123456789abcdef/"), "abcdef0123456789abcdef");
    assert.equal(scrub(`a ${KEY} b ${UPSTREAM}`, upstreamSecrets(UPSTREAM)), "a … b …");
  });
});
