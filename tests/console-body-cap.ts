import "./fixtures/trace-dir";
import { assert } from "chai";
import { Keypair } from "@solana/web3.js";
import { WRITE_BODY_BYTES, asBody, bodyTooLarge, readJsonCapped } from "../frontend/src/app/api/rpc/proxy";
import { POST as deployPOST } from "../frontend/src/app/api/agents/route";
import { POST as agentPOST } from "../frontend/src/app/api/agents/[id]/route";
import { POST as storePOST } from "../frontend/src/app/api/store/[id]/route";
import { POST as templatesPOST, PUT as templatesPUT } from "../frontend/src/app/api/templates/route";
import { jsonRequest, rawRequest } from "./fixtures/request";

/**
 * An app-router handler has no body limit, so a write route that read its body with `req.json()`
 * would buffer and parse an unsigned body of hundreds of megabytes before it looked at the
 * signature. Each route reads through the
 * RPC proxy's `readJsonCapped`, which counts the bytes as they arrive and stops where they cross the
 * cap, whether the body declared its length or not. `/api/run`'s own case is `console-run-limits`'s.
 *
 * Every case here is refused before anything is signed, charged or written: the deploy and clone
 * routes are handed a server key so they get as far as the body, and nothing
 * reaches a cluster (`./fixtures/trace-dir` points the RPC at `rpc.invalid`).
 */

const STORE_BODY_BYTES = 16 * 1024;
const AGENT = "ab".repeat(32);

/** A JSON body of exactly `bytes` bytes: one string field padded to the length. */
function bodyOfLength(bytes: number): string {
  const shell = JSON.stringify({ auth: "" });
  return JSON.stringify({ auth: "x".repeat(bytes - shell.length) });
}

/**
 * A body with no `Content-Length` that never ends: 64 KiB chunks for as long as anyone pulls. A
 * reader that trusted the header, or read to the end before counting, would never come back; the
 * count of chunks pulled is how far the route read before it stopped.
 */
function endless(): { req: any; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0;
  let cancelled = false;
  const chunk = new TextEncoder().encode(`{"auth":"${"y".repeat(64 * 1024)}`);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request("http://localhost:3000/", { method: "POST", body, duplex: "half" } as RequestInit);
  assert.isNull(req.headers.get("content-length"), "the endless body declares no length");
  return { req, pulled: () => pulled, cancelled: () => cancelled };
}

describe("readJsonCapped: a write route's body, read whole and bounded", () => {
  it("parses a body under the cap, and calls one that is not JSON undefined", async () => {
    assert.deepEqual(await readJsonCapped(jsonRequest({ a: 1 })), { json: { a: 1 } });
    assert.deepEqual(await readJsonCapped(rawRequest("not json")), { json: undefined });
    assert.deepEqual(await readJsonCapped(jsonRequest(undefined)), { json: undefined }, "no body at all");
  });

  it("takes a body of exactly the cap, and refuses one byte more", async () => {
    assert.isNotNull(await readJsonCapped(rawRequest(bodyOfLength(1024)), 1024));
    assert.isNull(await readJsonCapped(rawRequest(bodyOfLength(1025)), 1024));
    assert.isNotNull(await readJsonCapped(rawRequest(bodyOfLength(WRITE_BODY_BYTES))));
    assert.isNull(await readJsonCapped(rawRequest(bodyOfLength(WRITE_BODY_BYTES + 1))));
  });

  it("stops reading a body that declares no length where it crosses the cap, and cancels it", async () => {
    const { req, pulled, cancelled } = endless();
    assert.isNull(await readJsonCapped(req));
    // 256 KiB of 64 KiB chunks is four, the fifth crosses; a stream pulls one ahead at most.
    assert.isAtMost(pulled(), 7, "the reader went on past the cap");
    assert.isTrue(cancelled(), "the rest of the body was left to arrive");
  });

  it("reads anything that is not an object as an empty body", () => {
    for (const v of [null, undefined, [], [1], "s", 3, true]) assert.deepEqual(asBody(v), {}, JSON.stringify(v));
    assert.deepEqual(asBody({ a: 1 }), { a: 1 });
  });

  it("answers past the cap with 413, naming it", async () => {
    const res = bodyTooLarge();
    assert.equal(res.status, 413);
    assert.match(((await res.json()) as { error: string }).error, /too large \(256 KiB at most\)/);
  });
});

describe("every write route refuses a body past its cap before it parses one", () => {
  const server = Keypair.generate();
  const saved = process.env.LATH_RUNTIME_KEYPAIR;
  before(() => {
    // Read at call time by `loadKeypair`: without one the deploy and clone routes
    // answer 503 before the body, and this suite is about the body.
    process.env.LATH_RUNTIME_KEYPAIR = JSON.stringify(Array.from(server.secretKey));
  });
  after(() => {
    if (saved === undefined) delete process.env.LATH_RUNTIME_KEYPAIR;
    else process.env.LATH_RUNTIME_KEYPAIR = saved;
  });

  const params = { params: Promise.resolve({ id: AGENT }) };
  const routes: Array<[string, (req: any) => Promise<Response>, number]> = [
    ["POST /api/agents", (req) => deployPOST(req), WRITE_BODY_BYTES],
    ["POST /api/agents/[id]", (req) => agentPOST(req, params), WRITE_BODY_BYTES],
    ["POST /api/store/[id]", (req) => storePOST(req, params), STORE_BODY_BYTES],
    ["POST /api/templates", (req) => templatesPOST(req), WRITE_BODY_BYTES],
    ["PUT /api/templates", (req) => templatesPUT(req), WRITE_BODY_BYTES],
  ];
  const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error ?? "";

  for (const [name, route, cap] of routes) {
    it(`${name}: 413 one byte past ${cap / 1024} KiB, and an endless body is cut at the cap`, async () => {
      const over = await route(rawRequest(bodyOfLength(cap + 1)));
      assert.equal(over.status, 413, name);
      assert.match(await errorOf(over), new RegExp(`too large \\(${cap / 1024} KiB at most\\)`));

      const { req, pulled, cancelled } = endless();
      const cut = await route(req);
      assert.equal(cut.status, 413, `${name}, streamed`);
      assert.isAtMost(pulled(), Math.ceil(cap / (64 * 1024)) + 3, `${name} read on past its cap`);
      assert.isTrue(cancelled(), `${name} left the rest of the body to arrive`);

      // At the cap the body is read and parsed, and refused for what it says instead: its `auth`
      // is a string, which no route takes as a signature. Not 413, and not a 500 either — `walletIn`
      // threw on a string `auth` before `verifyAuth` could refuse it.
      const at = await route(rawRequest(bodyOfLength(cap)));
      assert.notEqual(at.status, 413, `${name} refused a body of exactly its cap`);
      assert.isBelow(at.status, 500, `${name} at its cap: ${await errorOf(at.clone())}`);
    });
  }

  it("the store write still says what is wrong with a small body: not JSON, or not a key and a value", async () => {
    const notJson = await storePOST(rawRequest("{"), params);
    assert.equal(notJson.status, 400);
    assert.equal(await errorOf(notJson), "body is not JSON");
    // `null` is an empty body, rather than reaching `body.key` as itself and throwing a 500.
    for (const body of [null, [], { key: 1, value: "v" }]) {
      const res = await storePOST(jsonRequest(body), params);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(await errorOf(res), "key and value are strings");
    }
  });

  it("a deploy, a clone and a template write read a body that is not an object as an empty one", async () => {
    // Each answers its empty-body refusal rather than throwing on a field read off `null`.
    for (const body of [null, [1, 2], "text"]) {
      for (const [name, route] of [
        ["POST /api/agents", (req: any) => deployPOST(req)],
        ["POST /api/agents/[id]", (req: any) => agentPOST(req, params)],
        ["POST /api/templates", (req: any) => templatesPOST(req)],
      ] as const) {
        const res = await route(jsonRequest(body));
        assert.isBelow(res.status, 500, `${name} on ${JSON.stringify(body)}: ${await errorOf(res.clone())}`);
      }
    }
  });
});
