import { traceDir, consoleOrigin } from "./fixtures/trace-dir";
import { jsonRequest } from "./fixtures/request";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import * as nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { authMessage, hex, idFromString, loopAuthBinding, storeWriteBinding } from "@lath/sdk";
import {
  acquireRunSlot,
  issueDeployTicket,
  lookupAgent,
  peekDeployTicket,
  recordAgent,
  roles,
} from "../frontend/src/app/api/_lib/runner";
import { cloneContext, issueCloneTicket, peekCloneTicket } from "../frontend/src/app/api/_lib/copy";
import { LoopRecord, readLoop, recordLoop } from "../frontend/src/app/api/_lib/loops";
import { betaEnabled, betaRefusal } from "../frontend/src/app/api/_lib/beta";
import { POST as deployPOST } from "../frontend/src/app/api/agents/route";
import { POST as agentPOST } from "../frontend/src/app/api/agents/[id]/route";
import { POST as storePOST } from "../frontend/src/app/api/store/[id]/route";
// Loaded through `require` so the root `tsc` does not follow these routes' type imports into the
// frontend's client modules, which compile only under the frontend's config (`console-quota-order`).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: loopsPOST } = require("../frontend/src/app/api/loops/route") as {
  POST: (req: Request) => Promise<Response>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST: runPOST } = require("../frontend/src/app/api/run/route") as {
  POST: (req: Request) => Promise<Response>;
};

/**
 * The closed beta (`frontend/src/app/api/_lib/beta.ts`): with `LATH_BETA_WALLETS` or
 * `LATH_BETA_FILE` set, only a listed wallet may take an action the treasury or the server's SOL
 * pays for, and everyone else is refused 403 with the waitlist — at every gated route's `prepare`
 * and again at the step that starts the spend.
 *
 * Every case drives a route's own `POST`, as `console-quota-order` does, with real wallet
 * signatures. Nothing reaches a cluster or a treasury: each request is shaped to be answered by a
 * local check the moment it is past the gate — a name too short, an id that is not hex, another
 * wallet's agent, a held run slot, a confirm signature that is not a signature, a sandbox binary
 * that does not exist. That is what makes "past the gate" observable: an invited wallet's answer
 * with the gate on is compared with the answer the same request gets with the gate off, and has to
 * be the same answer, while an uninvited one gets the beta's refusal instead.
 *
 * The confirms are presented tickets issued here directly, never by a `prepare` — which is the
 * "a skipped prepare cannot bypass it" case: the confirm asks the gate on its own.
 *
 * Runs in its own mocha process, as every `console-*` suite does: the gate's file memo and the
 * routes' rate-limit buckets are process state.
 */

const server = Keypair.generate();
const invited = Keypair.generate();
const stranger = Keypair.generate();
/** Owns the agents a store write is refused on for not being the signer's. */
const other = Keypair.generate();
const AUTHORITY = "AuThOrItY1111111111111111111111111111111111";
/** Base64 of the message bytes a `prepare` would have built; a confirm refuses before reading it. */
const MESSAGE = Buffer.from("the message prepare built").toString("base64");
const WAITLIST = "https://getlath.xyz";

const policy = {
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

const betaDir = fs.mkdtempSync(path.join(traceDir, "beta-"));
const listFile = path.join(betaDir, "invited.txt");
const missingZeroclaw = path.join(betaDir, "no-such-zeroclaw");

let n = 0;
/** A name no other case has used: names are agent ids, spent for good once recorded. */
const fresh = (stem: string) => `${stem}-${++n}-${Date.now() % 1e6}`;

type Purpose = Parameters<typeof authMessage>[0];
/** A real signature over the canonical message, with a nonce no other request has used. */
function sign(
  wallet: Keypair,
  purpose: Purpose,
  bound: { action: string; target: string; body?: string },
  at = Date.now()
) {
  const message = authMessage(purpose, {
    ...bound,
    ...consoleOrigin,
    cluster: "devnet",
    wallet: wallet.publicKey.toBase58(),
    issued: new Date(at).toISOString(),
    nonce: hex(nacl.randomBytes(16)),
  });
  return {
    message,
    signature: Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), wallet.secretKey)).toString("base64"),
  };
}

const loopsRequest = (body: unknown) =>
  new Request("http://localhost:3000/api/loops", { method: "POST", body: JSON.stringify(body) });
const runRequest = (body: unknown) =>
  new Request("http://localhost:3000/api/run", { method: "POST", body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface Answer {
  status: number;
  error: string | null;
}
async function answer(res: Response): Promise<Answer> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: body.error ?? null };
}
function isBetaRefusal(a: Answer): boolean {
  return a.status === 403 && /closed beta/.test(a.error ?? "");
}
function assertBetaRefusal(a: Answer, what: string) {
  assert.equal(a.status, 403, `${what}: ${a.error}`);
  assert.match(a.error ?? "", /^Lath is in closed beta/, what);
  assert.include(a.error ?? "", WAITLIST, `${what} points at the waitlist`);
}

/**
 * `/api/run` with the run slot held by somebody else, so a session past the gate is answered 429
 * "another run is in progress" before it reads a chain or opens anything. The settle a loop stop
 * fires takes the slot for a moment, so a held slot is waited out rather than failed on.
 */
async function withSlotHeld<T>(fn: () => Promise<T>): Promise<T> {
  let slot = acquireRunSlot("console-beta (test)", 60_000);
  for (let i = 0; !slot && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    slot = acquireRunSlot("console-beta (test)", 60_000);
  }
  assert.isNotNull(slot, "the run slot is free for the case");
  try {
    return await fn();
  } finally {
    slot!.release();
  }
}

const session = (wallet: Keypair | null, at?: number) =>
  withSlotHeld(() =>
    runPOST(
      runRequest(
        wallet
          ? {
              prompt: "what is the slot?",
              user: wallet.publicKey.toBase58(),
              auth: sign(wallet, "Lath console session", { action: "session", target: "console" }, at),
            }
          : { prompt: "what is the slot?" }
      )
    )
  );

/** A stopped run of `wallet`'s, on an agent this console never deployed: every command on it is answered locally. */
const ownLoops = new Map<string, string>();
function stoppedLoopOf(wallet: Keypair): string {
  const owner = wallet.publicKey.toBase58();
  const known = ownLoops.get(owner);
  if (known) return known;
  const id = `loop-beta-${fresh("stopped")}`;
  recordLoop(loopRow(id, owner, "stopped"));
  ownLoops.set(owner, id);
  return id;
}
function loopRow(id: string, owner: string, status: LoopRecord["status"]): LoopRecord {
  return {
    id,
    agentId: "aa".repeat(32),
    agentName: `beta-${id}`,
    owner,
    prompt: "watch the fee market",
    promptHash: "cd".repeat(32),
    intervalMs: 60_000,
    maxSteps: 4,
    budgetMicroUsdcPerStep: "50000",
    model: policy.model,
    createdAt: Date.now(),
    status,
    ...(status === "stopped" ? { stopReason: "stopped" } : {}),
    // A running row is armed by the scheduler every `/api/loops` request syncs; an hour out, so its
    // timer never fires inside the suite.
    ...(status === "running" ? { nextStepAt: Date.now() + 60 * 60_000 } : {}),
    snapshot: { loopId: id, steps: 0, status: "idle", totalCostMicroUsdc: "0", consecutiveFailures: 0 },
    history: [],
  };
}
function loopCommand(wallet: Keypair, action: string, id: string) {
  return loopsPOST(loopsRequest({ action, id, auth: sign(wallet, "Lath loop", { action, target: id }) }));
}

/** An agent `other` owns, which a store write by anyone else is refused on past the gate. */
const othersAgent = (() => {
  let id: string | null = null;
  return () => {
    if (id) return id;
    const name = fresh("beta-others");
    id = hex(idFromString(name));
    recordAgent(id, { name, authority: AUTHORITY, owner: other.publicKey.toBase58(), createdAt: Date.now(), policy });
    return id;
  };
})();

/** One agent of the invited wallet's, which every clone `prepare` names, so each answer reads the same. */
const invitedSource = (() => {
  let id: string | null = null;
  return () => (id ??= ownAgent(invited));
})();

/** An agent `wallet` owns, to clone. */
function ownAgent(wallet: Keypair): string {
  const name = fresh("beta-own");
  const id = hex(idFromString(name));
  recordAgent(id, { name, authority: AUTHORITY, owner: wallet.publicKey.toBase58(), createdAt: Date.now(), policy });
  return id;
}

/** The ticket each confirm probe presented, so a case can ask whether the refusal spent it. */
const lastTicket: Record<string, string> = {};

interface Probe {
  name: string;
  /** The request, signed by or naming `wallet`, shaped so a local check answers it past the gate. */
  send: (wallet: Keypair) => Promise<Response>;
  /** The same request with no wallet at all, where the route has such a request; `null` where it does not. */
  anonymous: (() => Promise<Response>) | null;
  /** What an anonymous request is answered with: the gate's refusal, or the route's own (no wallet, no signature). */
  anonymousRefusal: "beta" | number;
}

const probes: Probe[] = [
  {
    name: "POST /api/run, a session",
    send: (w) => session(w),
    anonymous: () => session(null),
    anonymousRefusal: "beta",
  },
  {
    name: "POST /api/agents, prepare",
    send: (w) => deployPOST(jsonRequest({ prepare: true, wallet: w.publicKey.toBase58(), name: "x" })),
    anonymous: () => deployPOST(jsonRequest({ prepare: true, name: "x" })),
    anonymousRefusal: 400,
  },
  {
    name: "POST /api/agents, the signed deploy",
    send: (w) =>
      deployPOST(jsonRequest({ name: "x", auth: sign(w, "Lath deploy", { action: "deploy", target: "x" }) })),
    anonymous: () => deployPOST(jsonRequest({ name: "x" })),
    anonymousRefusal: 401,
  },
  {
    name: "POST /api/agents, confirm",
    send: (w) => {
      const ticket = issueDeployTicket({
        wallet: w.publicKey.toBase58(),
        name: fresh("beta-deploy"),
        message: MESSAGE,
        policy,
      });
      lastTicket.deploy = ticket;
      return deployPOST(jsonRequest({ confirm: "not-a-signature", ticket }));
    },
    anonymous: null,
    anonymousRefusal: 409,
  },
  {
    name: "POST /api/agents/[id], clone prepare",
    send: (w) =>
      agentPOST(
        jsonRequest({ action: "clone", prepare: true, wallet: w.publicKey.toBase58(), name: "" }),
        params(invitedSource())
      ),
    anonymous: () => agentPOST(jsonRequest({ action: "clone", prepare: true, name: "" }), params(invitedSource())),
    anonymousRefusal: 400,
  },
  {
    name: "POST /api/agents/[id], clone confirm",
    send: (w) => {
      const source = ownAgent(w);
      const plan = cloneContext({
        agentId: source,
        source: lookupAgent(source),
        wallet: w.publicKey.toBase58(),
        name: fresh("beta-clone"),
        ip: "beta",
      });
      if ("error" in plan) throw new Error(`expected a clone plan: ${plan.error}`);
      const ticket = issueCloneTicket(plan, w.publicKey.toBase58(), MESSAGE);
      lastTicket.clone = ticket;
      return agentPOST(jsonRequest({ confirm: "not-a-signature", ticket }), params(source));
    },
    anonymous: null,
    anonymousRefusal: 409,
  },
  {
    name: "POST /api/store/[id], a write",
    send: (w) => {
      const id = othersAgent();
      return storePOST(
        jsonRequest({ key: "k", value: "v", auth: sign(w, "Lath agent", storeWriteBinding(id, "k", "v")) }),
        params(id)
      );
    },
    anonymous: () => storePOST(jsonRequest({ key: "k", value: "v" }), params(othersAgent())),
    anonymousRefusal: 401,
  },
  {
    name: "POST /api/loops, start",
    send: (w) => {
      const body = {
        action: "start",
        agentId: "ab".repeat(32),
        prompt: "Read the slot and say how far it moved.",
        intervalMs: 5 * 60_000,
        maxSteps: 4,
        budgetMicroUsdc: "100000",
        model: policy.model,
      };
      return loopsPOST(loopsRequest({ ...body, auth: sign(w, "Lath loop", loopAuthBinding(body)) }));
    },
    anonymous: () => loopsPOST(loopsRequest({ action: "start", agentId: "ab".repeat(32) })),
    anonymousRefusal: 401,
  },
  ...(["resume", "retry"] as const).map(
    (action): Probe => ({
      name: `POST /api/loops, ${action}`,
      send: (w) => loopCommand(w, action, stoppedLoopOf(w)),
      anonymous: () => loopsPOST(loopsRequest({ action, id: stoppedLoopOf(invited) })),
      anonymousRefusal: 401,
    })
  ),
];

const saved: Record<string, string | undefined> = {};
function setEnv(name: string, value: string | undefined) {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
function gateOff() {
  setEnv("LATH_BETA_WALLETS", undefined);
  setEnv("LATH_BETA_FILE", undefined);
}
function gateByEnv(...wallets: Keypair[]) {
  setEnv("LATH_BETA_FILE", undefined);
  setEnv("LATH_BETA_WALLETS", wallets.map((w) => w.publicKey.toBase58()).join(", "));
}
/** Writes the list and moves its mtime on, so a rewrite inside one clock tick still reads as a change. */
function writeList(lines: string[]) {
  const before = fs.existsSync(listFile) ? fs.statSync(listFile).mtimeMs : 0;
  fs.writeFileSync(listFile, lines.join("\n") + "\n");
  const after = new Date(Math.max(Date.now(), before + 2_000));
  fs.utimesSync(listFile, after, after);
}
function gateByFile(...wallets: Keypair[]) {
  setEnv("LATH_BETA_WALLETS", undefined);
  writeList(["# invited wallets", ...wallets.map((w) => w.publicKey.toBase58())]);
  setEnv("LATH_BETA_FILE", listFile);
}

/** Every `console.warn` and `console.error` line while `fn` runs. */
async function logged(fn: () => unknown): Promise<string[]> {
  const lines: string[] = [];
  const warn = console.warn;
  const error = console.error;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return lines;
}

describe("the closed beta: only invited wallets take actions the console pays for", function () {
  before(() => {
    setEnv("LATH_RUNTIME_KEYPAIR", JSON.stringify(Array.from(server.secretKey)));
    // No treasury, no Tempo keys, no proxy: nothing here may reach Tempo, and every caller is `local`.
    setEnv("LATH_TEMPO_TREASURY", undefined);
    setEnv("LATH_TEMPO_LOOP_KEYS", undefined);
    setEnv("LATH_TRUST_PROXY", undefined);
    setEnv("LATH_WAITLIST_URL", undefined);
    // A loop start past the gate is answered by the sandbox check, 503, before anything else.
    setEnv("LATH_ZEROCLAW_BIN", missingZeroclaw);
    gateOff();
  });
  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  /** What each probe answers `invited` with the gate off: the answer it must still get when invited. */
  const baseline = new Map<string, Answer>();

  describe("gate unset: open, exactly as before", () => {
    it("is off with neither variable set, or with both exported empty", () => {
      gateOff();
      assert.isFalse(betaEnabled());
      assert.isNull(betaRefusal(null));
      assert.isNull(betaRefusal(stranger.publicKey.toBase58()));
      setEnv("LATH_BETA_WALLETS", "  ");
      setEnv("LATH_BETA_FILE", "");
      assert.isFalse(betaEnabled(), "an exported empty string is unset, as `env()` reads it");
      assert.isNull(betaRefusal(null));
      gateOff();
    });

    for (const probe of probes) {
      it(`${probe.name}: nobody is refused by the gate`, async () => {
        gateOff();
        const mine = await answer(await probe.send(invited));
        assert.isFalse(isBetaRefusal(mine), `${probe.name}: ${mine.error}`);
        // Refused by a local check, never thrown on (a loop start's is the sandbox's 503).
        assert.notEqual(mine.status, 500, `${probe.name}: ${mine.error}`);
        assert.isString(mine.error, `${probe.name} is answered by a check past the gate, not run`);
        baseline.set(probe.name, mine);
        const theirs = await answer(await probe.send(stranger));
        assert.isFalse(isBetaRefusal(theirs), `${probe.name}, a stranger: ${theirs.error}`);
        if (probe.anonymous) {
          const nobody = await answer(await probe.anonymous());
          assert.isFalse(isBetaRefusal(nobody), `${probe.name}, anonymous: ${nobody.error}`);
        }
      });
    }

    it("an anonymous session on the console's own agents reaches the run slot", async () => {
      gateOff();
      const a = await answer(await session(null));
      assert.equal(a.status, 429);
      assert.match(a.error ?? "", /another run is in progress/);
    });
  });

  for (const [mode, gate] of [
    ["by LATH_BETA_WALLETS", (...w: Keypair[]) => gateByEnv(...w)],
    ["by LATH_BETA_FILE", (...w: Keypair[]) => gateByFile(...w)],
  ] as const) {
    describe(`gate on, ${mode}`, () => {
      beforeEach(() => gate(invited));

      it("says it is on, admits the invited wallet and refuses the rest", () => {
        assert.isTrue(betaEnabled());
        assert.isNull(betaRefusal(invited.publicKey.toBase58()));
        assert.match(betaRefusal(stranger.publicKey.toBase58())!, /is not an invited wallet/);
        assert.match(betaRefusal(null)!, /not signed by an invited wallet/);
        assert.match(betaRefusal("not a key")!, /closed beta/, "a string that is not a key is no wallet on the list");
      });

      for (const probe of probes) {
        it(`${probe.name}: the invited wallet gets what it got with the gate off; a stranger and nobody are refused`, async () => {
          const mine = await answer(await probe.send(invited));
          assert.deepEqual(mine, baseline.get(probe.name), `${probe.name}: the invited wallet is past the gate`);

          assertBetaRefusal(await answer(await probe.send(stranger)), `${probe.name}, a stranger`);
          if (probe.anonymous) {
            const nobody = await answer(await probe.anonymous());
            if (probe.anonymousRefusal === "beta") assertBetaRefusal(nobody, `${probe.name}, anonymous`);
            else assert.equal(nobody.status, probe.anonymousRefusal, `${probe.name}, anonymous: ${nobody.error}`);
          }
        });
      }

      it("a confirm the gate refuses leaves its ticket unspent, so re-inviting the wallet in time lets it finish", async () => {
        for (const which of ["POST /api/agents, confirm", "POST /api/agents/[id], clone confirm"]) {
          const probe = probes.find((p) => p.name === which)!;
          assertBetaRefusal(await answer(await probe.send(stranger)), which);
        }
        assert.isNotNull(peekDeployTicket(lastTicket.deploy), "the deploy ticket survives the refusal");
        assert.isNotNull(peekCloneTicket(lastTicket.clone), "the clone ticket survives the refusal");
        // And a confirm past the gate is the one that spends it, as before.
        await probes.find((p) => p.name === "POST /api/agents, confirm")!.send(invited);
        assert.isNull(peekDeployTicket(lastTicket.deploy), "a confirm the chain answered spent its ticket");
      });

      it("an invited wallet whose signature was refused is told why, not only that it is not invited", async () => {
        const expired = await answer(await session(invited, Date.now() - 10 * 60_000));
        assertBetaRefusal(expired, "an expired signature");
        assert.include(expired.error ?? "", "the signature sent was refused: signature expired");
      });

      it("a retry of a session's failed writes is not asked: it creates no record", async () => {
        const consoleAgent = hex(idFromString(roles(server).agent.name));
        const a = await answer(
          await withSlotHeld(() => runPOST(runRequest({ action: "retry", agentId: consoleAgent })))
        );
        assert.equal(a.status, 429, `an anonymous retry reaches the run slot: ${a.error}`);
        assert.match(a.error ?? "", /another run is in progress/);
      });

      it("points at LATH_WAITLIST_URL when it is set", () => {
        setEnv("LATH_WAITLIST_URL", "https://example.com/wait");
        try {
          assert.include(betaRefusal(stranger.publicKey.toBase58())!, "https://example.com/wait");
        } finally {
          setEnv("LATH_WAITLIST_URL", undefined);
        }
      });
    });
  }

  describe("the list", () => {
    it("logs and ignores what is not an address, by position and without echoing it", async () => {
      const secretLooking = "4".repeat(88);
      const lines = await logged(() => {
        setEnv("LATH_BETA_FILE", undefined);
        setEnv("LATH_BETA_WALLETS", `not-a-key, ${invited.publicKey.toBase58()}\n${secretLooking} 1111`);
        assert.isNull(betaRefusal(invited.publicKey.toBase58()), "the valid entry is still in force");
        assert.match(betaRefusal(stranger.publicKey.toBase58())!, /closed beta/);
      });
      const warning = lines.find((l) => l.includes("LATH_BETA_WALLETS"));
      assert.isDefined(warning, "the bad entries are logged");
      assert.include(warning!, "ignoring 3 entries");
      assert.notInclude(warning!, secretLooking, "an entry that is not a key is never echoed into the log");
      assert.notInclude(warning!, "not-a-key");
    });

    it("joins LATH_BETA_WALLETS and LATH_BETA_FILE, with comments in the file", () => {
      writeList([`# the judges`, `${stranger.publicKey.toBase58()}  # one of them`, ""]);
      setEnv("LATH_BETA_FILE", listFile);
      setEnv("LATH_BETA_WALLETS", invited.publicKey.toBase58());
      assert.isNull(betaRefusal(invited.publicKey.toBase58()), "listed inline");
      assert.isNull(betaRefusal(stranger.publicKey.toBase58()), "listed in the file, a comment beside it");
      assert.match(betaRefusal(other.publicKey.toBase58())!, /closed beta/);
    });

    it("picks up the file changing on disk, with no restart", async () => {
      gateByFile(invited);
      const deploy = probes.find((p) => p.name === "POST /api/agents, prepare")!;
      assertBetaRefusal(await answer(await deploy.send(stranger)), "before the stranger is added");

      writeList([invited.publicKey.toBase58(), stranger.publicKey.toBase58()]);
      const added = await answer(await deploy.send(stranger));
      assert.deepEqual(added, baseline.get(deploy.name), "added to the file, the stranger is past the gate");

      writeList([stranger.publicKey.toBase58()]);
      assertBetaRefusal(await answer(await deploy.send(invited)), "taken off the file, the invited wallet is refused");

      // An editor that saves by writing a new file and renaming it over the old one.
      const swap = `${listFile}.swap`;
      fs.writeFileSync(swap, `${invited.publicKey.toBase58()}\n`);
      fs.renameSync(swap, listFile);
      assert.isNull(betaRefusal(invited.publicKey.toBase58()), "a file replaced by rename is read again");
      assert.match(betaRefusal(stranger.publicKey.toBase58())!, /closed beta/);
    });

    it("fails closed when the file cannot be read: everyone is refused, and the log says why once", async () => {
      const gone = path.join(betaDir, "no-such-list.txt");
      setEnv("LATH_BETA_WALLETS", invited.publicKey.toBase58());
      setEnv("LATH_BETA_FILE", gone);
      const lines = await logged(async () => {
        assert.isTrue(betaEnabled());
        for (const who of [invited, stranger]) {
          const refusal = betaRefusal(who.publicKey.toBase58());
          assert.match(refusal ?? "", /cannot read its invite list/, "even a wallet listed inline is refused");
          assert.include(refusal ?? "", WAITLIST);
          assert.notInclude(refusal ?? "", gone, "the path is the log's, not the caller's");
        }
        assert.match(betaRefusal(null) ?? "", /cannot read its invite list/);
        const deploy = probes.find((p) => p.name === "POST /api/agents, prepare")!;
        assertBetaRefusal(await answer(await deploy.send(invited)), "a deploy, with the list unreadable");
      });
      const errors = lines.filter((l) => l.includes("LATH_BETA_FILE cannot be read"));
      assert.lengthOf(errors, 1, "logged once for the failure, not once per request");
      assert.include(errors[0], gone);
      assert.include(errors[0], "ENOENT");

      // A directory where the file should be is the same failure.
      const notAFile = await logged(() => {
        setEnv("LATH_BETA_FILE", betaDir);
        assert.match(betaRefusal(invited.publicKey.toBase58()) ?? "", /cannot read its invite list/);
      });
      assert.isTrue(notAFile.some((l) => l.includes("not a regular file")));

      // And a file that appears is in force at once: nothing was cached from the failure.
      const back = await logged(() => {
        fs.writeFileSync(gone, `${stranger.publicKey.toBase58()}\n`);
        setEnv("LATH_BETA_FILE", gone);
        assert.isNull(betaRefusal(stranger.publicKey.toBase58()));
        assert.isNull(betaRefusal(invited.publicKey.toBase58()), "and the inline list with it");
      });
      assert.isTrue(back.some((l) => l.includes("readable again")));
    });
  });

  describe("a wallet taken off the list keeps what it already owns", () => {
    const removed = Keypair.generate();

    it("cannot start or resume, but can still pause, stop and archive its running loop", async () => {
      gateByFile(invited, removed);
      const running = `loop-beta-${fresh("running")}`;
      recordLoop(loopRow(running, removed.publicKey.toBase58(), "running"));

      // Off the list. Edited in place, the way an operator removes a wallet.
      writeList([invited.publicKey.toBase58()]);

      const start = probes.find((p) => p.name === "POST /api/loops, start")!;
      assertBetaRefusal(await answer(await start.send(removed)), "a new loop");
      assertBetaRefusal(await answer(await loopCommand(removed, "resume", running)), "a resume");
      // _Improve loop_ is not in this build: the verb is unknown, refused before the beta is asked.
      assert.equal((await loopCommand(removed, "improve", running)).status, 400, "no Improve to start");

      const paused = await loopCommand(removed, "pause", running);
      assert.equal(paused.status, 200, (await answer(paused.clone())).error ?? "");
      assert.equal(readLoop(running)!.status, "paused");

      const stopped = await loopCommand(removed, "stop", running);
      assert.equal(stopped.status, 200, (await answer(stopped.clone())).error ?? "");
      assert.equal(readLoop(running)!.status, "stopped", "the owner stopped it, and its settle runs as before");

      const archived = await loopCommand(removed, "archive", running);
      assert.equal(archived.status, 200);
      assert.isNumber(readLoop(running)!.archivedAt);
    });
  });
});
