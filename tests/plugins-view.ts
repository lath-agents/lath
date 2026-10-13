/**
 * The screens' words for protocol plugins, node-only:
 * `lib/plugins-view.ts` turns the console's answer into what the form offers, and a loop's receipt into
 * its card (docs/ARCHITECTURE.md §8); `lib/plugin-catalog.ts` is what the picker lists.
 *
 * Pinned here: the base-unit conversion at six decimals, exact, never rounded; the console's answer read
 * at the top level or under `limits`; and the receipt's pointer, card and words.
 *
 * `squads.pay` and `sas.attest` are on the roadmap: their form fields, item builders and grant
 * sentences, the form's grant draft, the treasury preset, the loop page's plugins card and each
 * step's proposal rows are not in this build.
 */
import { assert } from "chai";
import { readFileSync } from "fs";
import { join } from "path";
import {
  PLUGIN_CATALOG,
  SAS_RECEIPT,
  presetPluginPicks,
  presetPluginsOn,
  receiptPicked,
} from "../frontend/src/lib/plugin-catalog";
import { SAS_RECEIPT_TOOL } from "../sdk/src/receipt";
import {
  RECEIPT_CHIPS,
  RECEIPT_SUMMARY,
  SAS_RECEIPT_SCHEMA_NAME,
  amountText,
  formatUnits,
  hashShort,
  pluginsConsoleOf,
  receiptOffered,
  receiptPointerOf,
  receiptStatusLine,
  receiptValueLines,
  type AttestDemo,
} from "../frontend/src/lib/plugins-view";
import type { LoopReceiptView } from "../frontend/src/types/loop";

describe("plugins-view: units", () => {
  it("converts base units to token units at 6 dp, exactly", () => {
    assert.equal(formatUnits("120000000", 6), "120");
    assert.equal(formatUnits("1500000", 6), "1.5");
    assert.equal(formatUnits("1", 6), "0.000001");
    assert.equal(formatUnits("0", 6), "0");
    assert.equal(formatUnits("1000000000", 6), "1000");
    assert.equal(formatUnits("123456789012345678901", 6), "123456789012345.678901");
    assert.isNull(formatUnits("-1", 6));
    assert.isNull(formatUnits("1.5", 6));
    assert.isNull(formatUnits("120", null));
  });

  it("names an amount, and says so when it cannot", () => {
    assert.equal(amountText("200000000", 6, "dUSDC"), "200 dUSDC");
    assert.equal(amountText("200000000", null, "dUSDC"), "200000000 base units");
    assert.equal(amountText(null, 6, "dUSDC"), "not readable");
  });
});

describe("plugins-view: the form", () => {
  it("reads the console's answer at the top level or under limits, and off when malformed", () => {
    assert.deepEqual(pluginsConsoleOf({ protocolPlugins: "on" }), { protocolPlugins: "on" });
    assert.equal(pluginsConsoleOf({ limits: { protocolPlugins: "on" } }).protocolPlugins, "on");
    assert.deepEqual(pluginsConsoleOf({ limits: {} }), { protocolPlugins: "off" });
    assert.deepEqual(pluginsConsoleOf(null), { protocolPlugins: "off" });
    // An older console may still send the Squads demo treasury beside the switch;
    // nothing in this build names an older loop's Squads rows by it, so it is not read.
    const treasury = { multisig: CREDENTIAL, vaultIndex: 1, vault: SCHEMA, mint: ISSUER, decimals: 6, payees: [] };
    assert.deepEqual(pluginsConsoleOf({ protocolPlugins: "on", pluginsDemo: treasury }), { protocolPlugins: "on" });
  });
});

describe("plugin-catalog: what the form's picker offers", () => {
  it("lists SAS · receipt alone: not a grant, and nothing greyed as coming soon", () => {
    // SAS · receipt is the form's one plugin; SAS · attest and Squads · pay are on the roadmap and
    // get no _soon_ chip.
    assert.deepEqual(
      PLUGIN_CATALOG.map((p) => p.id),
      [SAS_RECEIPT]
    );
    const [receipt] = PLUGIN_CATALOG;
    assert.equal(SAS_RECEIPT, SAS_RECEIPT_TOOL, "the catalog's id is the SDK's tool id");
    assert.match(receipt.id, /^[a-z]+\.[a-z]+$/, "an id is <plugin>.<action>, the tool id");
    assert.equal(receipt.kind, "receipt", "the receipt is not a grant item");
    assert.equal(receipt.label, "SAS · receipt");
    assert.match(receipt.blurb, /Solana Attestation Service/);
    assert.notMatch(receipt.blurb, /prove|deterministic/i);
    // The picker draws every entry as a chip the owner can press, and none greyed.
    const field = readFileSync(join(__dirname, "../frontend/src/components/PluginsField.tsx"), "utf8");
    assert.notInclude(field, "<Badge>soon</Badge>");
  });

  it("the receipt is picked as the receipt, and no other id is", () => {
    assert.isTrue(receiptPicked([SAS_RECEIPT]));
    assert.isTrue(receiptPicked(["nope.nothing", SAS_RECEIPT]));
    assert.isFalse(receiptPicked([]));
    assert.isFalse(receiptPicked(["sas.attest"]));
  });
});

// ---------------------------------------------------------------------------------------------
// The SAS demo the receipt is published under

// Shapes only: base58 of the right length, not keys anyone holds.
const CREDENTIAL = "BewvqsfAQk3Kzh7Q3FCrBWyh1SCTfRZGXrJYAWyN3GvT";
const SCHEMA = "4hTjaY3FfLwjT5aNBbcyEejDMdc5fZYx4kGDHPz7jY6V";
const ISSUER = "B6EmpbCPoRdpCqzUVWk1u5LTxqfSRwgqi4CTzAMDEmo3";
const TARGET = "3UViFkVCxgfiGprWkvBkqTodoorLPh2fqw9nZHaasHqd";
const ATTEST: AttestDemo = {
  issuer: ISSUER,
  credential: CREDENTIAL,
  schema: SCHEMA,
  subjects: [
    { name: "target", address: TARGET },
    { name: "squads", address: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" },
  ],
};

describe("plugins-view: the SAS demo in the console's answer", () => {
  it("reads attestDemo only on a console with the switch on", () => {
    // An answer without it reads with no attestDemo key at all.
    assert.notProperty(pluginsConsoleOf({ protocolPlugins: "on" }), "attestDemo");
    assert.deepEqual(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: ATTEST }), {
      protocolPlugins: "on",
      attestDemo: ATTEST,
    });
    // Nested under limits.
    assert.deepEqual(pluginsConsoleOf({ limits: { protocolPlugins: "on", attestDemo: ATTEST } }).attestDemo, ATTEST);
    // Off, null and malformed are no demo.
    assert.notProperty(pluginsConsoleOf({ protocolPlugins: "off", attestDemo: ATTEST }), "attestDemo");
    assert.notProperty(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: null }), "attestDemo");
    for (const bad of [
      { ...ATTEST, credential: 7 },
      { ...ATTEST, subjects: "target" },
      { ...ATTEST, subjects: [{ name: "target" }] },
      { ...ATTEST, issuer: "" },
    ]) {
      assert.notProperty(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: bad }), "attestDemo");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// sas.receipt

describe("sas.receipt: the form's pointer and the loop page's card", () => {
  // Shapes only, as above.
  const RECEIPT_SCHEMA = "8yZm2Dbnh9cNPCJAgq3pTz6cRb8w2iWbmDDQ8RkPN7Fq";
  const SIGNER = "4rXxAyY2BveGG5ojDkWqWm7r6Dtr4NFwDz1cmJsqNz1H";
  const WITH_RECEIPT: AttestDemo = { ...ATTEST, receipt: { schema: RECEIPT_SCHEMA, signer: SIGNER } };
  const HEAD = "ab".repeat(16) + "cd".repeat(15) + "1234";
  const GOAL = "9f".repeat(30) + "beef";

  it("reads attestDemo.receipt only whole, nested or flat, and drops it alone", () => {
    const on = (attestDemo: unknown) => pluginsConsoleOf({ protocolPlugins: "on", attestDemo }).attestDemo;
    assert.deepEqual(on(WITH_RECEIPT), WITH_RECEIPT);
    assert.deepEqual(on({ ...ATTEST, receiptSchema: RECEIPT_SCHEMA, receiptSigner: SIGNER }), WITH_RECEIPT);
    // Half a pointer, or one that is not addresses, is no pointer; the attestation demo still stands.
    for (const receipt of [{ schema: RECEIPT_SCHEMA }, { signer: SIGNER }, { schema: "x", signer: SIGNER }, "yes"]) {
      const read = on({ ...ATTEST, receipt });
      assert.deepEqual(read, ATTEST);
      assert.notProperty(read, "receipt");
    }
  });

  it("the start body's pointer is the console's own, or none", () => {
    assert.deepEqual(receiptPointerOf(WITH_RECEIPT), {
      credential: ATTEST.credential,
      schema: RECEIPT_SCHEMA,
      signer: SIGNER,
    });
    assert.isNull(receiptPointerOf(ATTEST), "a console with no receipt schema has no pointer to send");
    assert.isNull(receiptPointerOf(null));
    assert.isNull(receiptPointerOf(undefined));
  });

  // A preset that asked for a receipt everywhere would make a console with plugins off show an amber
  // `loop-receipt-off` line and one with no schema a red refusal with Start held.
  it("is offered only with plugins on and a whole pointer", () => {
    assert.isTrue(receiptOffered(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: WITH_RECEIPT })));
    assert.isTrue(
      receiptOffered(pluginsConsoleOf({ limits: { protocolPlugins: "on", attestDemo: WITH_RECEIPT } })),
      "read under limits as well"
    );
    assert.isFalse(receiptOffered(pluginsConsoleOf({ protocolPlugins: "off", attestDemo: WITH_RECEIPT })));
    assert.isFalse(receiptOffered(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: ATTEST })), "no schema");
    assert.isFalse(receiptOffered(pluginsConsoleOf({ protocolPlugins: "on", attestDemo: null })));
    assert.isFalse(receiptOffered(pluginsConsoleOf({})), "a console from before plugins");
    assert.isFalse(receiptOffered(null), "the answer not in yet");
    assert.isFalse(receiptOffered(undefined));
  });

  it("the goal preset picks it, and opens the section on, only where it is offered", () => {
    const watch = { receipt: true };
    // Offered: on, the receipt picked.
    assert.deepEqual(presetPluginPicks(watch, { receipt: true }), [SAS_RECEIPT]);
    assert.isTrue(presetPluginsOn(watch, { receipt: true }));
    // Not offered (plugins off, or no schema): off, nothing picked, so nothing is sent and no line says a
    // receipt was meant. The form builds `receipt` only from an on section with the receipt picked.
    assert.deepEqual(presetPluginPicks(watch, { receipt: false }), []);
    assert.isFalse(presetPluginsOn(watch, { receipt: false }));
    assert.isFalse(receiptPicked(presetPluginPicks(watch, { receipt: false })));
    assert.isFalse(presetPluginsOn(null, { receipt: true }));
    assert.isFalse(presetPluginsOn({}, { receipt: true }));
    // The form draws no amber line, and the receipt is picked from the console's answer.
    const form = readFileSync(join(__dirname, "../frontend/src/components/LoopStartForm.tsx"), "utf8");
    assert.notInclude(form, 'data-testid="loop-receipt-off"');
    assert.include(form, "receiptOffered(pluginsConsole.data)");
    // The preset the demo opens carries the receipt, and no preset carries a grant (`squads.pay`,
    // which a `treasury` preset would need, is on the roadmap).
    const presetSrc = readFileSync(join(__dirname, "../frontend/src/lib/loop-presets.ts"), "utf8");
    const auditSrc = presetSrc.slice(presetSrc.indexOf('"protocol-audit": {'));
    assert.include(auditSrc, "receipt: true");
    assert.notInclude(auditSrc, "attest:");
    assert.notInclude(auditSrc, "plugins:");
    assert.notInclude(presetSrc, "  treasury: {");
  });

  it("says the owner's words on the form", () => {
    assert.equal(
      RECEIPT_SUMMARY,
      "When the decision model says the goal is reached, Lath publishes a receipt of this loop on Solana."
    );
    assert.deepEqual(RECEIPT_CHIPS, ["1 per loop", "on achieved", "Lath pays rent"]);
    assert.equal(SAS_RECEIPT_SCHEMA_NAME, "loop-receipt v1");
    // Never that the receipt proves the loop, and never that Jev's answer is deterministic. The ⓘ and the
    // card's copy are held to the same words, read from their sources.
    const field = readFileSync(join(__dirname, "../frontend/src/components/PluginsField.tsx"), "utf8");
    const card = readFileSync(join(__dirname, "../frontend/src/components/LoopReceipt.tsx"), "utf8");
    const copy = field.slice(
      field.indexOf("const RECEIPT_COPY"),
      field.indexOf(";", field.indexOf("const RECEIPT_COPY"))
    );
    for (const text of [RECEIPT_SUMMARY, ...RECEIPT_CHIPS, copy]) assert.notMatch(text, /prove|deterministic/i);
    assert.notMatch(card.replace(/\/\*[\s\S]*?\*\//g, ""), /proves|deterministic/i);
    assert.include(card, "lath-audit verify-receipt");
    assert.include(field, "This console has no receipt schema.");
  });

  it("the card's status: waiting is neutral, published good, failed bad and says why, none says why there is none", () => {
    const view = (status: LoopReceiptView["status"], error?: string) => receiptStatusLine({ status, error });
    assert.deepEqual(view("waiting"), { tone: "neutral", badge: "Waiting for achieved", text: null });
    assert.deepEqual(view("published"), { tone: "good", badge: "published", text: null });
    assert.deepEqual(view("failed", "the runtime key has no SOL"), {
      tone: "bad",
      badge: "failed",
      text: "The publish did not land: the runtime key has no SOL. The console retries on restart.",
    });
    assert.equal(view("failed").text, "The publish did not land. The console retries on restart.");
    assert.deepEqual(view("none"), {
      tone: "neutral",
      badge: "none",
      text: "No receipt: the loop stopped without the decision model's achieved.",
    });
  });

  it("the card's values: position, steps, goal, and both costs exact at six decimals", () => {
    assert.equal(hashShort(HEAD), "abab…1234");
    assert.equal(hashShort("abc"), "abc");
    assert.deepEqual(
      receiptValueLines({
        agent: "aa".repeat(32),
        loop: "loop-0123456789abcdef",
        seq: "42",
        head: HEAD,
        steps: 3,
        goal: GOAL,
        usdcCharged: "1250000",
        tempoSpent: "4000",
        tempoPayer: "0x" + "1f".repeat(20),
      }),
      {
        position: "seq 42 · head abab…1234",
        steps: "3",
        goal: "9f9f…beef",
        charged: "1.25 USDC",
        tempo: "0.004 USDC.e",
        payer: "0x" + "1f".repeat(20),
      }
    );
    const none = receiptValueLines({
      agent: "aa".repeat(32),
      loop: "loop-0123456789abcdef",
      seq: "0",
      head: HEAD,
      steps: 1,
      goal: GOAL,
      usdcCharged: "0",
      tempoSpent: "0",
      tempoPayer: "",
    });
    assert.equal(none.charged, "0 USDC");
    assert.equal(none.tempo, "0 USDC.e");
    assert.equal(none.payer, "", "no payer is said as none by the card");
  });
});
