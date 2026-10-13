/**
 * The Allowance card's grant decision (`frontend/src/lib/allowance-grant.ts`). No validator, no
 * wallet, no React: the card builds `approve_agent` from what this returns,
 * and `approve_agent` writes the hash verbatim and `spent = 0`, so a zeroed hash sent over a live
 * grant resets its meter and breaks the genesis/allowance pairing. Zeros may go only on a read that
 * answered "no account".
 */
import { assert } from "chai";
import { grantPolicyHash, readAllowance } from "../frontend/src/lib/allowance-grant";

const H = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const live = { policyVersionHash: H, cap: 25_000_000n, spent: 7_000_000n };

describe("allowance grant decision", () => {
  it("a pending read is reading, and yields no hash to send", () => {
    const read = readAllowance<typeof live>({ status: "pending", data: undefined });
    assert.deepEqual(read, { kind: "reading" });
    assert.isNull(grantPolicyHash(read));
  });

  it("a failed read is unreadable, even with an older success's data left behind", () => {
    for (const data of [undefined, null, live]) {
      const read = readAllowance({ status: "error", data });
      assert.deepEqual(read, { kind: "unreadable" });
      assert.isNull(grantPolicyHash(read));
    }
  });

  it("a success without an answer is not an allowance of none", () => {
    const read = readAllowance<typeof live>({ status: "success", data: undefined });
    assert.equal(read.kind, "reading");
    assert.isNull(grantPolicyHash(read));
  });

  it("only a read that answered no account sends zeros", () => {
    const read = readAllowance<typeof live>({ status: "success", data: null });
    assert.equal(read.kind, "none");
    const hash = grantPolicyHash(read)!;
    assert.equal(hash.length, 32);
    assert.isTrue(hash.every((b) => b === 0));
  });

  it("a re-grant carries the live grant's own hash, never zeros", () => {
    const read = readAllowance({ status: "success", data: live });
    assert.equal(read.kind, "granted");
    assert.deepEqual(Array.from(grantPolicyHash(read)!), Array.from(H));
  });

  it("a malformed on-chain hash is refused rather than padded", () => {
    const read = readAllowance({ status: "success", data: { ...live, policyVersionHash: new Uint8Array(31) } });
    assert.isNull(grantPolicyHash(read));
  });
});
