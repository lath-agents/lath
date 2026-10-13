import { consoleOrigin } from "./fixtures/trace-dir";
import { jsonRequest } from "./fixtures/request";
import { assert } from "chai";
import * as nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { authMessage, hex } from "@lath/sdk";
import { acquireRunSlot, callerShare, rateLimit } from "../frontend/src/app/api/_lib/runner";
import { LoopRecord, readLoop, recordLoop } from "../frontend/src/app/api/_lib/loops";
import { recordTemplate } from "../frontend/src/app/api/_lib/templates";
import { POST as templatesPOST, PUT as templatesPUT } from "../frontend/src/app/api/templates/route";
// Loaded through `require` so the root `tsc` does not follow the route's type import into
// `frontend/src/lib/loops.ts`, a client module that only compiles under the frontend's config.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: loopsPOST } = require("../frontend/src/app/api/loops/route") as {
  POST: (req: Request) => Promise<Response>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: runPOST } = require("../frontend/src/app/api/run/route") as {
  POST: (req: Request) => Promise<Response>;
};

/**
 * A request a route refuses charges none of the caller's hourly quota — the shape `/api/agents`
 * has, held on every other route that charges one. Each case sends a
 * run of refusals through the route's own `POST`/`PUT` with a real wallet signature, then counts
 * what is left in the bucket the route charges: the whole hour, when nothing was charged.
 *
 * The bucket is probed with `rateLimit` itself, on the key the route builds. `callerIp` is `local`
 * here (no `LATH_TRUST_PROXY`), so the key is the route's prefix, the wallet and `local`. Every case
 * uses a fresh wallet, so the probe spending the bucket leaves no other case short.
 *
 * Nothing reaches a cluster: every refusal below reads the local registry, loop store, template
 * store or run slot only. `POST /api/run`'s 402 needs an allowance read off a cluster, so its ordering is not
 * exercised here; its busy slot is, because that refusal comes before any read.
 */

const TEMPLATE_WRITES_PER_HOUR = Number(process.env.LATH_TEMPLATE_WRITES_PER_HOUR ?? 30);
/** `/api/run`'s sessions per caller and hour (`PER_HOUR` in the route), a literal there too. */
const SESSIONS_PER_HOUR = 6;
const LOOP_COMMANDS_PER_HOUR = Number(process.env.LATH_LOOP_COMMANDS_PER_HOUR ?? 60);

const config = {
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

/** A real signature over the canonical message, with a nonce no other case has used. */
function auth(wallet: Keypair, purpose: Parameters<typeof authMessage>[0], bound: { action: string; target: string }) {
  const message = authMessage(purpose, {
    ...bound,
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

const request = (body: unknown, method = "POST") => jsonRequest(body, { method });

/**
 * A real `Request` for `POST /api/loops`, which reads its body as a capped stream rather than
 * through `req.json()`, so a stub with only `json` would arrive as an empty body.
 */
const loopsRequest = (body: unknown) =>
  new Request("http://localhost:3000/api/loops", { method: "POST", body: JSON.stringify(body) });

/** How many charges the bucket still takes before it refuses — spending them to find out. */
function left(what: string, key: string, perHour: number): number {
  let n = 0;
  while (n <= perHour && rateLimit(what, key, perHour) === null) n++;
  return n;
}

describe("a refused request charges no hourly quota", () => {
  const server = Keypair.generate();
  before(() => {
    process.env.LATH_RUNTIME_KEYPAIR = JSON.stringify(Array.from(server.secretKey));
  });

  describe("POST and PUT /api/templates", () => {
    const TEMPLATE = "Lath template" as const;

    it("charges no write for a body it refuses, on either verb", async () => {
      const wallet = Keypair.generate();
      const other = "So11111111111111111111111111111111111111112";
      const theirs = recordTemplate({ kind: "agent", owner: other, name: "sr-w52-theirs", config });
      const post = (body: Record<string, unknown>, action = "write") =>
        templatesPOST(request({ ...body, auth: auth(wallet, TEMPLATE, { action, target: String(body.id ?? "new") }) }));
      const put = (body: Record<string, unknown>) =>
        templatesPUT(
          request({ ...body, auth: auth(wallet, TEMPLATE, { action: "append", target: String(body.id) }) }, "PUT")
        );

      for (let i = 0; i < TEMPLATE_WRITES_PER_HOUR + 2; i++) {
        assert.equal((await post({ kind: "neither", name: "sr-w52", config })).status, 400, "a bad kind");
        assert.equal((await post({ kind: "agent", name: "", config })).status, 400, "a bad name");
        assert.equal((await post({ kind: "agent", name: "sr-w52", config: { model: "" } })).status, 400, "bad config");
        assert.equal(
          (await post({ kind: "agent", name: "sr-w52", config, clonedFrom: { id: "nope", version: 1 } })).status,
          400,
          "a lineage that names nothing"
        );
        assert.equal((await post({ id: theirs.id, action: "archive" }, "archive")).status, 403, "archiving theirs");
        assert.equal((await put({ id: theirs.id, config })).status, 403, "appending to theirs");
      }

      assert.equal(
        left("template writes", `template:${wallet.publicKey.toBase58()}:local`, TEMPLATE_WRITES_PER_HOUR),
        TEMPLATE_WRITES_PER_HOUR,
        "every write of the hour is still there"
      );
    });

    it("still charges a write that lands", async () => {
      const wallet = Keypair.generate();
      const res = await templatesPOST(
        request({
          kind: "agent",
          name: "sr-w52-lands",
          config,
          auth: auth(wallet, TEMPLATE, { action: "write", target: "new" }),
        })
      );
      assert.equal(res.status, 200);
      assert.equal(
        left("template writes", `template:${wallet.publicKey.toBase58()}:local`, TEMPLATE_WRITES_PER_HOUR),
        TEMPLATE_WRITES_PER_HOUR - 1
      );
    });
  });

  describe("POST /api/run, a busy slot", () => {
    it("charges no session when another writer holds the run slot", async () => {
      // Another writer's step: what the session's admission refuses with a 429 before it reads the
      // chain or charges the hour's sessions. Anonymous and with no target, so the console's own agent is asked and nothing
      // is read off a cluster on the way to the slot.
      const slot = acquireRunSlot("a loop step (test)", 60_000);
      assert.isNotNull(slot, "the slot is free when the case starts");
      const perHour = SESSIONS_PER_HOUR * callerShare("local");
      try {
        for (let i = 0; i < SESSIONS_PER_HOUR + 2; i++) {
          const res = await runPOST(new Request("http://localhost:3000/api/run", { method: "POST", body: "{}" }));
          assert.equal(res.status, 429, "the busy slot");
          assert.match(((await res.json()) as { error: string }).error, /another run is in progress/);
        }
      } finally {
        slot!.release();
      }
      assert.equal(left("sessions", "ip:local", perHour), perHour, "every session of the hour is still there");
    });
  });

  describe("POST /api/loops, a command", () => {
    const loopRow = (id: string, owner: string): LoopRecord => ({
      id,
      agentId: "aa".repeat(32),
      agentName: `sr-w52-${id}`,
      owner,
      prompt: "watch the fee market",
      promptHash: "cd".repeat(32),
      intervalMs: 60_000,
      maxSteps: 4,
      budgetMicroUsdcPerStep: "50000",
      model: config.model,
      createdAt: Date.now(),
      // Stopped, so the scheduler the route syncs has nothing to start for it.
      status: "stopped",
      snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
      history: [],
    });

    it("refuses a body over 256 KiB with a 413, before it is parsed or anything is charged", async () => {
      // Before the signature and before any bucket, `req.json()` would parse whatever Next's 10 MB
      // body clone let through: seconds of a blocked event loop per anonymous request.
      const big = JSON.stringify({ action: "check-sources", x: "a".repeat(256 * 1024) });
      const streamed = await loopsPOST(new Request("http://localhost:3000/api/loops", { method: "POST", body: big }));
      assert.equal(streamed.status, 413);
      assert.match(((await streamed.json()) as { error: string }).error, /too large \(256 KiB at most\)/);
      // A declared length past the cap is refused before a byte of the body is read.
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
        },
      });
      const declared = await loopsPOST(
        new Request("http://localhost:3000/api/loops", {
          method: "POST",
          headers: { "content-length": String(10 * 1024 * 1024) },
          body,
          duplex: "half",
        } as RequestInit)
      );
      assert.equal(declared.status, 413);
      assert.isAtMost(pulled, 1, "the stream is cancelled, not read");
      // And a real body under the cap is read as before: an empty check is answered, not refused.
      const small = await loopsPOST(loopsRequest({ action: "check-sources", sources: [] }));
      assert.notEqual(small.status, 413);
    });

    it("charges no command for an unknown loop, another wallet's, or an un-archive of a live one", async () => {
      const wallet = Keypair.generate();
      const mine = `loop-sr-w52-mine-${Date.now() % 1e6}`;
      const theirs = `loop-sr-w52-theirs-${Date.now() % 1e6}`;
      recordLoop(loopRow(mine, wallet.publicKey.toBase58()));
      recordLoop(loopRow(theirs, "So11111111111111111111111111111111111111112"));
      const command = (action: string, id: string) =>
        loopsPOST(loopsRequest({ action, id, auth: auth(wallet, "Lath loop", { action, target: id }) }));

      for (let i = 0; i < LOOP_COMMANDS_PER_HOUR + 2; i++) {
        assert.equal((await command("pause", "loop-sr-w52-nowhere")).status, 404, "an unknown loop");
        assert.equal((await command("pause", theirs)).status, 403, "another wallet's loop");
        assert.equal((await command("unarchive", mine)).status, 409, "un-archiving a loop not archived");
      }

      assert.equal(
        left("loop commands", `loop-cmd:${wallet.publicKey.toBase58()}:local`, LOOP_COMMANDS_PER_HOUR),
        LOOP_COMMANDS_PER_HOUR,
        "every command of the hour is still there"
      );
    });

    it("charges no command for a resume, a step, a stop or a discard the loop record already refuses", async () => {
      const wallet = Keypair.generate();
      const stopped = `loop-sr-w52-stopped-${Date.now() % 1e6}`;
      const spent = `loop-sr-w52-spent-${Date.now() % 1e6}`;
      // On the goal, so the stop below has a reason to keep: `goal-reached` is what owes a receipt.
      recordLoop({ ...loopRow(stopped, wallet.publicKey.toBase58()), stopReason: "goal-reached" });
      // Paused with every step taken: the one paused loop a resume still refuses.
      const row = loopRow(spent, wallet.publicKey.toBase58());
      recordLoop({ ...row, status: "paused", snapshot: { ...row.snapshot, steps: row.maxSteps } });
      const command = async (action: string, id: string) => {
        const res = await loopsPOST(
          loopsRequest({ action, id, auth: auth(wallet, "Lath loop", { action, target: id }) })
        );
        return { status: res.status, error: ((await res.json()) as { error: string }).error };
      };

      for (let i = 0; i < LOOP_COMMANDS_PER_HOUR + 2; i++) {
        const resumeStopped = await command("resume", stopped);
        assert.equal(resumeStopped.status, 409, "resuming a stopped loop");
        assert.match(resumeStopped.error, /cannot resume/);
        assert.equal((await command("resume", spent)).status, 409, "resuming a loop out of steps");
        // *Step now* belongs to gated loops: the verb is unknown, refused before anything is charged.
        const step = await command("step", stopped);
        assert.equal(step.status, 400, "Step now is not a verb in this build");
        assert.match(step.error, /^unknown action: step/);
        const discard = await command("discard", stopped);
        assert.equal(discard.status, 409, "discarding a run that did not stop on anchor-failed");
        assert.match(discard.error, /anchor-failed/);
        // A second stop must not rewrite the first's reason to `stopped`.
        const stop = await command("stop", stopped);
        assert.equal(stop.status, 409, "stopping a run already stopped");
        assert.match(stop.error, /already stopped/);
      }
      assert.equal(readLoop(stopped)!.stopReason, "goal-reached", "the reason the run stopped on stands");

      assert.equal(
        left("loop commands", `loop-cmd:${wallet.publicKey.toBase58()}:local`, LOOP_COMMANDS_PER_HOUR),
        LOOP_COMMANDS_PER_HOUR,
        "every command of the hour is still there"
      );
    });
  });
});
