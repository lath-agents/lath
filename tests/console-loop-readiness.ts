import { traceDir } from "./fixtures/trace-dir";
import { jsonRequest } from "./fixtures/request";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { hex } from "@lath/sdk";
import { DEPLOYS_PER_HOUR } from "../frontend/src/app/api/_lib/runner";
import { allowancePolicyHash } from "../frontend/src/app/api/_lib/copy";
import { deployRailFields } from "../frontend/src/app/api/_lib/tempo";
import type { ZeroClawReadiness } from "../frontend/src/app/api/_lib/loops";
import { POST as deployPOST } from "../frontend/src/app/api/agents/route";

/**
 * A deploy that carries a loop refuses at `prepare`,
 * before anything is signed, on a console that cannot run a loop step — the check `POST
 * /api/loops` makes, with its status and its body. Without it the wallet prompt would be
 * spent, the header land, and the first step be refused with the same reason.
 *
 * Driven through the route's `POST`, as `console-agents.ts` drives it. Nothing
 * reaches a cluster: the refusal comes before `prepareDeployTx`, and the cases that must get past
 * it name the server's own key as the wallet, which `prepareDeployTx` refuses (409) before its
 * first read — so *reached the transaction* is observable with no RPC behind it.
 *
 * Two refusals are real: `LATH_ZEROCLAW_BIN` naming no file, and a binary whose `--version` fails.
 * A wrapper that cannot start cannot be arranged from the environment — `sandbox-exec` is a fixed
 * path and `bwrap` is looked for in `/usr/bin` whatever `PATH` says — so that case replaces
 * `zeroclawReadiness` on the exports of `_lib/loop-sandbox.ts`, the module that defines it, which the
 * compiled routes read at call time through `_lib/loops.ts`. Not on `_lib/loops.ts` itself: its
 * re-exports are getters, and a suite cannot assign them.
 */

const config = {
  model: "deepseek/deepseek-v4.1-flash",
  tools: ["solana.slot"],
  budgetCapUsdc: "1.00",
  expirationDays: 14,
};

const loop = {
  prompt: "Read the slot and say how far it moved since last step.",
  intervalMs: 5 * 60_000,
  maxSteps: 4,
  budgetMicroUsdcPerStep: "20000",
};

/** What `resolveZeroClaw` says on a host whose wrapper will not start a profile. */
const WRAPPER_REASON =
  "sandbox-exec cannot start a profile on this host (exit 1: sandbox_apply: Operation not permitted); " +
  "a loop step runs air-gapped or not at all";

const sandboxModule = require("../frontend/src/app/api/_lib/loop-sandbox") as {
  zeroclawReadiness: (env?: NodeJS.ProcessEnv) => ZeroClawReadiness;
};
const channelStateModule = require("../frontend/src/app/api/_lib/loop-channel-state") as {
  treasuryHeld: () => Promise<bigint | null>;
};

const request = (body: unknown) => jsonRequest(body);
const errorOf = async (res: Response) => (await res.json()) as { error?: string; ticket?: string };

describe("a loop is refused before the prompt on a console that cannot run one", () => {
  const server = Keypair.generate();
  const missing = path.join(traceDir, "no-such-zeroclaw");
  const broken = path.join(traceDir, "broken-zeroclaw");
  const saved = {
    bin: process.env.LATH_ZEROCLAW_BIN,
    treasury: process.env.LATH_TEMPO_TREASURY,
    readiness: sandboxModule.zeroclawReadiness,
    treasuryHeld: channelStateModule.treasuryHeld,
  };
  let n = 0;
  /** A fresh name and wallet per case: the deploy counter is keyed on both. */
  const fresh = (stem: string) => ({ name: `${stem}-${++n}-${Date.now() % 1e6}`, wallet: Keypair.generate() });

  before(() => {
    process.env.LATH_RUNTIME_KEYPAIR = JSON.stringify(Array.from(server.secretKey));
    // No treasury, set rather than defaulted: with one, the deploy prepare reads its
    // live USDC.e balance after the sandbox check, so a box whose env names a treasury — or a
    // fake key, which holds nothing on mainnet — would get the shortfall refusal
    // where the cases below expect to reach the transaction. The sandbox check is what this file
    // tests, and a console without a treasury skips the one check that needs a network. The
    // treasury is read once per process (`tempoTreasury`), so in a process where an earlier suite
    // already turned the rail on, the balance read is answered here instead: a treasury holding far
    // more than any case's budget, so the shortfall check passes without a network either way.
    process.env.LATH_TEMPO_TREASURY = "";
    channelStateModule.treasuryHeld = async () => 10n ** 15n;
    // A binary that exists, is executable, and fails `--version`: what a half-installed or
    // wrong-architecture build looks like to `resolveZeroClaw`.
    fs.writeFileSync(broken, "#!/bin/sh\necho 'cannot execute binary file' >&2\nexit 126\n", { mode: 0o755 });
  });
  beforeEach(() => {
    // Named explicitly, so a CI job with a real binary on `PATH` does not turn a refusal into a start.
    process.env.LATH_ZEROCLAW_BIN = missing;
    sandboxModule.zeroclawReadiness = saved.readiness;
  });
  after(() => {
    if (saved.bin === undefined) delete process.env.LATH_ZEROCLAW_BIN;
    else process.env.LATH_ZEROCLAW_BIN = saved.bin;
    if (saved.treasury === undefined) delete process.env.LATH_TEMPO_TREASURY;
    else process.env.LATH_TEMPO_TREASURY = saved.treasury;
    channelStateModule.treasuryHeld = saved.treasuryHeld;
    sandboxModule.zeroclawReadiness = saved.readiness;
  });

  describe("POST /api/agents, prepare", () => {
    /**
     * A prepare carrying `config`'s own allowance, so the loop is the only thing left to refuse: the
     * route holds the cap, the expiry and the hash to the policy, and the hash covers the rail this
     * console gives a deploy, read from the env as the route reads it.
     */
    const body = (name: string, wallet: string, withLoop: boolean) => ({
      name,
      policy: { ...config },
      prepare: true,
      wallet,
      allowance: {
        capMicroUsdc: "1000000",
        expiresAt: String(Math.floor(Date.now() / 1000) + config.expirationDays * 86_400),
        policyVersionHash: hex(
          allowancePolicyHash({
            model: config.model,
            tools: config.tools,
            capMicroUsdc: 1_000_000n,
            payment: deployRailFields(undefined).payment,
          })
        ),
      },
      ...(withLoop ? { loop } : {}),
    });

    it("refuses a deploy with a loop when there is no binary, with /api/loops' status and body", async () => {
      const { name, wallet } = fresh("fz5-deploy-none");
      const res = await deployPOST(request(body(name, wallet.publicKey.toBase58(), true)));
      assert.equal(res.status, 503);
      const answer = await errorOf(res);
      assert.include(answer.error, `the ZeroClaw binary ${missing} does not exist`);
      assert.notProperty(answer, "ticket", "nothing was prepared for the wallet to sign");
    });

    it("refuses a deploy with a loop when the binary does not answer --version", async () => {
      process.env.LATH_ZEROCLAW_BIN = broken;
      const { name, wallet } = fresh("fz5-deploy-broken");
      const res = await deployPOST(request(body(name, wallet.publicKey.toBase58(), true)));
      assert.equal(res.status, 503);
      assert.include((await errorOf(res)).error, "--version did not answer");
    });

    it("refuses a deploy with a loop when the wrapper cannot start, with the reason verbatim", async () => {
      sandboxModule.zeroclawReadiness = () => ({ ok: false, reason: WRAPPER_REASON });
      const { name, wallet } = fresh("fz5-deploy-wrapper");
      const res = await deployPOST(request(body(name, wallet.publicKey.toBase58(), true)));
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { error: WRAPPER_REASON });
    });

    it("lets a deploy with a loop through to the transaction on a console that can run it", async () => {
      sandboxModule.zeroclawReadiness = () => ({ ok: true, binary: {} as any, home: "/nonexistent" });
      const { name } = fresh("fz5-deploy-ready");
      // The server's own key as the wallet: `prepareDeployTx` refuses it before any read, which is
      // how this case sees the readiness check pass without a cluster behind the route.
      const res = await deployPOST(request(body(name, server.publicKey.toBase58(), true)));
      assert.equal(res.status, 409);
      assert.include((await errorOf(res)).error, "a wallet this server does not hold");
    });

    it("charges no deploy and no prepare for a loop it refuses, so the wallet can still deploy after", async () => {
      // The loop's checks run before the ceiling and the hourly counter: otherwise a console with no
      // binary would spend one of the wallet's deploys on every refused deploy-with-loop, and after
      // `DEPLOYS_PER_HOUR` of them the next one would be a 429 about the counter, not the sandbox.
      const wallet = Keypair.generate().publicKey.toBase58();
      for (let i = 0; i <= DEPLOYS_PER_HOUR; i++) {
        const res = await deployPOST(request(body(fresh("fz5-deploy-uncharged").name, wallet, true)));
        assert.equal(res.status, 503, `refusal ${i + 1} is still the sandbox's, not the counter's`);
      }
    });

    it("does not ask a deploy without a loop about the sandbox at all", async () => {
      const { name } = fresh("fz5-deploy-plain");
      const res = await deployPOST(request(body(name, server.publicKey.toBase58(), false)));
      assert.equal(res.status, 409, "a plain deploy reached the transaction with no binary on this console");
      assert.include((await errorOf(res)).error, "a wallet this server does not hold");
    });
  });
});
