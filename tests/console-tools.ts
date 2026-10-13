import "./fixtures/trace-dir";
import { assert } from "chai";
import {
  CHAIN_TOOL_NAMES,
  LEGACY_TOOL_NAMES,
  OFFERED_TOOL_NAMES,
  RETIRED_TOOL_NAMES,
  TOOL_NAMES,
  scriptedTurns,
} from "../frontend/src/app/api/_lib/tools";
import { get, isPrivateAddress } from "../frontend/src/app/api/_lib/web-tools";

/**
 * The scripted walk a run takes when there is no model key.
 *
 * It is two turns, with no `lath.verify_chain`: that tool reads the anchor queue, and a scripted
 * session replaying its own chain mid-write reports the seqs its own genesis is waiting on, which
 * reads as a broken chain rather than as a queue doing its work.
 *
 * `/api/run` and the loop scheduler share one builder for this and for the transport under it.
 * The risk in sharing it is not a type error — it is the prose. `console.spec.ts` asserts a session's *numbers*, so the
 * closing sentence could change to the loop's and every check would stay green while the console
 * told the user its session had "stepped on schedule".
 *
 * So the sentences are asserted here, as literals, for both callers.
 */
const SESSION_SENTENCE = "Read the slot and fee level; every step above is anchored.";
const STEP_SENTENCE = "Stepped on schedule and read the cluster. This step is one epoch and one checkpoint.";

describe("the scripted transcript", () => {
  it("reads the cluster and then says what it did, and never calls verify_chain", () => {
    assert.deepEqual(scriptedTurns(CHAIN_TOOL_NAMES, "aa", SESSION_SENTENCE), [
      {
        calls: [
          { name: "solana.slot", args: {} },
          { name: "solana.fees", args: {} },
        ],
      },
      { text: SESSION_SENTENCE },
    ]);
  });

  it("ends a loop step in the loop's sentence, which is not the session's", () => {
    const turns = scriptedTurns(CHAIN_TOOL_NAMES, "bb", STEP_SENTENCE);
    assert.deepEqual(turns[turns.length - 1], { text: STEP_SENTENCE });
    assert.notEqual(STEP_SENTENCE, SESSION_SENTENCE, "two callers, two sentences; neither is the other's");
  });

  it("calls only the tools the policy allows, and always closes with the sentence", () => {
    // A scripted turn naming a tool the runtime refuses is a 404 the transcript wrote for itself.
    assert.deepEqual(scriptedTurns(["solana.slot"], "cc", "done"), [
      { calls: [{ name: "solana.slot", args: {} }] },
      { text: "done" },
    ]);
    // A policy that allows only the chain replay is now one turn: the tool is still the agent's,
    // and the scripted walk simply does not call it.
    assert.deepEqual(scriptedTurns(["lath.verify_chain"], "cc", "done"), [{ text: "done" }]);
    // No chain tools at all — a web-only policy — is one turn: the sentence.
    assert.deepEqual(scriptedTurns([], "cc", "done"), [{ text: "done" }]);
  });
});

/**
 * What a policy is offered, against what it is allowed to name.
 *
 * Two lists on purpose. `TOOL_NAMES` keeps the retired `hire` and the alias
 * `lattice.verify_chain` because stored policies commit to them through `policy_version_hash`;
 * `OFFERED_TOOL_NAMES` is what a refusal lists as shipped, and neither of those may appear there —
 * `hire` is a word nothing says on screen, and the alias is not a tool anyone should pick.
 */
describe("the tool names a refusal offers", () => {
  it("offers a subset of what is accepted, with no retired name or alias in it", () => {
    for (const name of OFFERED_TOOL_NAMES) assert.include(TOOL_NAMES, name);
    for (const name of [...RETIRED_TOOL_NAMES, ...LEGACY_TOOL_NAMES]) {
      assert.notInclude(OFFERED_TOOL_NAMES, name);
      assert.include(TOOL_NAMES, name, `${name} is still accepted`);
    }
    // Everything else that is accepted is offered: the two lists differ by exactly those names.
    assert.sameMembers(
      [...OFFERED_TOOL_NAMES, ...RETIRED_TOOL_NAMES, ...LEGACY_TOOL_NAMES],
      TOOL_NAMES,
      "a tool that is accepted and not offered is a retired or legacy name, and nothing else"
    );
  });
});

/**
 * The one socket in this runtime whose destination a model picks (`_lib/web-tools.ts`).
 *
 * Nothing here reaches the network: every case is a URL the guard must refuse *before* it
 * connects, which is the only half of the tool a test without a network can pin. The other half —
 * that the connection goes to the address the guard vetted rather than to whatever DNS answers
 * the second time — is a `lookup` pinned on the request itself, because that is not assertable
 * from outside without a DNS server to lie with.
 */
describe("the web tools' host guard", () => {
  it("knows which addresses are not the open web", () => {
    for (const addr of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.1", "100.64.0.1"]) {
      assert.isTrue(isPrivateAddress(addr), `${addr} is not public`);
    }
    // The metadata service in the shape that reads as public until it is parsed.
    assert.isTrue(isPrivateAddress("::ffff:169.254.169.254"));
    assert.isTrue(isPrivateAddress("fd00::1"));
    assert.isTrue(isPrivateAddress("not-an-address"));
    for (const addr of ["1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
      assert.isFalse(isPrivateAddress(addr), `${addr} is public`);
    }
  });

  it("refuses everything that is not a public http(s) URL, without opening a socket", async () => {
    const refused = [
      ["file:///etc/passwd", /http\(s\)/],
      ["ftp://example.com/x", /http\(s\)/],
      ["not a url", /not a URL/],
      // Credentials in a URL are how a guard gets talked past by a host that is not the host.
      ["https://user:pass@example.com/", /credentials/],
      ["http://localhost:3000/", /not a public host/],
      ["http://127.0.0.1:3000/", /not a public host/],
      ["http://[::1]/", /not a public host/],
      // The cloud metadata service, by address and by the name that resolves nowhere public.
      ["http://169.254.169.254/latest/meta-data/", /not a public host/],
      ["http://something.internal/", /not a public host/],
    ] as const;
    for (const [url, message] of refused) {
      let thrown: Error | null = null;
      try {
        await get(url);
      } catch (e) {
        thrown = e as Error;
      }
      assert.isNotNull(thrown, `${url} was not refused`);
      assert.match(thrown!.message, message, url);
    }
  });
});
