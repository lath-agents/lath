import "./fixtures/trace-dir";
import { consoleOrigin } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as http from "http";
import { AddressInfo } from "net";
import * as nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { authMessage, hex, idFromString } from "@lath/sdk";

/**
 * What `/api/run` costs a stranger before it decides anything.
 *
 * The route is driven through its own `GET` and `POST` against a counting stand-in for the RPC,
 * so every assertion about cost is a count of requests that actually left the process. The
 * stand-in answers every JSON-RPC call with an empty value (no account, a zero balance), which is
 * what the route reads as "nothing registered yet" — so no case ever reaches a write: each one is
 * refused before the run slot is taken, by a check, by a bucket, or by the session counter that a
 * case has emptied on purpose.
 *
 * The limits are set small here and read once, when the route module loads, which is why the
 * runner and the route are `require`d inside `before` after the environment is in place, and why
 * this file must run in its own mocha process (as every `console-*` suite does).
 */

const READS = 3;
const READS_SERVER = 9;
const UNBILLED = 2;

interface Upstream {
  url: string;
  calls: string[];
  close(): Promise<void>;
}

function startUpstream(): Promise<Upstream> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* answered below either way */
      }
      const one = (call: any) => {
        calls.push(String(call?.method));
        const value = call?.method === "getBalance" ? 0 : null;
        return { jsonrpc: "2.0", id: call?.id ?? null, result: { context: { slot: 1 }, value } };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    })
  );
}

describe("/api/run: body caps and the quota a stranger can spend", () => {
  const server = Keypair.generate();
  let upstream: Upstream;
  let route: {
    GET: (req: any) => Promise<Response>;
    POST: (req: any) => Promise<Response>;
  };
  let runner: typeof import("../frontend/src/app/api/_lib/runner");
  const saved: Record<string, string | undefined> = {};
  const env = (name: string, value: string | undefined) => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  before(async () => {
    upstream = await startUpstream();
    env("LATH_RPC_URL", upstream.url);
    env("LATH_PHOTON_URL", undefined);
    env("LATH_PROVER_URL", undefined);
    env("LATH_RUNTIME_KEYPAIR", JSON.stringify(Array.from(server.secretKey)));
    env("LATH_RUN_READS_PER_HOUR", String(READS));
    env("LATH_RUN_READS_PER_HOUR_SERVER", String(READS_SERVER));
    env("LATH_UNBILLED_SESSIONS_PER_HOUR", String(UNBILLED));
    // The epoch probe is a `getAccountInfo` cached per process; pinned off, so the only reads
    // counted are the ones this suite is about.
    env("LATH_EPOCHS", "0");
    env("LATH_TEMPO_TREASURY", undefined);
    env("LATH_TRUST_PROXY", "1");
    runner = require("../frontend/src/app/api/_lib/runner");
    route = require("../frontend/src/app/api/run/route");
  });

  after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await upstream.close();
  });

  const headers = (ip: string) => new Headers({ "content-type": "application/json", "x-forwarded-for": ip });
  const post = (ip: string, body: unknown) =>
    route.POST(
      new Request("http://localhost:3000/api/run", {
        method: "POST",
        headers: headers(ip),
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
  const get = (ip: string, agent?: string) => {
    const url = new URL(`http://localhost:3000/api/run${agent ? `?agent=${agent}` : ""}`);
    return route.GET({ nextUrl: url, headers: headers(ip) });
  };
  /** A route's JSON answer, untyped: these cases read whichever field the status promises. */
  const json = (res: Response): Promise<any> => res.json();
  /** Requests that reached the stand-in while `fn` ran. */
  async function reads<T>(fn: () => Promise<T>): Promise<{ result: T; n: number }> {
    const before = upstream.calls.length;
    const result = await fn();
    return { result, n: upstream.calls.length - before };
  }
  /** How many charges the bucket still takes before it refuses — spending them to find out. */
  function left(what: string, key: string, perHour: number): number {
    let n = 0;
    while (n <= perHour && runner.rateLimit(what, key, perHour) === null) n++;
    return n;
  }
  function auth(wallet: Keypair, target: string) {
    const message = authMessage("Lath console session", {
      action: "session",
      target,
      ...consoleOrigin,
      cluster: "devnet",
      wallet: wallet.publicKey.toBase58(),
      issued: new Date().toISOString(),
      nonce: hex(nacl.randomBytes(16)),
    });
    return {
      message,
      signature: Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), wallet.secretKey)).toString("base64"),
    };
  }
  const consoleAgent = () => hex(idFromString(runner.roles(server).agent.name));
  const randomId = () => hex(nacl.randomBytes(32));

  describe("what a session's body may carry", () => {
    // Every case here that passes the text checks is stopped by a held run slot, which is the
    // first thing after them and costs nothing: a 429 naming the slot means the body was accepted.
    let slot: ReturnType<typeof runner.acquireRunSlot>;
    before(() => {
      slot = runner.acquireRunSlot("console-run-limits", 60_000);
      assert.ok(slot, "the suite holds the run slot");
    });
    after(() => slot?.release());

    it("refuses a body over 256 KiB with 413 before parsing it, and reads nothing", async () => {
      const { result, n } = await reads(() => post("10.9.0.1", { prompt: "x".repeat(300 * 1024) }));
      assert.equal(result.status, 413);
      assert.match((await json(result)).error, /too large/);
      assert.equal(n, 0);
    });

    it("refuses a prompt over 2000 characters with 400, and takes one at 2000", async () => {
      const long = await post("10.9.0.1", { prompt: "y".repeat(2001) });
      assert.equal(long.status, 400);
      assert.match((await json(long)).error, /prompt is too long \(2000 characters\)/);
      const exact = await post("10.9.0.1", { prompt: "y".repeat(2000) });
      assert.equal(exact.status, 429, "past the text checks, stopped by the slot");
      assert.match((await json(exact)).error, /another run is in progress/);
    });

    it("refuses a prompt that is not a string, and a history that is not a list or is too long", async () => {
      assert.equal((await post("10.9.0.1", { prompt: 42 })).status, 400);
      assert.equal((await post("10.9.0.1", { history: "earlier" })).status, 400);
      const nine = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? "agent" : "user", text: `turn ${i}` }));
      const refused = await post("10.9.0.1", { prompt: "hi", history: nine });
      assert.equal(refused.status, 400);
      assert.match((await json(refused)).error, /at most 8 earlier turns/);
    });

    it("takes eight long turns of history, which are cut rather than refused", async () => {
      const eight = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "agent" : "user", text: "z".repeat(10_000) }));
      const res = await post("10.9.0.1", { prompt: "hi", history: eight });
      assert.equal(res.status, 429, "past the text checks, stopped by the slot");
    });

    it("still reads an unparseable or non-object body as the default session", async () => {
      for (const raw of ["{not json", "null", "[1,2]", "7"]) {
        const res = await post("10.9.0.1", raw);
        assert.equal(res.status, 429, `${raw}: past the text checks, stopped by the slot`);
      }
    });
  });

  describe("A-K: the deployed-target path reads nothing for a caller who is not the owner", () => {
    const owner = Keypair.generate();
    const name = `run-limits-${Date.now() % 1e6}`;
    const id = hex(idFromString(name));
    before(() => {
      runner.recordAgent(id, {
        name,
        authority: "AuThOrItY1111111111111111111111111111111111",
        owner: owner.publicKey.toBase58(),
        createdAt: Date.now(),
        policy: { model: "deepseek/deepseek-v4.1-flash", tools: ["solana.slot"] } as any,
      });
    });

    it("answers an unsigned caller 401 without reading the header first", async () => {
      const { result, n } = await reads(() => post("10.9.1.1", { target: { kind: "agent", id } }));
      assert.equal(result.status, 401);
      assert.equal(n, 0);
    });

    it("answers another signed wallet 403 without a read, and charges no read bucket", async () => {
      const stranger = Keypair.generate();
      const { result, n } = await reads(() =>
        post("10.9.1.1", {
          target: { kind: "agent", id },
          user: stranger.publicKey.toBase58(),
          auth: auth(stranger, id),
        })
      );
      assert.equal(result.status, 403);
      assert.equal(n, 0);
      assert.equal(left("chain reads from this address", "run-reads:10.9.1.1", READS), READS);
    });
  });

  // From here the cases share the server-wide read bucket, in order: one from the unbilled-session
  // cases (the anonymous untargeted one reads nothing and is not charged), three from the GET,
  // three from the first POST caller, and two from a second to fill it.
  describe("A-K: the server's unbilled sessions are a bucket of their own", () => {
    it("refuses an anonymous session once the server's unbilled hour is spent, without spending the caller's", async () => {
      for (let i = 0; i < UNBILLED; i++)
        runner.rateLimit("unbilled sessions on this server", "sessions:unbilled", UNBILLED);
      const res = await post("10.9.2.1", { prompt: "hi" });
      assert.equal(res.status, 429);
      const { error } = await json(res);
      assert.match(error, /unbilled sessions on this server/);
      assert.match(error, /billed to a wallet's allowance still runs/);
      assert.equal(left("sessions", "ip:10.9.2.1", 6), 6, "the caller's six are untouched");
      assert.equal(
        left("chain reads from this address", "run-reads:10.9.2.1", READS),
        READS,
        "an anonymous session on the console's own agents reads nothing first, so it is not charged a read"
      );
    });

    it("asks a targeted session's header only after the read buckets", async () => {
      const { result, n } = await reads(() => post("10.9.2.2", { target: { kind: "agent", id: consoleAgent() } }));
      assert.equal(result.status, 429, "the unbilled bucket is still spent");
      assert.equal(n, 1, "one header read, behind the buckets");
      assert.equal(left("chain reads from this address", "run-reads:10.9.2.2", READS), READS - 1);
    });
  });

  describe("A-K: GET /api/run", () => {
    it("shares the server-wide half of its answer between callers for a few seconds", async () => {
      const first = await reads(() => get("10.9.3.1"));
      assert.equal(first.result.status, 200);
      assert.equal((await json(first.result)).ready, true);
      const second = await reads(() => get("10.9.3.2"));
      assert.equal(second.result.status, 200);
      assert.equal(first.n + second.n, 1, "one getBalance for both callers");
    });

    it("charges a header read per new id, none for a cached one, and refuses past the caller's bucket", async () => {
      const ids = [randomId(), randomId(), randomId()];
      for (const id of ids) {
        const { result, n } = await reads(() => get("10.9.3.3", id));
        assert.equal(result.status, 200);
        assert.equal(n, 1, "a new id is one header read");
      }
      const again = await reads(() => get("10.9.3.3", ids[0]));
      assert.equal(again.result.status, 200);
      assert.equal(again.n, 0, "an id read in the last five minutes is answered from memory");

      const refused = await reads(() => get("10.9.3.3", randomId()));
      assert.equal(refused.result.status, 429);
      const body = await json(refused.result);
      assert.equal(body.ready, false, "a refused GET still says the runner cannot answer");
      assert.match(body.reason, /chain reads from this address/);
      assert.equal(refused.n, 0);
    });
  });

  describe("POST /api/run's reads before the session counter", () => {
    // The server's unbilled hour was spent above, so every anonymous POST below is admitted to
    // its reads and then refused by the session counters: exactly the request that would otherwise
    // read for free, every time.

    it("charges the caller's bucket once per request and refuses past it without reading", async () => {
      for (let i = 0; i < READS; i++) {
        const { result, n } = await reads(() => post("10.9.4.1", { target: { kind: "agent", id: consoleAgent() } }));
        assert.equal(result.status, 429);
        assert.match((await json(result)).error, /unbilled sessions on this server/);
        assert.equal(n, 1);
      }
      const { result, n } = await reads(() => post("10.9.4.1", { target: { kind: "agent", id: consoleAgent() } }));
      assert.equal(result.status, 429);
      assert.match((await json(result)).error, /chain reads from this address/);
      assert.equal(n, 0);
    });

    it("refuses every caller once the server's bucket is spent, without spending the caller's", async () => {
      // Seven of nine are spent above; the eighth and ninth go to a fresh caller.
      for (let i = 0; i < READS_SERVER - 7; i++) {
        const res = await post("10.9.4.2", { target: { kind: "agent", id: consoleAgent() } });
        assert.equal(res.status, 429);
        assert.match((await json(res)).error, /unbilled sessions on this server/);
      }
      const { result, n } = await reads(() => post("10.9.4.3", { target: { kind: "agent", id: consoleAgent() } }));
      assert.equal(result.status, 429);
      assert.match((await json(result)).error, /chain reads on this server/);
      assert.equal(n, 0);
      assert.equal(left("chain reads from this address", "run-reads:10.9.4.3", READS), READS);
    });
  });

  describe("the caller nobody vouched for", () => {
    it("is one caller, `local`, whose buckets hold LOCAL_CALLERS callers' worth", () => {
      // Without `LATH_TRUST_PROXY=1` every visitor is `local`. A bucket of one caller's worth would let
      // the first visitor's six sessions refuse all the others for the hour; none at all would leave
      // the quota unmetered. Shared and bounded is the policy both routes take.
      const was = process.env.LATH_TRUST_PROXY;
      try {
        delete process.env.LATH_TRUST_PROXY;
        assert.equal(runner.callerIp({ headers: headers("10.9.5.1") }), "local");
      } finally {
        if (was === undefined) delete process.env.LATH_TRUST_PROXY;
        else process.env.LATH_TRUST_PROXY = was;
      }
      assert.equal(runner.LOCAL_CALLERS, 10, "the default");
      assert.equal(runner.callerShare("local"), runner.LOCAL_CALLERS);
      assert.equal(runner.callerShare("10.9.5.1"), 1, "an address a proxy vouched for is one caller");
    });
  });
});
