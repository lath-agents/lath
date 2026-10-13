// First, so `LATH_TRACE_DIR` is set before `runner.ts` captures it, whatever order the console
// suites load in.
import { consoleOrigin } from "./fixtures/trace-dir";
import { assert } from "chai";
import * as nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { AuthBinding, AuthPurpose, authMessage, hex, loopAuthBinding, loopStartBodyHash } from "@lath/sdk";
import {
  CLUSTER,
  UNBOUND_AUTH_REASON,
  authMessage as serverAuthMessage,
  bootAt,
  consoleOrigin as serverConsoleOrigin,
  loopAuthBinding as serverLoopAuthBinding,
  sessionSpend,
  verifyAuth,
  walletIn,
} from "../frontend/src/app/api/_lib/runner";

/**
 * The bytes a wallet signs for the six routes that take a signed message instead of a
 * transaction.
 *
 * This is a wire contract with two ends and no schema — the browser builds the message and the
 * wallet signs it, the route rebuilds it and checks the signature against what it built. Both
 * ends call one function, but one function can still be edited, and a single character moved here invalidates every
 * signature in flight and locks every owner out of their own agents until they reload.
 *
 * So the assertion is the literal, not a re-derivation: no helper builds the expected string.
 */
describe("the signed console message", () => {
  const p = {
    action: "deploy",
    target: "slot-watcher",
    domain: "console.lath.test",
    uri: "https://console.lath.test",
    cluster: "devnet",
    wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
    issued: "2026-09-12T10:11:12.345Z",
    nonce: "0123456789abcdef0123456789abcdef",
  };

  it("is exactly these bytes", () => {
    // Sign-In-With-Solana's shape: the site asking on the first line, the address, then the
    // Lath statement — the purpose, the action and the target, which are what the route compares
    // with the request it is handling — then the fields in SIWS order.
    assert.equal(
      authMessage("Lath deploy", p),
      "console.lath.test wants you to sign in with your Solana account:\n" +
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin\n" +
        "\n" +
        "Lath deploy: deploy slot-watcher\n" +
        "\n" +
        "URI: https://console.lath.test\n" +
        "Version: 1\n" +
        "Chain ID: devnet\n" +
        "Nonce: 0123456789abcdef0123456789abcdef\n" +
        "Issued At: 2026-09-12T10:11:12.345Z"
    );
  });

  it("carries a bound body as the SIWS Request ID, and only when one is bound", () => {
    const body = "ab".repeat(32);
    assert.equal(
      authMessage("Lath loop", { ...p, action: "start", target: "a1".repeat(32), body }),
      "console.lath.test wants you to sign in with your Solana account:\n" +
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin\n" +
        "\n" +
        `Lath loop: start ${"a1".repeat(32)}\n` +
        "\n" +
        "URI: https://console.lath.test\n" +
        "Version: 1\n" +
        "Chain ID: devnet\n" +
        "Nonce: 0123456789abcdef0123456789abcdef\n" +
        "Issued At: 2026-09-12T10:11:12.345Z\n" +
        `Request ID: ${body}`
    );
    assert.notInclude(authMessage("Lath loop", { ...p, action: "stop", target: "loop-1" }), "Request ID");
    assert.throws(() => authMessage("Lath loop", { ...p, body: "not-a-hash" }), /body/);
    assert.throws(() => authMessage("Lath loop", { ...p, body: body.toUpperCase() }), /body/);
  });

  it("refuses an action, target, domain or uri that could forge a line", () => {
    // A newline in any would put a second line into the signed text; a space in an action or
    // target would move the statement's split.
    assert.throws(() => authMessage("Lath agent", { ...p, target: `x\nwallet: ${p.wallet}` }), /target/);
    assert.throws(() => authMessage("Lath agent", { ...p, action: "unlock\ntarget: other" }), /action/);
    assert.throws(() => authMessage("Lath agent", { ...p, target: "" }), /target/);
    assert.throws(() => authMessage("Lath agent", { ...p, action: "un lock" }), /action/);
    assert.throws(() => authMessage("Lath agent", { ...p, target: "a".repeat(97) }), /target/);
    assert.throws(() => authMessage("Lath agent", { ...p, domain: "console.lath.test wants\nx" }), /domain/);
    assert.throws(() => authMessage("Lath agent", { ...p, domain: "" }), /domain/);
    assert.throws(() => authMessage("Lath agent", { ...p, uri: "https://console.lath.test/agent/1" }), /uri/);
    assert.throws(() => authMessage("Lath agent", { ...p, uri: "javascript:alert(1)" }), /uri/);
    assert.doesNotThrow(() => authMessage("Lath agent", { ...p, action: "useVersion", target: "ab".repeat(32) }));
    assert.doesNotThrow(() => authMessage("Lath template", { ...p, action: "append", target: "tpl-0123abcd" }));
    assert.doesNotThrow(() =>
      authMessage("Lath agent", { ...p, domain: "localhost:3000", uri: "http://localhost:3000" })
    );
    assert.doesNotThrow(() =>
      authMessage("Lath agent", { ...p, domain: "127.0.0.1:3111", uri: "http://127.0.0.1:3111" })
    );
  });

  it("derives one loop binding for the browser, the scripts and the route", () => {
    assert.equal(serverLoopAuthBinding, loopAuthBinding);
    const agent = "AB".repeat(32);
    const start = { action: "start", agentId: agent, prompt: "watch the slot", budgetMicroUsdc: "250000" };
    // A start binds the hash of its whole body: the same body in another key order, or with
    // the `auth` it will be posted with, hashes the same; a body with one term changed does not.
    assert.deepEqual(loopAuthBinding(start), {
      action: "start",
      target: agent.toLowerCase(),
      body: loopStartBodyHash(start),
    });
    assert.equal(
      loopStartBodyHash({ budgetMicroUsdc: "250000", prompt: "watch the slot", agentId: agent, action: "start" }),
      loopStartBodyHash(start)
    );
    assert.equal(loopStartBodyHash({ ...start, auth: { message: "m", signature: "s" } }), loopStartBodyHash(start));
    assert.equal(loopStartBodyHash({ ...start, trigger: undefined }), loopStartBodyHash(start));
    assert.notEqual(loopStartBodyHash({ ...start, prompt: "drain the vault" }), loopStartBodyHash(start));
    assert.notEqual(loopStartBodyHash({ ...start, budgetMicroUsdc: "25000000" }), loopStartBodyHash(start));
    assert.match(loopStartBodyHash(start), /^[0-9a-f]{64}$/);
    // A start without an action key is a start.
    assert.deepEqual(loopAuthBinding({ agentId: agent }), {
      action: "start",
      target: agent.toLowerCase(),
      body: loopStartBodyHash({ agentId: agent }),
    });
    assert.equal(loopAuthBinding({ action: "start", templateId: "tpl-1" }).target, "tpl-1");
    // With both, the agent is what the start runs, so the agent is what is signed for.
    assert.deepEqual(
      loopAuthBinding({ action: "start", agentId: agent, templateId: "tpl-1" }).target,
      agent.toLowerCase()
    );
    // Every other verb is its action and its loop, and binds no body: there is nothing else in it.
    assert.deepEqual(loopAuthBinding({ action: "stop", id: "loop-9", agentId: agent }), {
      action: "stop",
      target: "loop-9",
    });
  });

  it("opens the statement with the purpose, so one signature cannot be replayed as another", () => {
    for (const purpose of [
      "Lath console session",
      "Lath deploy",
      "Lath loop",
      "Lath market",
      "Lath agent",
      "Lath template",
    ] as const) {
      assert.equal(authMessage(purpose, p).split("\n")[3], `${purpose}: deploy slot-watcher`);
    }
    assert.notEqual(authMessage("Lath deploy", p), authMessage("Lath loop", p));
  });

  it("is the same function on the server as in the browser", () => {
    // `_lib/runner.ts` re-exports the SDK's. If someone reintroduces a local copy, this is what
    // notices before the wallets do.
    assert.equal(serverAuthMessage, authMessage);
  });

  it("is what verifyAuth rebuilds: a message that is not this shape is refused", () => {
    const refused = verifyAuth({ message: "Lath deploy\nwallet: " + p.wallet, signature: "" }, null, "Lath deploy", {
      action: "deploy",
      target: "slot-watcher",
    });
    assert.notProperty(refused, "wallet", "a message that is not the shape above proves nothing");
    assert.property(refused, "reason");
  });

  it("names the console's origin from LATH_CONSOLE_ORIGIN first, then the request's Host", () => {
    const pinned = process.env.LATH_CONSOLE_ORIGIN;
    try {
      process.env.LATH_CONSOLE_ORIGIN = "https://console.lath.test:8443/";
      // Pinned: the scheme, host and port of the variable, whatever the request says it was sent to.
      assert.deepEqual(serverConsoleOrigin({ headers: { get: () => "evil.example" }, url: "http://evil.example/x" }), {
        domain: "console.lath.test:8443",
        uri: "https://console.lath.test:8443",
      });
      process.env.LATH_CONSOLE_ORIGIN = "";
      // Unset: the Host header, then the URL's host, and the scheme is unknown (`uri: null`).
      assert.deepEqual(serverConsoleOrigin({ headers: { get: (n) => (n === "host" ? "localhost:3000" : null) } }), {
        domain: "localhost:3000",
        uri: null,
      });
      assert.deepEqual(serverConsoleOrigin({ headers: { get: () => null }, url: "http://127.0.0.1:3111/api/loops" }), {
        domain: "127.0.0.1:3111",
        uri: null,
      });
      assert.isNull(serverConsoleOrigin({ headers: { get: () => null } }));
      assert.isNull(serverConsoleOrigin());
      process.env.LATH_CONSOLE_ORIGIN = "not a url";
      assert.isNull(serverConsoleOrigin({ headers: { get: () => "localhost:3000" } }), "a bad pin is not a fallback");
    } finally {
      process.env.LATH_CONSOLE_ORIGIN = pinned;
    }
  });
});

/**
 * What one signature is good for.
 *
 * A `"Lath agent"` signature that named its purpose, cluster, wallet, time and nonce and nothing
 * else would make the one message good for archive, unarchive, *use version n* and unlock on any
 * agent that wallet owns. Every case here signs for real and
 * checks the one refusal it is about; the accepting case is last so no other case spends a nonce
 * it would need.
 */
describe("verifyAuth binds a signature to one action on one target", () => {
  const wallet = Keypair.generate();
  const A = "a1".repeat(32);
  const B = "b2".repeat(32);

  function sign(message: string) {
    return {
      message,
      signature: Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), wallet.secretKey)).toString("base64"),
    };
  }

  function signed(
    purpose: AuthPurpose,
    bound: AuthBinding,
    issued = new Date().toISOString(),
    origin: { domain: string; uri: string } = consoleOrigin
  ) {
    return sign(
      authMessage(purpose, {
        ...bound,
        ...origin,
        cluster: CLUSTER,
        wallet: wallet.publicKey.toBase58(),
        issued,
        nonce: hex(nacl.randomBytes(16)),
      })
    );
  }

  const verify = (
    auth: { message: string; signature: string },
    bound: AuthBinding,
    purpose: AuthPurpose = "Lath agent"
  ) => verifyAuth(auth, wallet.publicKey, purpose, bound);

  it("refuses the messages older consoles sign — five lines, then seven — and says to reload", () => {
    // Five lines: the purpose, then cluster, wallet, issued, nonce. Seven: the same with
    // `action:` and `target:` under the purpose. Both open with the purpose itself, which is how
    // they are told apart from the current text, whose first line names the site.
    const five = sign(
      [
        "Lath agent",
        `cluster: ${CLUSTER}`,
        `wallet: ${wallet.publicKey.toBase58()}`,
        `issued: ${new Date().toISOString()}`,
        `nonce: ${hex(nacl.randomBytes(16))}`,
      ].join("\n")
    );
    assert.deepEqual(verify(five, { action: "unlock", target: A }), { reason: UNBOUND_AUTH_REASON });
    const seven = sign(
      [
        "Lath agent",
        "action: unlock",
        `target: ${A}`,
        `cluster: ${CLUSTER}`,
        `wallet: ${wallet.publicKey.toBase58()}`,
        `issued: ${new Date().toISOString()}`,
        `nonce: ${hex(nacl.randomBytes(16))}`,
      ].join("\n")
    );
    assert.deepEqual(verify(seven, { action: "unlock", target: A }), { reason: UNBOUND_AUTH_REASON });
    // The routes read the wallet off the message before verifying; the old shape still yields it, so
    // its signer is told to reload rather than that no wallet signed.
    assert.equal(walletIn(seven.message)?.toBase58(), wallet.publicKey.toBase58());
  });

  it("refuses a message signed for another site's domain, which is what a lookalike gets signed", () => {
    const phished = signed("Lath agent", { action: "unlock", target: A }, undefined, {
      domain: "lath-console.example",
      uri: "https://lath-console.example",
    });
    assert.deepEqual(verify(phished, { action: "unlock", target: A }), {
      reason: `message was signed for lath-console.example, not for this console (${consoleOrigin.domain})`,
    });
    // A domain that is this console's host under another port is another site too.
    const port = signed("Lath agent", { action: "unlock", target: A }, undefined, {
      domain: `${consoleOrigin.domain.split(":")[0]}:9`,
      uri: `http://${consoleOrigin.domain.split(":")[0]}:9`,
    });
    assert.property(verify(port, { action: "unlock", target: A }), "reason");
  });

  it("refuses a message whose URI is not this console's, even under the right domain", () => {
    const uri = signed("Lath agent", { action: "unlock", target: A }, undefined, {
      domain: consoleOrigin.domain,
      uri: "https://lath-console.example",
    });
    assert.deepEqual(verify(uri, { action: "unlock", target: A }), {
      reason: "message was signed at https://lath-console.example, not at this console",
    });
    // With the origin pinned, the scheme counts: an http URI for an https console is another site.
    const scheme = signed("Lath agent", { action: "unlock", target: A }, undefined, {
      domain: consoleOrigin.domain,
      uri: consoleOrigin.uri.replace(/^http:/, "https:"),
    });
    assert.property(verify(scheme, { action: "unlock", target: A }), "reason");
  });

  it("checks the domain against the request's Host when no origin is pinned, and refuses with neither", () => {
    const auth = signed("Lath agent", { action: "unlock", target: A });
    const bound = { action: "unlock", target: A };
    // The same text, judged against a request from another host: refused. Against its own: fine.
    assert.deepEqual(verifyAuth(auth, wallet.publicKey, "Lath agent", bound, { domain: "evil.example", uri: null }), {
      reason: `message was signed for ${consoleOrigin.domain}, not for this console (evil.example)`,
    });
    assert.deepEqual(verifyAuth(auth, wallet.publicKey, "Lath agent", bound, null), {
      reason: "this console does not know its own origin; set LATH_CONSOLE_ORIGIN",
    });
    // A Host-only origin checks the URI by its host, since the scheme in front of the proxy is unknown.
    assert.deepEqual(
      verifyAuth(auth, wallet.publicKey, "Lath agent", bound, { domain: consoleOrigin.domain, uri: null }),
      {
        wallet: wallet.publicKey,
      }
    );
  });

  it("refuses a loop start posted with a body other than the one its signature hashes", () => {
    const agent = A;
    const start = { action: "start", agentId: agent, prompt: "watch the slot", budgetMicroUsdc: "250000" };
    const auth = signed("Lath loop", loopAuthBinding(start));
    // The harvested-signature start: the same signature, the attacker's instruction and budget.
    const swapped = { ...start, prompt: "drain the vault", budgetMicroUsdc: "25000000", auth };
    assert.deepEqual(verifyAuth(auth, wallet.publicKey, "Lath loop", loopAuthBinding(swapped)), {
      reason: "message was signed for a different request body",
    });
    // A start whose message binds no body at all is refused the same way: the route always derives one.
    const unbound = signed("Lath loop", { action: "start", target: agent });
    const postedUnbound = { ...start, auth: unbound };
    assert.deepEqual(verifyAuth(unbound, wallet.publicKey, "Lath loop", loopAuthBinding(postedUnbound)), {
      reason: "message was signed for a different request body",
    });
    // And the body it was signed for, with the `auth` attached as the route sees it, is accepted.
    const posted = { ...start, auth };
    assert.deepEqual(verifyAuth(auth, wallet.publicKey, "Lath loop", loopAuthBinding(posted)), {
      wallet: wallet.publicKey,
    });
  });

  it("refuses a signature given for another action on the same agent", () => {
    const refused = verify(signed("Lath agent", { action: "archive", target: A }), { action: "unlock", target: A });
    assert.deepEqual(refused, { reason: "message was signed to archive, not to unlock" });
  });

  it("refuses a signature given for the same action on another agent", () => {
    const refused = verify(signed("Lath agent", { action: "unlock", target: A }), { action: "unlock", target: B });
    assert.deepEqual(refused, { reason: "message was signed for a different target" });
  });

  it("refuses a message with a duplicated line, even one whose first copy is right", () => {
    // `field` reads the first `Nonce:` (or `URI:`, or `Request ID:`) line; a second one is exactly
    // what a reader elsewhere might take instead. The byte-for-byte rebuild is what refuses it,
    // before the signature is checked.
    const good = authMessage("Lath agent", {
      action: "unlock",
      target: A,
      ...consoleOrigin,
      cluster: CLUSTER,
      wallet: wallet.publicKey.toBase58(),
      issued: new Date().toISOString(),
      nonce: hex(nacl.randomBytes(16)),
    });
    const lines = good.split("\n");
    const doubled = sign([...lines.slice(0, 5), "URI: https://lath-console.example", ...lines.slice(5)].join("\n"));
    assert.deepEqual(verify(doubled, { action: "unlock", target: A }), {
      reason: "message is not in the form this console signs",
    });
    const trailing = sign(good + "\nRequest ID: " + "00".repeat(32));
    assert.deepEqual(verify(trailing, { action: "unlock", target: A }), {
      reason: "message was signed for a different request body",
    });
    const secondStatement = sign([...lines.slice(0, 4), `Lath agent: archive ${B}`, ...lines.slice(4)].join("\n"));
    assert.deepEqual(verify(secondStatement, { action: "unlock", target: A }), {
      reason: "message is not in the form this console signs",
    });
  });

  it("refuses a message issued before this server started, which a restart would otherwise re-open", () => {
    // A restart is simulated by moving the boot slot `bootAt()` reads: the nonces a previous
    // process accepted are gone, so anything it could have accepted is refused rather than trusted.
    const slot = Symbol.for("lath.bootAt");
    const g = globalThis as any;
    const real = bootAt();
    const issued = new Date(Date.now() - 2_000).toISOString();
    g[slot] = Date.now() - 1_000;
    try {
      assert.deepEqual(
        verify(signed("Lath agent", { action: "unlock", target: A }, issued), { action: "unlock", target: A }),
        {
          reason: "signed before this server restarted; sign again",
        }
      );
    } finally {
      g[slot] = real;
    }
  });

  it("accepts the exact pair once, and refuses the same nonce a second time", () => {
    const auth = signed("Lath agent", { action: "unlock", target: A });
    assert.deepEqual(verify(auth, { action: "unlock", target: A }), { wallet: wallet.publicKey });
    assert.deepEqual(verify(auth, { action: "unlock", target: A }), { reason: "nonce already used" });
  });
});

/**
 * Who the server spends on (`_lib/runner.ts`, `sessionSpend`).
 *
 * The gap this closes is the reason the message above is not enough on its own: it proves control
 * of an Ed25519 key, and an Ed25519 key costs nothing to mint. Read as permission to spend, that
 * proof would let a stranger sign five lines and get real inference on a chain the operator's SOL
 * pays to write, under a rate-limit bucket that is fresh every request because the wallet in its
 * key is. The deployment holds no model API key: what a billed session spends is the treasury's
 * USDC.e on Tempo, which is the same money in a different currency.
 *
 * So the cases below are about money, not about signatures, and they belong here because this is
 * the file that says what a signature is worth.
 */
describe("what a signed session may spend", () => {
  const at = { authority: "8".repeat(43), agentId: "aa".repeat(32), treasury: true };

  it("refuses to pay for a signed wallet with no allowance", () => {
    // The finding, as a case: a self-signed keypair with nothing on chain behind it. `verifyAuth`
    // accepts that signature, which is precisely why it cannot be the last word.
    const spend = sessionSpend({ signed: true, billingState: "unfunded", ownsTarget: false, ...at });
    assert.property(spend, "refuse", "a wallet with no allowance must not reach the operator's money");
    assert.notProperty(spend, "model");
    const refusal = (spend as { refuse: string }).refuse;
    // Refusing is half of it. The app states its rules on screen, so the refusal carries both
    // ways out: grant an allowance, or send the session unsigned and get the scripted transport.
    assert.include(refusal, at.authority, "the refusal names the key an allowance would be granted to");
    assert.match(refusal, /allowance/i);
    assert.match(refusal, /without a wallet signature/i);
    // And it does not offer a key this server does not hold: what it will not spend is money,
    // not model credits.
    assert.notMatch(refusal, /model key/i);
  });

  it("pays for a session only on a live allowance", () => {
    assert.deepEqual(sessionSpend({ signed: true, billingState: "charged", ownsTarget: false, ...at }), {
      model: "openrouter",
    });
    assert.deepEqual(sessionSpend({ signed: true, billingState: "charged", ownsTarget: true, ...at }), {
      model: "openrouter",
    });
  });

  it("leaves the anonymous session exactly as it was: a real chain, scripted, unbilled", () => {
    for (const billingState of ["no-wallet", "unfunded"] as const) {
      assert.deepEqual(sessionSpend({ signed: false, billingState, ownsTarget: false, ...at }), {
        model: "scripted",
        note: "anonymous: scripted inference, unbilled",
      });
    }
  });

  it("runs an owner's own agent unbilled rather than refusing it, and says so", () => {
    // The allowance is a second transaction on the API deploy path and may not have landed yet
    // Cutting an owner off from their own chain would be the wrong half to cut, so they
    // get what a loop step on the same agent gets: the scripted transport, and a note saying why.
    const spend = sessionSpend({ signed: true, billingState: "unfunded", ownsTarget: true, ...at }) as {
      model: string;
      note: string;
    };
    assert.equal(spend.model, "scripted");
    assert.include(spend.note, at.authority);
    assert.include(spend.note, "unbilled");
  });

  it("does not ask a deployment with no treasury for an allowance nobody can grant", () => {
    // No `NEXT_PUBLIC_TREASURY_ADMIN` means no escrow, no allowance and no way to be paid:
    // refusing every signed session there would be an instruction the caller cannot follow.
    const spend = sessionSpend({
      signed: true,
      billingState: "no-wallet",
      ownsTarget: false,
      ...at,
      treasury: false,
    }) as { model: string; note: string };
    assert.equal(spend.model, "scripted");
    assert.include(spend.note, "no treasury");
  });
});

/**
 * The state `verifyAuth` and `rateLimit` keep, and how many copies of it one server has.
 *
 * Next compiles each route into its own module graph, so a module-level `Map` in `runner.ts` is
 * one map per route bundle — the reason the run slot, the Tempo pool, the tickets, the nonce map
 * and the rate-limit map live on `globalThis`. Module-level, the server-wide `prepareCeiling` would
 * be a ceiling per route, the `loop starts` and `clones` buckets two routes share would be two
 * buckets, and a nonce one route had accepted would be fresh to the next.
 *
 * What a route bundle is, reproduced here: `runner.ts` evaluated twice, by dropping it from the
 * require cache between two loads. The cache entry is put back afterwards, so no later suite gets
 * the second copy.
 */
describe("the auth and rate-limit state, one per process", () => {
  const RUNNER = require.resolve("../frontend/src/app/api/_lib/runner");

  /** Two evaluations of `runner.ts`, as two route bundles would hold them. */
  function twoBundles(): { a: any; b: any } {
    const a = require(RUNNER);
    const first = require.cache[RUNNER];
    delete require.cache[RUNNER];
    const b = require(RUNNER);
    require.cache[RUNNER] = first;
    assert.notStrictEqual(a, b, "two module instances, which is the whole premise");
    return { a, b };
  }

  it("counts one bucket across both evaluations", () => {
    const { a, b } = twoBundles();
    const key = `f-l37:${hex(nacl.randomBytes(8))}`;
    assert.isNull(a.rateLimit("probes", key, 1), "the first call in the hour is allowed");
    assert.isString(b.rateLimit("probes", key, 1), "and the second is refused, whichever bundle it reached");
  });

  it("refuses a nonce in one evaluation that the other has already accepted", () => {
    const { a, b } = twoBundles();
    const wallet = Keypair.generate();
    const bound = { action: "stop", target: "loop-f-l37" };
    const message = authMessage("Lath loop", {
      ...bound,
      ...consoleOrigin,
      cluster: a.CLUSTER,
      wallet: wallet.publicKey.toBase58(),
      issued: new Date().toISOString(),
      nonce: hex(nacl.randomBytes(16)),
    });
    const auth = {
      message,
      signature: Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), wallet.secretKey)).toString("base64"),
    };
    assert.property(
      a.verifyAuth(auth, wallet.publicKey, "Lath loop", bound),
      "wallet",
      "a real signature is accepted once"
    );
    assert.deepEqual(b.verifyAuth(auth, wallet.publicKey, "Lath loop", bound), { reason: "nonce already used" });
  });

  it("has one boot time, fixed when the first evaluation loaded", () => {
    const { a, b } = twoBundles();
    assert.equal(a.bootAt(), b.bootAt());
    assert.isAtMost(a.bootAt(), Date.now());
  });
});
