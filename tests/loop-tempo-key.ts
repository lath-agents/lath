/**
 * The loop page's line for its Tempo access key (docs/ARCHITECTURE.md §7.3),
 * node-only: `lib/tempo-key.ts` turns a fixture key into the words the terms card draws — the
 * limit and the remaining in USDC.e to six decimals, _not readable_ when Tempo did not answer,
 * revoked and expired, and the limit's sentence with the loop's own Jev share rather than a hard-coded 15
 * — and names the three stops a key can cause.
 */
import { assert } from "chai";
import {
  NOT_READABLE,
  jevSharePercent,
  shortTempoAddress,
  tempoKeyCoversText,
  tempoKeyDate,
  tempoKeyLine,
  tempoKeyScopesText,
  tempoKeyStopText,
  usdcEOfBase,
} from "../frontend/src/lib/tempo-key";
import type { LoopTempoKeyView } from "../frontend/src/types/loop";

const ADDRESS = "0x1234567890abcdef1234567890abcdef1234abcd";
const TOKEN = "0x20c000000000000000000000b9537d11c60e8b50";
const AUTHORIZE = `0x${"ab".repeat(32)}`;
// 2026-11-02 14:05:00 UTC.
const EXPIRY = Date.UTC(2026, 10, 2, 14, 5) / 1000;
const BEFORE = EXPIRY - 86_400;
const AFTER = EXPIRY + 1;

function key(over: Partial<LoopTempoKeyView> = {}): LoopTempoKeyView {
  return {
    address: ADDRESS,
    token: TOKEN,
    limitBase: "1150000",
    expiry: EXPIRY,
    authorizeTx: AUTHORIZE,
    remaining: "420000",
    isRevoked: false,
    ...over,
  };
}

// A $1 budget with the default 15 % share, as `loopBudgetKeys` freezes it.
const LOOP = { budgetMicroUsdc: "1000000", jevBudgetBase: "150000" };

describe("loop tempo key: the terms card's line", () => {
  it("formats the limit and the remaining in USDC.e to six decimals, exactly", () => {
    const line = tempoKeyLine(key(), LOOP, BEFORE);
    assert.equal(line.limit, "1.150000 USDC.e");
    assert.equal(line.remaining, "0.420000 USDC.e");
    assert.isTrue(line.remainingReadable);
    assert.equal(usdcEOfBase("0"), "0.000000 USDC.e");
    assert.equal(usdcEOfBase("123456789012345678901"), "123456789012345.678901 USDC.e");
    assert.isNull(usdcEOfBase("1.5"));
    assert.isNull(usdcEOfBase(null));
  });

  it("shortens the key to 0x1234…abcd and keeps the whole address beside it", () => {
    const line = tempoKeyLine(key(), LOOP, BEFORE);
    assert.equal(line.short, "0x1234…abcd");
    assert.equal(line.address, ADDRESS);
    assert.equal(shortTempoAddress("0xabc"), "0xabc");
  });

  it("says the whole line in one sentence, with the expiry in UTC", () => {
    const line = tempoKeyLine(key(), LOOP, BEFORE);
    assert.equal(line.state, "active");
    assert.equal(tempoKeyDate(EXPIRY), "2026-11-02 14:05 UTC");
    assert.equal(
      line.text,
      "Tempo-enforced cap: key 0x1234…abcd, limit 1.150000 USDC.e, remaining 0.420000 USDC.e, " +
        "expires 2026-11-02 14:05 UTC. The limit covers the loop's budget plus at most 15 % for its decisions, which Lath pays."
    );
    assert.equal(line.authorizeTx, AUTHORIZE);
  });

  it("says not readable, never 0, when Tempo did not answer", () => {
    const line = tempoKeyLine(key({ remaining: null, isRevoked: null }), LOOP, BEFORE);
    assert.equal(line.remaining, NOT_READABLE);
    assert.isFalse(line.remainingReadable);
    assert.equal(line.state, "unknown");
    assert.include(line.text, "remaining not readable");
    assert.include(line.stateText, "revocation not readable");
    // The committed terms still read: they are the row's, not Tempo's answer.
    assert.equal(line.limit, "1.150000 USDC.e");
  });

  it("reads revoked over everything else, expired past the committed expiry", () => {
    const revoked = tempoKeyLine(key({ isRevoked: true }), LOOP, AFTER);
    assert.equal(revoked.state, "revoked");
    assert.equal(revoked.stateText, "revoked");
    assert.include(revoked.text, ", revoked.");
    const expired = tempoKeyLine(key(), LOOP, AFTER);
    assert.equal(expired.state, "expired");
    assert.equal(expired.stateText, "expired 2026-11-02 14:05 UTC");
    // Expiry is the reader's clock against the committed terms, so it reads with Tempo silent too.
    assert.equal(tempoKeyLine(key({ remaining: null, isRevoked: null }), LOOP, AFTER).state, "expired");
    assert.equal(tempoKeyLine(key(), LOOP, EXPIRY).state, "expired");
  });

  it("drops the authorize link when the row has no transaction", () => {
    assert.isNull(tempoKeyLine(key({ authorizeTx: undefined }), LOOP, BEFORE).authorizeTx);
  });
});

describe("loop tempo key: what the limit covers", () => {
  it("reads the loop's own frozen Jev share, not a hard-coded 15", () => {
    assert.equal(jevSharePercent(LOOP), "15");
    assert.equal(jevSharePercent({ budgetMicroUsdc: "2000000", jevBudgetBase: "200000" }), "10");
    assert.equal(jevSharePercent({ budgetMicroUsdc: "1000000", jevBudgetBase: "125000" }), "12.5");
    // The console floors `budget × pct / 100`, so the ratio comes back a hair under; it still reads 15.
    assert.equal(jevSharePercent({ budgetMicroUsdc: "333333", jevBudgetBase: "49999" }), "15");
    assert.equal(
      tempoKeyCoversText({ budgetMicroUsdc: "2000000", jevBudgetBase: "200000" }),
      "the loop's budget plus at most 10 % for its decisions, which Lath pays"
    );
    assert.equal(
      tempoKeyCoversText({ budgetMicroUsdc: "1000000", jevBudgetBase: "0" }),
      "the loop's budget plus at most 0 % for its decisions, which Lath pays"
    );
  });

  it("names the share without a number when there is no ratio to read", () => {
    assert.isNull(jevSharePercent({ budgetMicroUsdc: "0", jevBudgetBase: "0" }));
    assert.isNull(jevSharePercent({}));
    assert.equal(tempoKeyCoversText({}), "the loop's budget plus its share for decisions, which Lath pays");
  });
});

describe("loop tempo key: the stops a key causes", () => {
  it("has a sentence for each of the four key stop reasons and none for any other", () => {
    for (const reason of ["tempo-key-limit", "tempo-key-expired", "tempo-key-missing", "tempo-key-refused"]) {
      const text = tempoKeyStopText(reason);
      assert.isString(text, reason);
      assert.match(text!, /key/);
    }
    assert.include(tempoKeyStopText("tempo-key-limit")!, "limit");
    assert.include(tempoKeyStopText("tempo-key-expired")!, "expired");
    assert.isUndefined(tempoKeyStopText("budget"));
    assert.isUndefined(tempoKeyStopText(null));
  });
});

describe("loop tempo key: the call scopes", () => {
  const payee = "0xCa4E835F00000000000000000000000000079fE";
  const scopes = [
    { address: "0x20c000000000000000000000b9537d11c60e8b50", selector: "0x95777d59", recipients: [payee] },
    { address: "0x4d50500000000000000000000000000000000000", selector: "0xdc48471e" },
    { address: "0x4d50500000000000000000000000000000000000", selector: "0xedc53b00" },
  ];
  it("names the escrow calls and the storage payee, and says nothing for an unscoped key", () => {
    assert.equal(
      tempoKeyScopesText(scopes),
      "can call only USDC.e (transferWithMemo to 0xca4e…79fe) and the channel escrow (top-up, open)"
    );
    assert.isNull(tempoKeyScopesText(undefined));
    assert.equal(tempoKeyScopesText([]), "can call nothing");
  });
  it("shows an unknown target or selector raw rather than hiding it", () => {
    assert.equal(
      tempoKeyScopesText([{ address: "0x1111111111111111111111111111111111111111", selector: "0xabcdef01" }]),
      "can call only 0x1111…1111 (0xabcdef01)"
    );
  });
});
